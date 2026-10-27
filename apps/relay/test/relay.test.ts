import { RelayCallError, RelayClient } from "@zireh/inference";
import { scriptedModel, type ChatModel } from "@zireh/llm";
import type { FetchLike, ModelPrice } from "@zireh/schema";
import { directTransport } from "@zireh/tor";
import { generateMintKeys, memoryProofStore, memorySpentStore, Mint, prepareTopup, Wallet } from "@zireh/wallet";
import { fixedRate, simulatedWatcher } from "@zireh/zcash";
import { describe, expect, it, vi } from "vitest";
import { createRelay, memoryResponseStore } from "@zireh/relay-core";

const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const price: ModelPrice = { model: MODEL, inputPerMTok: 300_000, outputPerMTok: 900_000 };

function setup(upstream: ChatModel = scriptedModel(() => "the answer is 42"), responses = memoryResponseStore()) {
  const watcher = simulatedWatcher(fixedRate(50));
  const handler = createRelay({
    mint: new Mint(generateMintKeys(), memorySpentStore()),
    watcher,
    models: new Map([[MODEL, { upstream, price }]]),
    search: async (q) => [{ title: `About ${q}`, url: "https://example.org", content: "..." }],
    searchPrice: 2000,
    responses,
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

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    const { recovered } = await lossy.recover().finally(() => clock.mockRestore());
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

describe("crash safety", () => {
  it("refunds a call whose coins were burned before the relay could answer", async () => {
    const mint = new Mint(generateMintKeys(), memorySpentStore());
    const watcher = simulatedWatcher(fixedRate(50));
    const responses = memoryResponseStore();
    const relayOn = (upstream: ChatModel) => {
      const h = createRelay({ mint, watcher, models: new Map([[MODEL, { upstream, price }]]), searchPrice: 1000, responses });
      return ((url, init) => h(new Request(url, init))) as FetchLike;
    };
    // Relay A burns the coins, then hangs forever in the upstream call (the "crash").
    const hanging = relayOn({ id: "hang", chat: () => new Promise(() => {}) });
    // Relay B: same mint, spent set and reply store, fresh process state (after restart).
    const restarted = relayOn(scriptedModel(() => "unused"));

    const wallet = new Wallet(memoryProofStore());
    const clientA = new RelayClient({ baseUrl: "http://relay.test", transport: directTransport(hanging), wallet });
    await fund(clientA, hanging, 50_000);
    const call = await clientA.prepareChat(MODEL, ask, 100);
    void clientA.send(call); // never settles
    await new Promise((r) => setTimeout(r, 20));
    expect(wallet.balance).toBeLessThan(50_000);

    // A retry to the *same* process while the first attempt runs must wait, not refund.
    let settled = false;
    void clientA.send(call).then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    const clientB = new RelayClient({ baseUrl: "http://relay.test", transport: directTransport(restarted), wallet, pending: clientA.pending });
    await expect(clientB.send(call)).rejects.toMatchObject({ code: "upstream_error" });
    expect(wallet.balance).toBe(50_000);
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
    expect((await post("/v1/topup/mint", { quoteId: quote.quoteId, outputs: prepareTopup(keyset, 1000).outputs })).status).toBe(409);
  });
});

describe("F09 atomic client money movement", () => {
  it("keeps the reservation and rolls back credited change when clearing pending fails", async () => {
    const s = setup();
    await fund(s.client, s.relayFetch, 65_536);
    const call = await s.client.prepareChat(MODEL, ask, 100);
    const reservedBalance = s.wallet.balance;
    const broken = new RelayClient({ baseUrl: "http://relay.test", transport: directTransport(s.relayFetch), wallet: s.wallet,
      pending: { ...s.client.pending, remove() { throw new Error("injected completion failure"); } } });
    await expect(broken.send(call)).rejects.toThrow("injected completion failure");
    expect(s.wallet.balance).toBe(reservedBalance);
    expect(s.client.pending.list()).toHaveLength(1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    const { recovered } = await s.client.recover().finally(() => clock.mockRestore());
    expect(recovered).toHaveLength(1);
    expect(s.wallet.balance).toBe(65_536 - recovered[0]!.charged);
    expect(s.client.pending.list()).toHaveLength(0);
  });
  it("keeps coins when writing the pending call fails", async () => {
    const s = setup();
    await fund(s.client, s.relayFetch, 1_048_576);
    const client = new RelayClient({ baseUrl: "http://relay.test", transport: directTransport(s.relayFetch), wallet: s.wallet,
      pending: { ...s.client.pending, save() { throw new Error("injected pending write failure"); } } });
    await expect(client.prepareChat(MODEL, ask, 100)).rejects.toThrow("injected pending write failure");
    expect(s.wallet.balance).toBe(1_048_576);
    expect(client.pending.list()).toHaveLength(0);
  });
});

describe("F08 settlement conservation", () => {
  it.each(["missing change", "wrong request", "wrong keyset", "invalid point"])("keeps a disputed reservation after %s", async (fault) => {
    const s = setup();
    await fund(s.client, s.relayFetch, 65_536);
    const call = await s.client.prepareChat(MODEL, ask, 100);
    const reservedBalance = s.wallet.balance;
    const client = new RelayClient({ baseUrl: "http://relay.test", wallet: s.wallet,
      transport: directTransport(async (url, init) => {
        const res = await s.handler(new Request(url, init));
        if (!url.endsWith("/v1/chat")) return res;
        const body = await res.json();
        if (fault === "missing change") body.settlement.change = [];
        if (fault === "wrong request") body.settlement.requestId = "0".repeat(32);
        if (fault === "wrong keyset") body.settlement.change[0].keysetId = "another-keyset";
        if (fault === "invalid point") body.settlement.change[0].C_ = `02${"0".repeat(64)}`;
        return Response.json(body);
      }) });
    await expect(client.send(call)).rejects.toMatchObject({ code: "settlement_disputed" });
    expect(s.wallet.balance).toBe(reservedBalance);
    expect(client.pending.list()).toMatchObject([{ requestId: call.requestId, status: "disputed" }]);
    const recovered = [await s.client.retryDispute(call.requestId)];
    expect(recovered).toHaveLength(1);
    expect(s.wallet.balance).toBe(65_536 - recovered[0]!.charged);
  });
});

describe("F07 durable settlement recovery", () => {
  it("recovers change after the answer expires", async () => {
    let now = 0;
    const s = setup(scriptedModel(() => "private answer"), memoryResponseStore(15 * 60_000, () => now));
    await fund(s.client, s.relayFetch, 524_288);
    let drop = true;
    const client = new RelayClient({ baseUrl: "http://relay.test", wallet: s.wallet, now: () => now,
      transport: directTransport(async (url, init) => {
        const res = await s.handler(new Request(url, init));
        if (drop && url.endsWith("/v1/chat")) { drop = false; throw new Error("lost reply"); }
        return res;
      }) });
    const call = await client.prepareChat(MODEL, ask, 100);
    await expect(client.send(call)).rejects.toMatchObject({ code: "network" });
    now += 16 * 60_000;
    const { recovered } = await client.recover();
    expect(recovered).toMatchObject([{ kind: "chat", content: "", answerExpired: true }]);
    expect(s.wallet.balance).toBe(524_288 - recovered[0]!.charged);
    expect(client.pending.list()).toHaveLength(0);
  });
});

describe("F06 top-up recovery", () => {
  it("retries the same blinded outputs after a lost mint reply and credits once", async () => {
    const s = setup();
    const quote = await s.client.quote(100_000);
    await s.client.simulatePayment(quote.quoteId);
    let drop = true;
    const sent: string[] = [];
    const client = new RelayClient({ baseUrl: "http://relay.test", wallet: s.wallet,
      transport: directTransport(async (url, init) => {
        const res = await s.handler(new Request(url, init));
        if (url.endsWith("/v1/topup/mint")) {
          sent.push(String(init?.body));
          if (drop) { drop = false; throw new Error("lost mint reply"); }
        }
        return res;
      }) });
    await expect(client.redeemTopup(quote)).rejects.toMatchObject({ code: "network" });
    expect(s.wallet.balance).toBe(0);
    await client.recover();
    expect(s.wallet.balance).toBe(100_000);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    await client.redeemTopup(quote);
    expect(s.wallet.balance).toBe(100_000);
  });
});

describe("foreground retry after background settlement", () => {
  it("uses the durable local answer after another client has settled and acknowledged it", async () => {
    const s = setup();
    await fund(s.client, s.relayFetch, 65_536);
    const call = await s.client.prepareChat(MODEL, ask, 100);
    const first = await s.client.send(call);
    let networkCalls = 0;
    const restarted = new RelayClient({ baseUrl: "http://relay.test", wallet: s.wallet, transport: directTransport(async () => { networkCalls++; throw new Error("network unavailable after acknowledgement"); }) });
    expect(await restarted.send(call)).toEqual(first);
    expect(networkCalls).toBe(0);
    expect(s.wallet.balance).toBe(65_536 - first.charged);
  });
});

describe("G1 recoverable swaps", () => {
  it("recovers a lost swap reply without paying upstream or crediting twice", async () => {
    let calls = 0;
    const s = setup(scriptedModel(() => { calls++; return "answer"; }));
    await fund(s.client, s.relayFetch, 1_048_576);
    let lost = true;
    const client = new RelayClient({ baseUrl: "http://relay.test", wallet: s.wallet, transport: directTransport(async (url, init) => {
      const response = await s.relayFetch(url, init);
      if (url.endsWith("/v1/swap") && lost) { lost = false; throw new Error("lost swap reply"); }
      return response;
    }) });
    await expect(client.swap([256, 256, 256, 256])).rejects.toMatchObject({ code: "network" });
    expect(s.wallet.balance).toBe(0);
    const restarted = new RelayClient({ baseUrl: "http://relay.test", wallet: s.wallet, transport: directTransport(s.relayFetch) });
    await restarted.recover();
    expect(s.wallet.balance).toBe(1_048_576);
    expect(s.wallet.money.load().filter((p) => p.amount === 256).length).toBeGreaterThanOrEqual(4);
    await restarted.recover();
    expect(s.wallet.balance).toBe(1_048_576);
    expect(calls).toBe(0);
  });
});

it("G1 recovery never submits unsent plan reservations and startup returns their coins", async () => {
  const s = setup();
  await fund(s.client, s.relayFetch, 1_048_576);
  const calls = await s.client.prepareChats(MODEL, Array.from({ length: 4 }, () => ({ messages: ask, maxTokens: 100 })));
  expect(calls).toHaveLength(4);
  expect(s.client.pending.list().every((call) => call.status === "reserved")).toBe(true);
  expect((await s.client.recover()).recovered).toHaveLength(0);
  const reopened = new RelayClient({ baseUrl: "http://relay.test", transport: directTransport(s.relayFetch), wallet: s.wallet });
  reopened.discardUnsent();
  expect(reopened.pending.list()).toHaveLength(0);
  expect(s.wallet.balance).toBe(1_048_576);
});

describe("G2 dispute controls and recovery backoff", () => {
  it("skips disputed calls automatically, rechecks once manually, and retains a written-off journal", async () => {
    const s = setup();
    await fund(s.client, s.relayFetch, 65_536);
    let chats = 0;
    const client = new RelayClient({ baseUrl: "http://relay.test", wallet: s.wallet, transport: directTransport(async (url, init) => {
      const response = await s.relayFetch(url, init);
      if (!url.endsWith("/v1/chat")) return response;
      chats++;
      const body = await response.json();
      body.settlement.change = [];
      return Response.json(body);
    }) });
    const call = await client.prepareChat(MODEL, ask, 100);
    await expect(client.send(call)).rejects.toMatchObject({ code: "settlement_disputed" });
    const heldBalance = s.wallet.balance;
    await client.recover();
    expect(chats).toBe(1);
    await expect(client.retryDispute(call.requestId)).rejects.toMatchObject({ code: "settlement_disputed" });
    expect(chats).toBe(2);
    client.writeOffDispute(call.requestId);
    expect(client.pending.list()).toHaveLength(0);
    expect(s.wallet.balance).toBe(heldBalance);
    expect(s.wallet.money.list("written-off:")).toMatchObject([{ call: { requestId: call.requestId }, amount: 65_536 }]);
    await client.recover();
    expect(chats).toBe(2);
    await expect(client.send(call)).rejects.toThrow(/written off/i);
  });

  it("persists exponential retry deadlines across clients and caps the wait at one hour", async () => {
    const s = setup();
    await fund(s.client, s.relayFetch, 65_536);
    let now = 1_000_000;
    let chats = 0;
    const transport = directTransport(async (url, init) => {
      if (url.endsWith("/v1/chat")) { chats++; throw new Error("offline"); }
      return s.relayFetch(url, init);
    });
    const options = { baseUrl: "http://relay.test", wallet: s.wallet, transport, now: () => now };
    const first = new RelayClient(options);
    const call = await first.prepareChat(MODEL, ask, 100);
    await expect(first.send(call)).rejects.toMatchObject({ code: "network" });
    const reopened = new RelayClient(options);
    for (const delay of [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]) {
      const before = chats;
      now += delay - 1;
      await reopened.recover();
      expect(chats).toBe(before);
      now++;
      await reopened.recover();
      expect(chats).toBe(before + 1);
    }
  });
});

it("G2 write-off rolls back when removing pending fails", async () => {
  const s = setup();
  await fund(s.client, s.relayFetch, 65_536);
  const call = await s.client.prepareChat(MODEL, ask, 100);
  s.client.pending.save({ ...call, status: "disputed", dispute: "Settlement disputed" });
  const client = new RelayClient({ baseUrl: "http://relay.test", wallet: s.wallet, transport: directTransport(s.relayFetch),
    pending: { ...s.client.pending, remove() { throw new Error("journal unavailable"); } } });
  expect(() => client.writeOffDispute(call.requestId)).toThrow("journal unavailable");
  expect(s.wallet.money.list("written-off:")).toHaveLength(0);
  expect(s.client.pending.list()).toHaveLength(1);
});
