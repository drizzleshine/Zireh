import { randomSalt } from "@zireh/crypto";
import { RelayClient } from "@zireh/inference";
import { Ledger } from "@zireh/ledger";
import { scriptedModel, type ChatModel } from "@zireh/llm";
import { createRelay, memoryResponseStore } from "@zireh/relay-core";
import type { ChatMessage, FetchLike } from "@zireh/schema";
import { directTransport } from "@zireh/tor";
import { generateMintKeys, memoryProofStore, memorySpentStore, Mint, Wallet } from "@zireh/wallet";
import { fixedRate, simulatedWatcher } from "@zireh/zcash";
import { describe, expect, it } from "vitest";
import { createDaemon } from "../src/api.ts";
import { runResearch, type ResearchEvent } from "../src/research.ts";

const MODEL = "nemotron-cloud-test";
const ORIGIN = "http://127.0.0.1:7878";

/** Local model that answers each pipeline stage by recognizing its system prompt. */
const local = scriptedModel((messages: readonly ChatMessage[]) => {
  const sys = messages[0]!.content;
  const user = messages.at(-1)!.content;
  if (sys.includes("general kind of thing")) return JSON.stringify({ hints: {} });
    if (sys.includes("say what it names")) return JSON.stringify({ items: [] });
  if (sys.includes("identifying details")) return JSON.stringify({ entities: [{ text: "Ada Obi", kind: "person" }, { text: "Lagos", kind: "place" }] });
  if (sys.includes("the user's request")) return JSON.stringify({ pieces: ["What risks do port reporters face?", "What press laws apply in [PLACE_1]?"] });
  if (sys.includes("You are an AI provider")) return JSON.stringify({ score: 10, inferences: [] });
  if (sys.includes("different people might ask")) return JSON.stringify({ decoys: ["How do bakers keep sourdough starters alive?", "Which trees survive coastal salt spray best?"] });
  if (sys.includes("combine answers")) return "[PERSON_1] faces moderate risk [A1]; [PLACE_1] law is weak [A2].";
  return `local: ${user}`;
}, "nemotron-3-nano:4b");

