import { serve } from "@hono/node-server";
import { openAiCompatible } from "@zireh/llm";
import { Mint } from "@zireh/wallet";
import { fixedRate, simulatedWatcher, zecCheckoutWatcher } from "@zireh/zcash";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exposeAsOnion } from "@zireh/tor";
import { loadConfig } from "./config.ts";
import { createRelay } from "@zireh/relay-core";
import { loadOrCreateMintKeys, openRelayDb, sqliteDemoAdmission, sqliteQuoteStore, sqliteResponseStore, sqliteSpentStore } from "./storage.ts";
import { tavilySearch } from "./tavily.ts";

const config = loadConfig();
const db = openRelayDb(config.dataDir);
const up = config.upstream;

// In local-dev mode the relay offers only the model that actually answers, so nothing
// is ever labeled as a Token Factory model when it isn't.
const offered =
  up.mode === "token-factory"
    ? config.prices
    : [{ ...config.prices[0]!, model: up.localModel }];
const models = new Map(
  offered.map((price) => [
    price.model,
    {
      price,
      upstream:
        up.mode === "token-factory"
          ? openAiCompatible({ baseUrl: up.baseUrl, apiKey: up.apiKey, model: price.model })
          : openAiCompatible({ baseUrl: up.baseUrl, model: up.localModel, extraBody: { reasoning_effort: "none" } }), // no hidden tokens: bills stay checkable
    },
  ]),
);

// The relay being up says nothing about the AI it forwards to. A model listing is free and quick;
// the answer is reused for 15 s so frequent /v1/info calls don't hammer the provider.
let upstreamCheck: { at: number; result: Promise<boolean> } | undefined;
const upstreamOk = () => {
  if (!upstreamCheck || Date.now() - upstreamCheck.at > 15_000) {
    const result = fetch(`${up.baseUrl.replace(/\/$/, "")}/models`, {
      headers: up.mode === "token-factory" ? { authorization: `Bearer ${up.apiKey}` } : {},
      signal: AbortSignal.timeout(3000),
    }).then(
      async (res) => {
        if (!res.ok) return false;
        if (up.mode === "token-factory") return true;
        const body = (await res.json()) as { data?: { id: string }[] };
        return (body.data ?? []).some((m) => m.id === up.localModel);
      },
      () => false,
    );
    upstreamCheck = { at: Date.now(), result };
  }
  return upstreamCheck.result;
};

const totals = { chat: 0, search: 0, topup: 0, refund: 0 };
const handler = createRelay({
  ...(config.demo ? { admission: sqliteDemoAdmission(db, config.demo) } : {}),
  mint: new Mint(loadOrCreateMintKeys(config.dataDir), sqliteSpentStore(db)),
  watcher: config.zecCheckout
    ? zecCheckoutWatcher({ ...config.zecCheckout, rate: fixedRate(config.usdPerZec), quotes: sqliteQuoteStore(db) })
    : simulatedWatcher(fixedRate(config.usdPerZec), Date.now, sqliteQuoteStore(db)),
  models,
  ...(config.tavilyApiKey ? { search: tavilySearch(config.tavilyApiKey) } : {}),
  searchPrice: config.searchPrice,
  responses: sqliteResponseStore(db),
  upstreamOk,
  onEvent: (event, credits) => {
    totals[event] += credits;
  },
});

// Local by default. A hosted container sets RELAY_HOST=0.0.0.0 and PORT so its platform can route to it.
const hostname = process.env.RELAY_HOST ?? "127.0.0.1";
serve({ fetch: handler, port: config.port, hostname }, ({ port }) => {
  console.log(`relay listening on ${hostname}:${port}`);
  console.log(`upstream: ${up.mode === "token-factory" ? `Nebius Token Factory (${up.baseUrl})` : `LOCAL DEV via ${up.localModel} — not Token Factory`}`);
  console.log(`models: ${offered.map((p) => p.model).join(", ")}`);
  console.log(`search: ${config.tavilyApiKey ? "Tavily" : "disabled (no TAVILY_API_KEY)"}`);
  console.log(`payments: ${config.zecCheckout ? `Zcash ${config.zecCheckout.network} via ZecCheckout (${config.zecCheckout.url})` : "simulated Zcash network"}`);
});

// RELAY_ONION=1 publishes the relay as an onion service and writes its URL to <dataDir>/onion-url.
if (process.env.RELAY_ONION === "1") {
  const { url, tor } = await exposeAsOnion({ dataDir: config.dataDir, localPort: config.port, socksPort: Number(process.env.RELAY_TOR_SOCKS ?? 9171) });
  writeFileSync(join(config.dataDir, "onion-url"), url);
  console.log(`onion service: ${url}`);
  process.on("exit", () => tor.stop());
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
}
