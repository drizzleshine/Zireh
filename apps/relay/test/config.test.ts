import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, loadConfig } from "../src/config.ts";

describe("relay config", () => {
  it("uses Nebius Token Factory with Nemotron models when a key is set", () => {
    const c = loadConfig({ NEBIUS_API_KEY: "nb-test" });
    expect(c.upstream).toEqual({ mode: "token-factory", baseUrl: "https://api.tokenfactory.nebius.com/v1", apiKey: "nb-test" });
    expect(c.prices.map((p) => p.model)).toEqual(["nvidia/nemotron-3-super-120b-a12b", "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1"]);
  });

  it("falls back to labeled local-dev mode without a key", () => {
    expect(loadConfig({}).upstream).toMatchObject({ mode: "local-dev", localModel: "nemotron-3-nano:4b" });
  });

  it("prices include a 20% margin over the provider's list price, in µUSD per 1M tokens", () => {
    expect(DEFAULT_MODELS[0]).toMatchObject({ inputPerMTok: 360_000, outputPerMTok: 1_080_000 });
  });

  it("accepts custom models", () => {
    const c = loadConfig({ NEBIUS_API_KEY: "k", RELAY_MODELS: "nvidia/some-nemotron:0.1:0.2" });
    expect(c.prices).toEqual([{ model: "nvidia/some-nemotron", inputPerMTok: 120_000, outputPerMTok: 240_000 }]);
  });
});
