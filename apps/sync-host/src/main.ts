import { serve } from "@hono/node-server";
import { createSyncHost, openHostDb } from "./host.ts";

const port = Number(process.env.SYNC_PORT ?? 8788);
const dbPath = process.env.SYNC_DB ?? ".zireh/sync/sync.db";

serve({ fetch: createSyncHost(openHostDb(dbPath)), port, hostname: "127.0.0.1" }, ({ port }) => {
  console.log(`sync host listening on 127.0.0.1:${port} (stores ciphertext only)`);
});
