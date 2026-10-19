import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { serve } from "@hono/node-server";
import { RelayClient } from "@zireh/inference";
import { Ledger } from "@zireh/ledger";
import { openAiCompatible } from "@zireh/llm";
import { directTransport, startTor, torTransport, type Transport } from "@zireh/tor";
import { Wallet } from "@zireh/wallet";
import { createDaemon } from "./api.ts";
import { ensureDir, fileLedgerStore, filePendingStore, fileProofStore } from "./stores.ts";

const env = process.env;
const port = Number(env.DAEMON_PORT ?? 7878);
const dataDir = env.DAEMON_DATA_DIR ?? ".zireh/daemon";
const relayUrl = env.RELAY_URL ?? "http://127.0.0.1:8787";
const syncUrl = env.SYNC_URL ?? "http://127.0.0.1:8788";
const ollamaUrl = env.OLLAMA_URL ?? "http://127.0.0.1:11434/v1";
const localModelId = env.LOCAL_MODEL ?? "nemotron-3-nano:4b";
const webDist = env.WEB_DIST ?? join(import.meta.dirname, "../../web/dist");
ensureDir(dataDir);

/**
 * Transport. Default is Tor with a private client and a persistent data dir (warm starts in
 * seconds). Requests made before Tor is ready wait for it; if Tor fails they fail. There is no
 * silent fallback: `ZIREH_TRANSPORT=direct` must be chosen explicitly and the UI shows it.
 */
let torReady = false;
let torProgress = 0;
let transport: Transport;
if (env.ZIREH_TRANSPORT === "direct") {
  transport = directTransport();
  torReady = true;
  torProgress = 100;
} else {
  const tor = startTor({
    dataDir: join(dataDir, "tor"),
    socksPort: Number(env.TOR_SOCKS_PORT ?? 9152),
    onProgress: (p) => {
      torProgress = p;
    },
  });
  tor.bootstrapped.then(() => (torReady = true)).catch((err: Error) => console.error(`tor failed: ${err.message}`));
  const inner = torTransport(tor.socks);
  transport = {
    kind: "tor",
    fetchFor: (tag) => async (input, init) => {
      await tor.bootstrapped;
      return inner.fetchFor(tag)(input, init);
    },
  };
  process.on("exit", () => tor.stop());
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
}

// Non-reasoning mode keeps each local stage around a second on a laptop.
const local = openAiCompatible({ baseUrl: ollamaUrl, model: localModelId, extraBody: { reasoning_effort: "none" } });
const wallet = new Wallet(fileProofStore(dataDir));
const relay = new RelayClient({ baseUrl: relayUrl, transport, wallet, pending: filePendingStore(dataDir) });
const ledger = new Ledger(fileLedgerStore(dataDir));

const api = createDaemon({
  local,
  relay,
  ledger,
  wallet,
  transport,
  syncUrl,
  torState: () => ({ ready: torReady, progress: torProgress }),
  localModelOk: async () => {
    try {
      const res = await fetch(`${ollamaUrl.replace(/\/v1$/, "")}/api/tags`);
      const body = (await res.json()) as { models?: { name: string }[] };
      return (body.models ?? []).some((m) => m.name === localModelId);
    } catch {
      return false;
    }
  },
  allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, "http://127.0.0.1:5173", "http://localhost:5173"],
});

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

/** Serve the built web app (same origin as the API, so no CORS is needed). */
function staticFile(pathname: string): Response | undefined {
  if (!existsSync(webDist)) return undefined;
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(webDist, rel);
  if (!file.startsWith(webDist) || !existsSync(file) || !extname(file)) file = join(webDist, "index.html");
  return new Response(readFileSync(file), {
    headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
  });
}

serve(
  {
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) return api(req);
      return staticFile(url.pathname) ?? new Response("Zireh daemon is running. Build the web app (pnpm --filter @zireh/web build) to use the UI.", { status: 404 });
    },
    port,
    hostname: "127.0.0.1",
  },
  () => {
    console.log(`daemon on http://127.0.0.1:${port}`);
    console.log(`transport: ${transport.kind === "tor" ? "Tor (private client, one circuit per call)" : "DIRECT — no anonymity (development only)"}`);
    console.log(`local model: ${localModelId} via ${ollamaUrl}`);
    console.log(`relay: ${relayUrl}   sync host: ${syncUrl}`);
  },
);
