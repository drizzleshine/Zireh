/**
 * Run the whole stack locally: relay, sync host and daemon (each restarts when its code
 * changes), plus the built web UI served by the daemon at http://127.0.0.1:7878.
 *
 *   pnpm dev            Tor on (default). The daemon starts a private Tor client.
 *   pnpm dev --direct   No Tor: for development without network anonymity (labeled in the UI).
 *
 * Reads NEBIUS_API_KEY / TAVILY_API_KEY from .env if present. Data lives in .zireh/.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const direct = process.argv.includes("--direct");

const env: NodeJS.ProcessEnv = { ...process.env };
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const children: ChildProcess[] = [];
function run(name: string, cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn("pnpm", ["exec", "tsx", "watch", "--clear-screen=false", ...args], { cwd: join(root, cwd), env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `[${name}]`.padEnd(8);
  for (const stream of [child.stdout!, child.stderr!])
    stream.on("data", (d: Buffer) => process.stdout.write(d.toString().replace(/^(?=.)/gm, `${prefix} `)));
  children.push(child);
}

console.log("building web UI…");
const build = spawn("pnpm", ["--filter", "@zireh/web", "build"], { cwd: root, stdio: "inherit" });
build.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const relayDir = join(root, ".zireh/relay");
  const syncDir = join(root, ".zireh/sync");
  run("relay", "apps/relay", ["src/main.ts"], { RELAY_DATA_DIR: relayDir, ...(direct ? {} : { RELAY_ONION: "1" }) });
  run("sync", "apps/sync-host", ["src/main.ts"], { SYNC_DB: join(syncDir, "sync.db"), ...(direct ? {} : { SYNC_ONION: "1" }) });
  const startDaemon = (urls: NodeJS.ProcessEnv) => {
    run("daemon", "apps/daemon", ["src/main.ts"], { DAEMON_DATA_DIR: join(root, ".zireh/daemon"), ...urls, ...(direct ? { ZIREH_TRANSPORT: "direct" } : {}) });
    console.log(`\nZireh: open http://127.0.0.1:7878  (${direct ? "DIRECT mode, no Tor" : "Tor mode: relay and sync host are onion services"})\n`);
  };
  if (direct) return startDaemon({});
  // Tor mode: wait for both onion addresses, then point the daemon at them.
  console.log("publishing relay and sync host as onion services (first run can take a minute)…");
  for (const f of [join(relayDir, "onion-url"), join(syncDir, "onion-url")]) if (existsSync(f)) rmSync(f);
  const timer = setInterval(() => {
    const files = [join(relayDir, "onion-url"), join(syncDir, "onion-url")];
    if (!files.every(existsSync)) return;
    clearInterval(timer);
    startDaemon({ RELAY_URL: readFileSync(files[0]!, "utf8").trim(), SYNC_URL: readFileSync(files[1]!, "utf8").trim() });
  }, 500);
});

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
