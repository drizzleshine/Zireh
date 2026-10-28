import { serve } from "@hono/node-server";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exposeAsOnion } from "@zireh/tor";
import { createSyncHost, openHostDb } from "./host.ts";

const port = Number(process.env.SYNC_PORT ?? process.env.PORT ?? 8788);
// Local by default. A hosted container sets SYNC_HOST_BIND=0.0.0.0 so its platform can route to it.
const hostname = process.env.SYNC_HOST_BIND ?? "127.0.0.1";
const dbPath = process.env.SYNC_DB ?? ".zireh/sync/sync.db";

serve({ fetch: createSyncHost(openHostDb(dbPath)), port, hostname }, ({ port }) => {
  console.log(`sync host listening on ${hostname}:${port} (stores ciphertext only)`);
});

// SYNC_ONION=1 publishes the sync host as an onion service; URL written next to the database.
if (process.env.SYNC_ONION === "1") {
  const dataDir = dirname(dbPath);
  const { url, tor } = await exposeAsOnion({ dataDir, localPort: port, socksPort: Number(process.env.SYNC_TOR_SOCKS ?? 9172) });
  writeFileSync(join(dataDir, "onion-url"), url);
  console.log(`onion service: ${url}`);
  process.on("exit", () => tor.stop());
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
}
