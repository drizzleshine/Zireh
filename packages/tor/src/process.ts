import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { SocksEndpoint } from "./transport.ts";

export interface TorProcess {
  readonly socks: SocksEndpoint;
  readonly bootstrapped: Promise<void>;
  stop(): void;
}

export interface TorOptions {
  readonly binary?: string; // default: "tor" on PATH
  readonly dataDir: string;
  readonly socksPort: number;
  readonly onProgress?: (percent: number, summary: string) => void;
  readonly timeoutMs?: number;
}

/** Run a private Tor client for this daemon. Resolves `bootstrapped` at 100%. */
export function startTor(options: TorOptions): TorProcess {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const child: ChildProcess = spawn(
    options.binary ?? "tor",
    ["--SocksPort", `127.0.0.1:${options.socksPort}`, "--DataDirectory", options.dataDir, "--ControlPort", "0", "--Log", "notice stdout"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const bootstrapped = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tor did not bootstrap in time")), options.timeoutMs ?? 120_000);
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n").slice(0, -1)) {
        const m = /Bootstrapped (\d+)%[^:]*: (.*)$/.exec(line);
        if (m) {
          options.onProgress?.(Number(m[1]), m[2]!);
          if (m[1] === "100") {
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
  bootstrapped.catch(() => {}); // callers observe it; avoid unhandled rejection after stop()

  return {
    socks: { host: "127.0.0.1", port: options.socksPort },
    bootstrapped,
    stop: () => child.kill("SIGTERM"),
  };
}
