/**
 * The on-device model is a couple of multi-gigabyte files. Transformers.js only writes a file to
 * the browser cache after the whole thing is in memory, so closing the page mid-download throws
 * that file away. This keeps each byte in the origin private file system as it arrives and, on
 * the next start, asks the server for only the missing range.
 */

export type ResumePlan = { action: "passthrough" } | { action: "restart"; total: number } | { action: "append"; total: number };

/** How to treat a download response when `have` bytes are already on disk. */
export function planResume(status: number, contentRange: string | null, contentLength: string | null, have: number): ResumePlan {
  if (status === 200) {
    const total = Number(contentLength);
    return Number.isFinite(total) && total > 0 ? { action: "restart", total } : { action: "passthrough" };
  }
  if (status === 206 && contentRange) {
    const match = /^bytes (\d+)-\d+\/(\d+)$/.exec(contentRange.trim());
    const start = Number(match?.[1]);
    const total = Number(match?.[2]);
    if (match && start === have && total > have) return { action: "append", total };
  }
  return { action: "passthrough" };
}

type Meta = { etag?: string; total?: number; complete: boolean };

const ROOT = "zireh-model";

async function digest(url: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function dir(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
}

async function readMeta(folder: FileSystemDirectoryHandle, name: string): Promise<Meta | undefined> {
  try {
    const handle = await folder.getFileHandle(`${name}.json`);
    return JSON.parse(await (await handle.getFile()).text()) as Meta;
  } catch {
    return undefined;
  }
}

async function writeMeta(folder: FileSystemDirectoryHandle, name: string, meta: Meta): Promise<void> {
  const handle = await folder.getFileHandle(`${name}.json`, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(meta));
  await writable.close();
}

/** Point the model loader at a cache that survives an interrupted download. No-op where private files aren't available. */
export async function installResumeCache(env: {
  useBrowserCache: boolean;
  useCustomCache: boolean;
  customCache: unknown;
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  cacheKey: string;
}): Promise<void> {
  if (!navigator.storage?.getDirectory) return;
  let folder: FileSystemDirectoryHandle;
  try {
    folder = await dir();
    await navigator.storage.persist?.();
  } catch {
    return;
  }

  const base = env.fetch.bind(env) as typeof fetch;
  const browserCache = env.cacheKey;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = {
    async match(request: string) {
      if (!request.startsWith("http")) return undefined;
      const name = await digest(request);
      const meta = await readMeta(folder, name);
      if (meta?.complete) {
        try {
          const file = await (await folder.getFileHandle(`${name}.bin`)).getFile();
          if (meta.total === undefined || file.size === meta.total) return new Response(file, { headers: { "content-length": String(file.size) } });
        } catch {
          /* fall through to the browser cache */
        }
      }
      try {
        const hit = await (await caches.open(browserCache)).match(request);
        return hit ?? undefined;
      } catch {
        return undefined;
      }
    },
    async put(request: string) {
      if (!request.startsWith("http")) return;
      const name = await digest(request);
      const meta = await readMeta(folder, name);
      if (meta?.complete) return;
      try {
        const size = (await (await folder.getFileHandle(`${name}.bin`)).getFile()).size;
        if (meta?.total === undefined || size === meta.total) await writeMeta(folder, name, { ...meta, complete: true, total: size });
      } catch {
        /* the stream writer owns the file; a missing one just downloads next time */
      }
    },
  };

  env.fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input.toString();
    if (!href.includes("huggingface.co") && !href.includes("hf.co")) return base(input, init);
    return fetchResumable(base, folder, href, init);
  };
}

async function fetchResumable(base: typeof fetch, folder: FileSystemDirectoryHandle, href: string, init?: RequestInit): Promise<Response> {
  const name = await digest(href);
  const bin = await folder.getFileHandle(`${name}.bin`, { create: true });
  const meta = (await readMeta(folder, name)) ?? { complete: false };
  const access = await bin.createSyncAccessHandle();
  let have = meta.complete ? access.getSize() : access.getSize();
  if (meta.complete && meta.total === have && have > 0) {
    access.close();
    const file = await bin.getFile();
    return new Response(file, { headers: { "content-length": String(file.size) } });
  }

  const headers = new Headers(init?.headers);
  if (have > 0) {
    headers.set("Range", `bytes=${have}-`);
    if (meta.etag) headers.set("If-Range", meta.etag);
  }
  let response = await base(href, { ...init, headers });
  let plan = planResume(response.status, response.headers.get("content-range"), response.headers.get("content-length"), have);
  if (plan.action === "passthrough" && response.status === 206) {
    await response.body?.cancel();
    have = 0;
    response = await base(href, init);
    plan = planResume(response.status, response.headers.get("content-range"), response.headers.get("content-length"), 0);
  }
  if (plan.action === "passthrough" || !response.body) {
    access.close();
    return response;
  }

  if (plan.action === "restart") {
    access.truncate(0);
    have = 0;
  }
  const total = plan.total;
  const etag = response.headers.get("etag") ?? meta.etag;
  await writeMeta(folder, name, { total, complete: false, ...(etag ? { etag } : {}) });

  const reader = response.body.getReader();
  let closed = false;
  const closeAccess = () => {
    if (closed) return;
    closed = true;
    access.close();
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const saved = new Uint8Array(1024 * 1024);
        for (let at = 0; at < have; ) {
          const n = access.read(saved, { at });
          if (n <= 0) break;
          controller.enqueue(saved.slice(0, n));
          at += n;
        }
        let offset = have;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          access.write(value, { at: offset });
          offset += value.byteLength;
          controller.enqueue(value);
        }
        access.flush();
        if (offset === total) await writeMeta(folder, name, { total, complete: true, ...(etag ? { etag } : {}) });
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        closeAccess();
      }
    },
    cancel() {
      closeAccess();
      void reader.cancel();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-length": String(total) } });
}