function setup(localModel: ChatModel = local) {
  const seen: string[] = []; // every user message that reached the cloud model
  const searches: string[] = [];
  const upstream = scriptedModel((messages) => {
    seen.push(messages.at(-1)!.content);
    return "an answer";
  });
  const relayHandler = createRelay({
    mint: new Mint(generateMintKeys(), memorySpentStore()),
    watcher: simulatedWatcher(fixedRate(50)),
    models: new Map([[MODEL, { upstream, price: { model: MODEL, inputPerMTok: 360_000, outputPerMTok: 1_080_000 } }]]),
    searchPrice: 1000,
    search: async (query) => { searches.push(query); return []; },
    responses: memoryResponseStore(),
  });
  const relayFetch: FetchLike = (url, init) => relayHandler(new Request(url, init));
  const transport = directTransport(relayFetch);
  const wallet = new Wallet(memoryProofStore());
  const ledger = new Ledger();
  const relay = new RelayClient({ baseUrl: "http://relay.test", transport, wallet });
  const daemon = createDaemon({
    local: localModel,
    relay,
    ledger,
    wallet,
    transport,
    syncUrl: "http://sync.test",
    torState: () => ({ ready: true, progress: 100 }),
    localModelOk: async () => true,
    allowedOrigins: [ORIGIN],
    localApiKey: "zp-test-key",
  });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    daemon(
      new Request(`http://127.0.0.1:7878${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-zireh": "1", origin: ORIGIN, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { call, seen, searches, wallet, ledger, daemon, relay };
}

async function topUp(call: ReturnType<typeof setup>["call"], credits: number) {
  const quote = await (await call("/api/wallet/quote", { credits })).json();
  await call("/api/wallet/simulate-payment", { quoteId: quote.quoteId });
  return (await (await call("/api/wallet/redeem", quote)).json()).balance as number;
}

async function readEvents(res: Response): Promise<ResearchEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as ResearchEvent);
}

describe("daemon API", () => {
  it("rejects calls without the header, from foreign origins, or via a non-loopback host", async () => {
    const { call, daemon } = setup();
    expect((await call("/api/status", undefined, { "x-zireh": "0" })).status).toBe(403);
    expect((await call("/api/status", undefined, { origin: "https://evil.example" })).status).toBe(403);
    // DNS rebinding: a page on evil.example resolving its name to 127.0.0.1
    const rebound = await daemon(new Request("http://evil.example:7878/api/status", { headers: { "x-zireh": "1" } }));
    expect(rebound.status).toBe(403);
  });

  it("tops up through the simulated network", async () => {
    const { call } = setup();
    expect(await topUp(call, 2_000_000)).toBe(2_000_000);
    const status = await (await call("/api/status")).json();
    expect(status).toMatchObject({ balance: 2_000_000, transport: "direct", relay: { ok: true, network: "simulated", models: [MODEL] } });
  });

  it("runs private research: only redacted pieces and decoys reach the cloud, answer is restored locally", async () => {
    const { call, seen, wallet, ledger } = setup();
    await topUp(call, 2_000_000);
    const res = await call("/api/research", {
      task: "Is Ada Obi at risk after publishing the Lagos port report?",
      context: [],
      level: "private",
      table: [],
      salt: randomSalt(),
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events = await readEvents(res);

    const plan = events.find((e) => e.type === "plan");
    expect(plan && plan.type === "plan" && plan.pieces.length).toBe(4); // 2 real + 2 decoys
    expect(seen).toHaveLength(4);
    for (const text of seen) expect(text).not.toMatch(/Ada|Obi|Lagos/);

    const done = events.at(-1)!;
    if (done.type !== "done") throw new Error(`expected done, got ${JSON.stringify(done)}`);
    expect(done.outcome.answer).toBe("Ada Obi faces moderate risk [A1]; Lagos law is weak [A2].");
    expect(done.table.map((p) => p.placeholder)).toEqual(["[PERSON_1]", "[PLACE_1]"]);
    expect(wallet.balance).toBe(2_000_000 - done.spent);

    const summary = ledger.summary();
    expect(summary).toMatchObject({ calls: 4, real: 2, decoys: 2, spent: done.spent, overcharges: 0 });
  });

  it("local level sends nothing to the relay", async () => {
    const { call, seen } = setup();
    const events = await readEvents(await call("/api/research", { task: "Summarize my notes on Ada Obi.", level: "local", salt: randomSalt() }));
    expect(events.at(-1)!.type).toBe("done");
    expect(seen).toHaveLength(0);
  });

  it("serves OpenAI-compatible chat to local tools with the bearer key only", async () => {
    const { call, daemon, seen } = setup();
    await topUp(call, 2_000_000);
    const post = (headers: Record<string, string>) =>
      daemon(
        new Request("http://127.0.0.1:7878/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ model: "zireh/standard", messages: [{ role: "user", content: "Is Ada Obi safe in Lagos?" }] }),
        }),
      );
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
    const res = await post({ authorization: "Bearer zp-test-key" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.role).toBe("assistant");
    for (const text of seen) expect(text).not.toMatch(/Ada|Lagos/);
  });

  it("reports insufficient funds instead of sending", async () => {
    const { call, seen } = setup();
    const events = await readEvents(await call("/api/research", { task: "Is Ada Obi at risk?", level: "standard", salt: randomSalt() }));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(seen).toHaveLength(0);
  });

  it("takes no coins at all when the balance can't cover every piece", async () => {
    const { call, seen, wallet } = setup();
    await topUp(call, 300); // enough for one piece, not for four
    const events = await readEvents(await call("/api/research", { task: "Is Ada Obi at risk after the Lagos report?", level: "private", salt: randomSalt() }));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(seen).toHaveLength(0);
    expect(wallet.balance).toBe(300);
    const status = await (await call("/api/status")).json();
    expect(status.pendingCalls).toBe(0);
  });
});

describe("F01 compatibility privacy selection", () => {
  const request = (daemon: ReturnType<typeof setup>["daemon"], model: string, level?: string) => daemon(new Request("http://127.0.0.1:7878/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer zp-test-key", "content-type": "application/json", ...(level ? { "x-zireh-level": level } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Keep Ada Obi on this computer." }] }),
  }));

  it("honors zireh/local without contacting the relay", async () => {
    const { daemon, seen } = setup();
    const response = await request(daemon, "zireh/local");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: "zireh/local" });
    expect(seen).toHaveLength(0);
  });

  it("rejects conflicting levels, invalid headers and unknown models", async () => {
    const { daemon, seen } = setup();
    for (const [model, level] of [["zireh/local", "private"], ["zireh/local", "invalid"], ["zireh/unknown", undefined], ["unknown/model", undefined]] as const) {
      expect((await request(daemon, model, level)).status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("F02 private search", () => {
  it("never forwards a correctly detected lowercase name", async () => {
    const model = scriptedModel((m) => m[0]!.content.includes("general kind") ? '{"hints":{}}' : '{"entities":[{"text":"ada obi","kind":"person"}]}');
    const { call, searches } = setup(model);
    await topUp(call, 10000);
    const response = await call("/api/search", { query: "ada obi report", table: [] });
    expect(response.status).toBe(200);
    expect(searches).toEqual(["[PERSON_1] report"]);
  });
});

describe("F04 research cancellation", () => {
  const input = () => ({ task: "Is Ada Obi safe after the Lagos report?", context: [], level: "private" as const, table: [], salt: randomSalt(), model: MODEL });
  it("cancels during redaction without preparing or sending a paid call", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { entered = r; });
    const slow = { id: local.id, async chat(messages: readonly ChatMessage[], options: Parameters<typeof local.chat>[1]) { entered(); await gate; return local.chat(messages, options); } };
    const s = setup(slow);
    await topUp(s.call, 2_000_000);
    const controller = new AbortController();
    const events: ResearchEvent[] = [];
    const request = { ...input(), signal: controller.signal };
    const running = runResearch({ ...s, local: slow }, request, (e) => events.push(e));
    await started;
    controller.abort(); release();
    await running;
    expect(s.seen).toHaveLength(0);
    expect(s.relay.pending.list()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "cancelled", sent: 0, settled: 0 });
  });
  it("settles an already submitted piece and prevents later pieces from sending", async () => {
    const s = setup();
    await topUp(s.call, 2_000_000);
    const controller = new AbortController();
    const events: ResearchEvent[] = [];
    await runResearch({ ...s, local }, { ...input(), signal: controller.signal }, (e) => {
      events.push(e);
      if (e.type === "piece" && e.status === "sent") controller.abort();
    });
    expect(s.seen).toHaveLength(1);
    expect(s.relay.pending.list()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "cancelled", sent: 1, settled: 1 });
  });
});

describe("F04 daemon run controls", () => {
  it("announces a run id and cancels that run while keeping the event stream open", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ChatModel = { id: local.id, async chat(messages, options) { await gate; return local.chat(messages, options); } };
    const s = setup(slow);
    const response = await s.call("/api/research", { task: "Keep this on the device", level: "local", salt: randomSalt() });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const started = JSON.parse(first.trim().slice(6)) as { type: string; runId: string };
    expect(started.type).toBe("started");
    expect((await s.call(`/api/research/${started.runId}/cancel`, {})).status).toBe(200);
    release();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    const events = await readEvents(new Response(rest));
    expect(events.at(-1)).toMatchObject({ type: "cancelled", sent: 0 });
    expect(s.seen).toHaveLength(0);
    expect((await s.call(`/api/research/${started.runId}/cancel`, {})).status).toBe(404);
  });
});

describe("F12 whole-coin research funding", () => {
  it("settles every private piece using change from a single large coin", async () => {
    const s = setup();
    await topUp(s.call, 1_048_576);
    const events: ResearchEvent[] = [];
    await runResearch({ ...s, local }, { task: "Is Ada Obi safe in Lagos?", context: [], level: "private", table: [], salt: randomSalt(), model: MODEL }, (event) => events.push(event));
    expect(s.seen).toHaveLength(4);
    expect(events.filter((event) => event.type === "piece" && event.status === "answered")).toHaveLength(4);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(s.wallet.balance).toBe(1_048_576 - done.spent);
    expect(s.relay.pending.list()).toHaveLength(0);
  });
});
