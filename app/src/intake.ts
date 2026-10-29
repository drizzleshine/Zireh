import { sha256Hex } from "@zireh/crypto";
import { MAX_ATTACHMENT_BYTES, type Attachment, type EntityKind, type Pseudonym } from "@zireh/schema";
import { formatBytes } from "./evidence.ts";
import { prepareImage } from "./media.ts";

/**
 * Evidence intake: read what the user attaches into files kept as received, and scan text on
 * this device for what would be hidden before any AI call.
 */

const MAX_TEXT = 1_000_000;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|eml|html?|xml|ya?ml|srt|vtt|rtf)$/i;
const stem = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";

/** A title for a new item: the first line of the text, else the first file's name. */
export function titleFor(text: string, files: readonly Attachment[]): string {
  const url = /^\s*(https?:\/\/[^\s]+)\s*$/i.exec(text);
  if (url) {
    try {
      const u = new URL(url[1]!);
      return `${u.hostname.replace(/^www\./, "")}${u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : ""}`.slice(0, 120);
    } catch {
      /* fall through: not a parseable URL */
    }
  }
  const firstLine = text.trim().split("\n")[0]!.replace(/^#+\s*/, "").trim();
  if (firstLine) return firstLine.length > 80 ? `${firstLine.slice(0, 77).replace(/\s+\S*$/, "")}…` : firstLine;
  return files[0] ? stem(files[0].name) : "Untitled";
}

async function pdfText(file: File): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join(""));
  }
  await task.destroy();
  return { text: pages.map((p, i) => `[Page ${i + 1}]\n${p.trim()}`).join("\n\n"), pages: doc.numPages };
}

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

/**
 * One file → one attachment, kept as received. Pictures are re-encoded here so location and
 * camera data never reach storage; PDF and text files also get their text read for search and AI.
 */
export async function readFile(file: File): Promise<Attachment> {
  let name = file.name || "file";
  let type = file.type || "application/octet-stream";
  let bytes: Uint8Array;
  let text: string | undefined;
  if (/^image\/(png|jpeg|webp|gif|heic|heif|avif|bmp)$/.test(file.type)) {
    const img = await prepareImage(file);
    bytes = Uint8Array.from(atob(img.dataUrl.split(",")[1]!), (c) => c.charCodeAt(0));
    name = `${name.replace(/\.[^.]+$/, "")}.jpg`;
    type = "image/jpeg";
  } else {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is ${formatBytes(file.size)}. Files can be at most ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
    bytes = new Uint8Array(await file.arrayBuffer());
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) text = (await pdfText(file).catch(() => undefined))?.text;
    else if (file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXT.test(file.name)) text = (await file.text()).slice(0, MAX_TEXT);
    if (text !== undefined && !text.replace(/\[Page \d+\]/g, "").trim()) text = undefined;
  }
  return { name: name.slice(0, 200), type: type.slice(0, 120), size: bytes.byteLength, sha256: sha256Hex(bytes), data: toBase64(bytes), ...(text ? { text } : {}) };
}

/** A picture after redaction: the pixelated JPEG replaces the original, with a new fingerprint. */
export function replaceImage(file: Attachment, dataUrl: string): Attachment {
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return { ...file, type: "image/jpeg", data, size: bytes.byteLength, sha256: sha256Hex(bytes) };
}

export interface Hit {
  readonly text: string;
  readonly kind: EntityKind;
}

/**
 * Which hide-list values (and this device's source identities) appear in the text. Nothing is
 * guessed here: finding new names is the on-device model's job, when a question is asked.
 */
export function scan(text: string, table: readonly Pseudonym[]): Hit[] {
  if (!text || text.startsWith("data:")) return [];
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  return table.flatMap((p) => {
    const k = p.original.toLowerCase();
    if (p.original.length < 2 || seen.has(k) || !lower.includes(k)) return [];
    seen.add(k);
    return [{ text: p.original, kind: p.kind }];
  });
}

/** Split text into plain and hit segments for highlighting. Longest matches win. */
export function segments(text: string, hits: readonly Hit[]): { text: string; hit?: Hit }[] {
  if (!hits.length) return [{ text }];
  const sorted = [...hits].sort((a, b) => b.text.length - a.text.length);
  const re = new RegExp(sorted.map((h) => h.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  const out: { text: string; hit?: Hit }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], hit: sorted.find((h) => h.text.toLowerCase() === m[0].toLowerCase())! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export const KIND_LABEL: Record<EntityKind, string> = {
  person: "name",
  org: "organization",
  place: "place",
  id: "ID number",
  contact: "contact",
  date: "date",
  money: "amount",
  other: "quote",
};
