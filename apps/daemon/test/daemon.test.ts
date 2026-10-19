import { randomSalt } from "@zireh/crypto";
import { RelayClient } from "@zireh/inference";
import { Ledger } from "@zireh/ledger";
import { scriptedModel } from "@zireh/llm";
import { createRelay, memoryResponseStore } from "@zireh/relay-core";
import type { ChatMessage, FetchLike } from "@zireh/schema";
import { directTransport } from "@zireh/tor";
import { generateMintKeys, memoryProofStore, memorySpentStore, Mint, Wallet } from "@zireh/wallet";
import { fixedRate, simulatedWatcher } from "@zireh/zcash";
import { describe, expect, it } from "vitest";
import { createDaemon } from "../src/api.ts";
import type { ResearchEvent } from "../src/research.ts";

const MODEL = "nemotron-cloud-test";
const ORIGIN = "http://127.0.0.1:7878";

/** Local model that answers each pipeline stage by recognizing its system prompt. */
const local = scriptedModel((messages: readonly ChatMessage[]) => {
  const sys = messages[0]!.content;
  const user = messages.at(-1)!.content;
  if (sys.includes("general kind of thing")) return JSON.stringify({ hints: {} });
  if (sys.includes("identifying details")) return JSON.stringify({ entities: [{ text: "Ada Obi", kind: "person" }, { text: "Lagos", kind: "place" }] });
  if (sys.includes("the user's request")) return JSON.stringify({ pieces: ["What risks do port reporters face?", "What press laws apply in [PLACE_1]?"] });
  if (sys.includes("You are an AI provider")) return JSON.stringify({ score: 10, inferences: [] });
  if (sys.includes("decoy questions")) return JSON.stringify({ decoys: ["How do bakers keep sourdough starters alive?", "Which trees survive coastal salt spray best?"] });
  if (sys.includes("combine answers")) return "[PERSON_1] faces moderate risk [A1]; [PLACE_1] law is weak [A2].";
  return `local: ${user}`;
}, "nemotron-3-nano:4b");

function setup() {
  const seen: string[] = []; // every user message that reached the cloud model
  const upstream = scriptedModel((messages) => {
    seen.push(messages.at(-1)!.content);
    return "an answer";
  });
  const relayHandler = createRelay({
    mint: new Mint(generateMintKeys(), memorySpentStore()),
    watcher: simulatedWatcher(fixedRate(50)),
    models: new Map([[MODEL, { upstream, price: { model: MODEL, inputPerMTok: 360_000, outputPerMTok: 1_080_000 } }]]),
    searchPrice: 1000,
    responses: memoryResponseStore(),
  });
  const relayFetch: FetchLike = (url, init) => relayHandler(new Request(url, init));
  const transport = directTransport(relayFetch);
  const wallet = new Wallet(memoryProofStore());
  const ledger = new Ledger();
  const daemon = createDaemon({
    local,
    relay: new RelayClient({ baseUrl: "http://relay.test", transport, wallet }),
    ledger,
    wallet,
    transport,
    syncUrl: "http://sync.test",
    torState: () => ({ ready: true, progress: 100 }),
    localModelOk: async () => true,
    allowedOrigins: [ORIGIN],
  });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    daemon(
      new Request(`http://127.0.0.1:7878${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-zireh": "1", origin: ORIGIN, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { call, seen, wallet, ledger, daemon };
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

  it("reports insufficient funds instead of sending", async () => {
    const { call, seen } = setup();
    const events = await readEvents(await call("/api/research", { task: "Is Ada Obi at risk?", level: "standard", salt: randomSalt() }));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(seen).toHaveLength(0);
  });
});
