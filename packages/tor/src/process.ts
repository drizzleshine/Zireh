import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SocksEndpoint } from "./transport.ts";

export interface OnionService {
  readonly dir: string; // keys live here; keep it to keep the same .onion address
  readonly virtualPort: number; // port clients use on the .onion address
  readonly target: string; // local host:port the service forwards to
}

export interface TorProcess {
  readonly socks: SocksEndpoint;
  readonly bootstrapped: Promise<void>;
  /** The .onion hostname, once Tor has created the service. */
  onionAddress(): string | undefined;
  progress(): number;
  stop(): void;
}

export interface TorOptions {
  readonly binary?: string; // default: "tor" on PATH
  readonly dataDir: string;
  readonly socksPort: number;
  readonly onion?: OnionService;
  readonly onProgress?: (percent: number, summary: string) => void;
  readonly timeoutMs?: number;
}

/** Run a private Tor client (and optionally an onion service). Resolves `bootstrapped` at 100%. */
export function startTor(options: TorOptions): TorProcess {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const args = ["--SocksPort", `127.0.0.1:${options.socksPort}`, "--DataDirectory", options.dataDir, "--ControlPort", "0", "--Log", "notice stdout"];
  if (options.onion) {
    mkdirSync(options.onion.dir, { recursive: true, mode: 0o700 });
    args.push("--HiddenServiceDir", options.onion.dir, "--HiddenServicePort", `${options.onion.virtualPort} ${options.onion.target}`);
  }
  const child: ChildProcess = spawn(options.binary ?? "tor", args, { stdio: ["ignore", "pipe", "pipe"] });

  let percent = 0;
  const bootstrapped = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tor did not bootstrap in time")), options.timeoutMs ?? 180_000);
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n").slice(0, -1)) {
        const m = /Bootstrapped (\d+)%[^:]*: (.*)$/.exec(line);
        if (m) {
          percent = Number(m[1]);
          options.onProgress?.(percent, m[2]!);
          if (percent === 100) {
            clearTimeout(timer);
            resolve();
          }
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`tor exited with code ${code}`));
    });
  });
  bootstrapped.catch(() => {}); // observed by callers; avoid unhandled rejection after stop()

  return {
    socks: { host: "127.0.0.1", port: options.socksPort },
    bootstrapped,
    progress: () => percent,
    onionAddress() {
      if (!options.onion) return undefined;
      const file = join(options.onion.dir, "hostname");
      return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
    },
    stop: () => child.kill("SIGTERM"),
  };
}
