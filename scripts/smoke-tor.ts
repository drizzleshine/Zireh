/**
 * Live check: bootstrap a private Tor client and make three requests, each on its own circuit.
 * Prints bootstrap time and per-request latency. Usage: pnpm smoke:tor
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newCircuitTag, startTor, torTransport } from "../packages/tor/src/index.ts";

// Set TOR_DATA_DIR to reuse a cached consensus (warm start); otherwise a fresh dir (cold start).
const keep = process.env.TOR_DATA_DIR;
const dir = keep ?? mkdtempSync(join(tmpdir(), "zireh-tor-"));
const t0 = Date.now();
const tor = startTor({ dataDir: dir, socksPort: 9161, onProgress: (p) => [0, 50, 75, 100].includes(p) && console.log(`bootstrap ${p}% at ${((Date.now() - t0) / 1000).toFixed(1)}s`) });
try {
  await tor.bootstrapped;
  const transport = torTransport(tor.socks);
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    const res = await transport.fetchFor(newCircuitTag())("https://check.torproject.org/api/ip");
    console.log(`call ${i + 1} (own circuit): ${await res.text()} in ${Date.now() - start} ms`);
  }
} finally {
  tor.stop();
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
