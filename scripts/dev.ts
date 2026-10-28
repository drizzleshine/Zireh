/**
 * Run the stack locally: the Rust host (cargo run: sync, relay and payments on :8788) and the
 * web app's Vite dev server, with each output line prefixed [host] / [app]. Ctrl-C stops both.
 *
 *   pnpm dev
 *
 * The app still expects the old local daemon for its privacy pipeline and wallet; those move into
 * the browser next, and until then the research and top-up screens can't reach the host.
 * Reads variables from .env if present. Data lives in .zireh/.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

const env: NodeJS.ProcessEnv = { ...process.env };
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const children: ChildProcess[] = [];
function run(name: string, cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(cmd, args, { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `[${name}]`.padEnd(7);
  for (const stream of [child.stdout!, child.stderr!])
    stream.on("data", (d: Buffer) => process.stdout.write(d.toString().replace(/^(?=.)/gm, `${prefix} `)));
  child.on("exit", (code) => {
    console.log(`${prefix} exited (${code ?? "signal"})`);
    stop(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 200);
}

run("host", "cargo", ["run", "--manifest-path", "host/Cargo.toml"], {
  SYNC_DB: ".zireh/sync/sync.db",
  RELAY_DATA_DIR: ".zireh/relay",
  PORT: "8788",
});
run("app", "pnpm", ["--filter", "@zireh/app", "dev"]);
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
