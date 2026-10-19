import { RelayCallError, RelayClient } from "@zireh/inference";
import { scriptedModel, type ChatModel } from "@zireh/llm";
import type { FetchLike, ModelPrice } from "@zireh/schema";
import { directTransport } from "@zireh/tor";
import { generateMintKeys, memoryProofStore, memorySpentStore, Mint, prepareTopup, Wallet } from "@zireh/wallet";
import { fixedRate, simulatedWatcher } from "@zireh/zcash";
import { describe, expect, it } from "vitest";
import { createRelay, memoryResponseStore } from "../src/relay.ts";

const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const price: ModelPrice = { model: MODEL, inputPerMTok: 300_000, outputPerMTok: 900_000 };

function setup(upstream: ChatModel = scriptedModel(() => "the answer is 42")) {
  const watcher = simulatedWatcher(fixedRate(50));
  const handler = createRelay({
    mint: new Mint(generateMintKeys(), memorySpentStore()),
    watcher,
    models: new Map([[MODEL, { upstream, price }]]),
    search: async (q) => [{ title: `About ${q}`, url: "https://example.org", content: "..." }],
    searchPrice: 2000,
    responses: memoryResponseStore(),
  });
  const relayFetch: FetchLike = (url, init) => handler(new Request(url, init));
  const wallet = new Wallet(memoryProofStore());
  const client = new RelayClient({ baseUrl: "http://relay.test", transport: directTransport(relayFetch), wallet });
  return { handler, relayFetch, wallet, client, watcher };
}

async function fund(client: RelayClient, relayFetch: FetchLike, credits: number) {
  const quote = await client.quote(credits);
  await relayFetch("http://relay.test/v1/topup/simulate", { method: "POST", body: JSON.stringify({ quoteId: quote.quoteId }) });
  return client.redeemTopup(quote);
}

const ask = [{ role: "user" as const, content: "What is the answer?" }];

describe("relay + client", () => {
  it("tops up, pays the max, and is charged exactly the actual cost", async () => {
    const { client, relayFetch, wallet } = setup();
    expect(await fund(client, relayFetch, 1_000_000)).toBe(1_000_000);

    const call = await client.prepareChat(MODEL, ask, 400);
    const result = await client.send(call);
    if (result.kind !== "chat") throw new Error("expected chat");
    expect(result.content).toBe("the answer is 42");
    expect(result.charged).toBeGreaterThan(0);
    expect(result.bill.overcharged).toBe(false);
    expect(wallet.balance).toBe(1_000_000 - result.charged);
    expect(client.pending.list()).toEqual([]);
  });

  it("re-sending the same call returns the stored result and never pays twice", async () => {
    const { client, relayFetch, wallet } = setup();
    await fund(client, relayFetch, 100_000);
    const call = await client.prepareChat(MODEL, ask, 100);
    const first = await client.send(call);
    const second = await client.send(call); // e.g. the client didn't see the first reply
    expect(second).toMatchObject({ requestId: first.requestId, charged: first.charged });
    // The change from the first reply must not be credited a second time.
    expect(wallet.balance).toBe(100_000 - first.charged);
  });

  it("recovers a call whose reply was lost on the way back", async () => {
    const { client, handler, wallet } = setup();
    const okFetch: FetchLike = (url, init) => handler(new Request(url, init));
    await fund(client, okFetch, 100_000);

    // A transport that delivers the request but loses the reply once.
    let dropNext = true;
    const lossy = new RelayClient({
      baseUrl: "http://relay.test",
      wallet,
      pending: client.pending,
      transport: directTransport(async (url, init) => {
        const res = await handler(new Request(url, init));
        if (dropNext && url.endsWith("/v1/chat")) {
          dropNext = false;
          throw new Error("circuit closed");
        }
        return res;
      }),
    });
    const call = await lossy.prepareChat(MODEL, ask, 100);
    await expect(lossy.send(call)).rejects.toMatchObject({ code: "network" });
    expect(lossy.pending.list()).toHaveLength(1);

    const { recovered } = await lossy.recover();
    expect(recovered).toHaveLength(1);
    expect(wallet.balance).toBe(100_000 - recovered[0]!.charged);
  });

  it("refunds everything when the upstream model fails", async () => {
    const failing = scriptedModel(() => {
      throw new Error("upstream down");
    });
    const { client, relayFetch, wallet } = setup(failing);
    await fund(client, relayFetch, 50_000);
    const call = await client.prepareChat(MODEL, ask, 100);
    await expect(client.send(call)).rejects.toMatchObject({ code: "upstream_error" });
    expect(wallet.balance).toBe(50_000);
  });

  it("pays a flat price for search", async () => {
    const { client, relayFetch, wallet } = setup();
    await fund(client, relayFetch, 10_000);
    const result = await client.send(await client.prepareSearch("press freedom index", 3));
    expect(result).toMatchObject({ kind: "search", charged: 2000 });
    expect(wallet.balance).toBe(8_000);
  });

  it("rejects unknown models before taking coins", async () => {
    const { client, relayFetch, wallet } = setup();
    await fund(client, relayFetch, 10_000);
    await expect(client.prepareChat("other/model", ask, 10)).rejects.toBeInstanceOf(RelayCallError);
    expect(wallet.balance).toBe(10_000);
  });
});

describe("top-up safety", () => {
  it("mints only the paid amount, only once, and only after payment", async () => {
    const { client, relayFetch } = setup();
    const { keyset } = await client.info();
    const quote = await client.quote(1000);
    const post = (path: string, body: unknown) =>
      relayFetch(`http://relay.test${path}`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

    expect((await post("/v1/topup/mint", { quoteId: quote.quoteId, outputs: prepareTopup(keyset, 1000).outputs })).body.error).toBe("quote_unpaid");
    await post("/v1/topup/simulate", { quoteId: quote.quoteId });
    expect((await post("/v1/topup/mint", { quoteId: quote.quoteId, outputs: prepareTopup(keyset, 5000).outputs })).body.error).toBe("bad_request");
    expect((await post("/v1/topup/mint", { quoteId: quote.quoteId, outputs: prepareTopup(keyset, 1000).outputs })).status).toBe(200);
    expect((await post("/v1/topup/mint", { quoteId: quote.quoteId, outputs: prepareTopup(keyset, 1000).outputs })).body.error).toBe("quote_unpaid");
  });
});
