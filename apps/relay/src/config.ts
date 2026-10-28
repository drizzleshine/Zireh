import type { ModelPrice } from "@zireh/schema";

/**
 * Relay configuration from the environment.
 *
 * Upstream modes:
 *  - "token-factory": NEBIUS_API_KEY set; models served by Nebius Token Factory.
 *  - "local-dev": no key; the relay forwards to a local Ollama Nemotron model so the whole
 *    system runs end to end. The UI shows this mode; it is never presented as Token Factory.
 */
export interface RelayConfig {
  readonly port: number;
  readonly demo?: { readonly quoteLimit: number; readonly dailyLimit: number };
  readonly dataDir: string;
  readonly upstream:
    | { readonly mode: "token-factory"; readonly baseUrl: string; readonly apiKey: string }
    | { readonly mode: "local-dev"; readonly baseUrl: string; readonly localModel: string };
  readonly prices: readonly ModelPrice[];
  readonly tavilyApiKey?: string;
  readonly searchPrice: number;
  readonly usdPerZec: number;
  /** Real payments through a ZecCheckout sidecar. Absent: payments are simulated. */
  readonly zecCheckout?: { readonly url: string; readonly apiKey: string; readonly network: "testnet" | "mainnet" };
}

/** µUSD per 1M tokens: provider list price plus a 20% relay margin. */
const withMargin = (usdIn: number, usdOut: number) => ({ inputPerMTok: Math.ceil(usdIn * 1.2 * 1e6), outputPerMTok: Math.ceil(usdOut * 1.2 * 1e6) });

export const DEFAULT_MODELS: readonly ModelPrice[] = [
  { model: "nvidia/nemotron-3-super-120b-a12b", ...withMargin(0.3, 0.9) },
  { model: "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1", ...withMargin(0.6, 1.8) },
];

/** RELAY_MODELS="id:usdIn:usdOut,id:usdIn:usdOut" overrides the defaults. */
function parseModels(spec: string | undefined): readonly ModelPrice[] {
  if (!spec) return DEFAULT_MODELS;
  return spec.split(",").map((entry) => {
    const [model, usdIn, usdOut] = entry.split(":");
    if (!model || !usdIn || !usdOut) throw new Error(`bad RELAY_MODELS entry: ${entry}`);
    return { model, ...withMargin(Number(usdIn), Number(usdOut)) };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const apiKey = env.NEBIUS_API_KEY?.trim();
  const demo = env.RELAY_DEMO === "1";
  const zecCheckout = zecCheckoutFrom(env);
  // Simulated and testnet coins are free, so anything they buy from a paid provider is ours to pay.
  if ((apiKey || env.TAVILY_API_KEY?.trim()) && !demo && zecCheckout?.network !== "mainnet") throw new Error("Simulated or testnet payments cannot fund paid providers. Set RELAY_DEMO=1 to explicitly enable a capped demo.");
  const limit = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
    return value;
  };
  return {
    port: Number(env.RELAY_PORT ?? env.PORT ?? 8787),
    ...(demo ? { demo: { quoteLimit: limit("RELAY_DEMO_QUOTE_LIMIT", 5_000_000), dailyLimit: limit("RELAY_DEMO_DAILY_LIMIT", 20_000_000) } } : {}),
    dataDir: env.RELAY_DATA_DIR ?? ".zireh/relay",
    upstream: apiKey
      ? { mode: "token-factory", baseUrl: env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1", apiKey }
      : { mode: "local-dev", baseUrl: env.OLLAMA_URL ?? "http://127.0.0.1:11434/v1", localModel: env.LOCAL_MODEL ?? "nemotron-3-nano:4b" },
    prices: parseModels(env.RELAY_MODELS),
    ...(env.TAVILY_API_KEY?.trim() ? { tavilyApiKey: env.TAVILY_API_KEY.trim() } : {}),
    searchPrice: Number(env.RELAY_SEARCH_PRICE ?? 9600), // Tavily basic ≈ $0.008 + margin
    usdPerZec: Number(env.USD_PER_ZEC ?? 50),
    ...(zecCheckout ? { zecCheckout } : {}),
  };
}

/** ZECCHECKOUT_URL + ZECCHECKOUT_API_KEY switch on real payments; ZCASH_NETWORK picks the chain (testnet unless set). */
function zecCheckoutFrom(env: NodeJS.ProcessEnv): RelayConfig["zecCheckout"] {
  const url = env.ZECCHECKOUT_URL?.trim();
  if (!url) return undefined;
  const apiKey = env.ZECCHECKOUT_API_KEY?.trim();
  if (!apiKey) throw new Error("ZECCHECKOUT_URL is set but ZECCHECKOUT_API_KEY is not");
  const network = env.ZCASH_NETWORK ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error("ZCASH_NETWORK must be testnet or mainnet");
  return { url, apiKey, network };
}
