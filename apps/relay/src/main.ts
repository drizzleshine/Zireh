import { serve } from "@hono/node-server";
import { openAiCompatible } from "@zireh/llm";
import { Mint } from "@zireh/wallet";
import { fixedRate, simulatedWatcher } from "@zireh/zcash";
import { loadConfig } from "./config.ts";
import { createRelay } from "@zireh/relay-core";
import { loadOrCreateMintKeys, openRelayDb, sqliteResponseStore, sqliteSpentStore } from "./storage.ts";
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
          : openAiCompatible({ baseUrl: up.baseUrl, model: up.localModel }),
    },
  ]),
);

const totals = { chat: 0, search: 0, topup: 0, refund: 0 };
const handler = createRelay({
  mint: new Mint(loadOrCreateMintKeys(config.dataDir), sqliteSpentStore(db)),
  watcher: simulatedWatcher(fixedRate(config.usdPerZec)),
  models,
  ...(config.tavilyApiKey ? { search: tavilySearch(config.tavilyApiKey) } : {}),
  searchPrice: config.searchPrice,
  responses: sqliteResponseStore(db),
  onEvent: (event, credits) => {
    totals[event] += credits;
  },
});

serve({ fetch: handler, port: config.port, hostname: "127.0.0.1" }, ({ port }) => {
  console.log(`relay listening on 127.0.0.1:${port}`);
  console.log(`upstream: ${up.mode === "token-factory" ? `Nebius Token Factory (${up.baseUrl})` : `LOCAL DEV via ${up.localModel} — not Token Factory`}`);
  console.log(`models: ${offered.map((p) => p.model).join(", ")}`);
  console.log(`search: ${config.tavilyApiKey ? "Tavily" : "disabled (no TAVILY_API_KEY)"}`);
  console.log("payments: simulated Zcash network");
});
