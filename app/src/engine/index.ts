import { randomId } from "@zireh/crypto";
import { directTransport, newCircuitTag, RelayClient } from "@zireh/relay-client";
import { redactText, redactWithoutModel } from "@zireh/shield";
import { SyncClient, type Envelope } from "@zireh/sync";
import { InviteSyncHost, PrivacyLevel, Pseudonym, SyncHost, TopupQuote, type AppStatus, type LocalModelState, type ResearchEvent } from "@zireh/schema";
import { InsufficientFunds, Ledger, memoryLedgerStore, Wallet } from "@zireh/wallet";
import { z } from "zod";
import { localModel, unsupportedReason } from "../model/index.ts";
import { observePayments } from "./audit.ts";
import { runResearch } from "./research.ts";
import { browserLedgerStore, browserMoneyStore, memoryStorage } from "./stores.ts";

/**
 * Everything the old local daemon did, now in the page: the ecash wallet, the privacy log, the
 * privacy pipeline (with the on-device model) and calls to the Zireh host. The host is one
 * server for the relay and sync; set VITE_HOST_URL to use a deployed one.
 */
export const HOST_URL = SyncHost.parse(import.meta.env.VITE_HOST_URL ?? "http://127.0.0.1:8788");

/** A failure the UI shows as written; `code` keeps the relay's or host's error code. */
export class EngineError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "EngineError";
  }
}

const transport = directTransport();
// Outside a browser (tests) nothing persists.
const money = browserMoneyStore(typeof window === "undefined" ? memoryStorage() : localStorage);
const wallet = new Wallet(money);
const relay = new RelayClient({ baseUrl: HOST_URL, transport, wallet });
const ledgerReady = (typeof indexedDB === "undefined" ? Promise.resolve(memoryLedgerStore()) : browserLedgerStore()).then((store) => {
  const ledger = new Ledger(store);
  observePayments(relay, ledger);
  return ledger;
});
const local = localModel();

/**
 * One tab owns the wallet at a time, so two tabs never spend the same coin. A second tab waits
 * for the lock and takes over (re-reading the coins) when the first closes.
 */
let walletOwned = typeof navigator === "undefined" || !navigator.locks;
const walletReady: Promise<void> = walletOwned ? Promise.resolve() : new Promise((resolve) => {
  void navigator.locks.request("zireh-wallet", () => {
    money.reload();
    walletOwned = true;
    relay.discardUnsent();
    resolve();
    return new Promise<never>(() => {}); // held for the life of the tab
  });
});
/** Our own request is queued, not held, so a held lock means another tab has the wallet. */
const walletElsewhere = async () => !walletOwned && ((await navigator.locks.query()).held ?? []).some((lock) => lock.name === "zireh-wallet");
const ownWallet = async () => {
  if (await walletElsewhere()) throw new EngineError("Zireh is open in another tab. Close it to use the wallet here.", "wallet_busy");
  await walletReady;
};

/** Calls that never got a definite answer (crash, dropped connection) are re-sent with the same id. */
async function recoverPending() {
  if (!walletOwned) return;
  await ledgerReady;
  const { recovered, failed, topups } = await relay.recover().catch(() => ({ recovered: [], failed: [], topups: 0 }));
  if (recovered.length || failed.length || topups) console.info(`recovered ${recovered.length} call(s) and ${topups} top-up(s), ${failed.length} still failing`);
}
if (typeof window !== "undefined") {
  setInterval(() => void recoverPending(), 60_000);
  setTimeout(() => void recoverPending(), 5_000);
}

/* On-device model: nothing downloads until the user asks once; after that it starts with the page. */

const MODEL_PREF = "zireh:local-model";
let model: { state: LocalModelState; percent?: number; error?: string } = { state: "off" };

export async function startLocalModel(): Promise<void> {
  if (model.state === "loading" || model.state === "ready") return;
  const reason = await unsupportedReason();
  if (reason) {
    model = { state: "unsupported", error: reason };
    return;
  }
  try { localStorage.setItem(MODEL_PREF, "on"); } catch { /* the choice just isn't remembered */ }
  model = { state: "loading", percent: 0 };
  try {
    await local.load((percent) => { model = { state: "loading", percent }; });
    model = { state: "ready" };
  } catch (err) {
    model = { state: "failed", error: (err as Error).message };
  }
}

if (typeof window !== "undefined") {
  let wanted = false;
  try { wanted = localStorage.getItem(MODEL_PREF) === "on"; } catch { /* not remembered */ }
  if (wanted) void startLocalModel();
}

const localModelOk = async () => model.state === "ready";

/* What the UI calls. */

let relayCheck: { at: number; result: Promise<AppStatus["relay"]> } | undefined;

export async function status(): Promise<AppStatus> {
  // The UI polls often; the host is asked at most every 30 s, good answer or bad.
  if (!relayCheck || Date.now() - relayCheck.at > 30_000) {
    relayCheck = {
      at: Date.now(),
      result: relay.info(true).then(
        (info): AppStatus["relay"] => ({ ok: true, ...(info.upstreamOk !== undefined ? { upstreamOk: info.upstreamOk } : {}), network: info.network, models: info.prices.map((p) => p.model), search: info.searchEnabled }),
        (err: Error): AppStatus["relay"] => ({ ok: false, models: [], error: err.message }),
      ),
    };
  }
  return {
    localModel: { id: local.id, ok: model.state === "ready", ...model },
    relay: await relayCheck.result,
    balance: wallet.balance,
    pendingCalls: relay.pending.list().length,
    ...((await walletElsewhere()) ? { walletBusy: true } : {}),
  };
}

export const quote = async (credits: number) => {
  z.number().int().positive().max(100_000_000).parse(credits);
  return relay.quote(credits);
};
export const quoteStatus = (quoteId: string) => relay.quoteStatus(z.string().regex(/^[0-9a-f]{8,64}$/).parse(quoteId));
export const simulatePayment = async (quoteId: string) => { await relay.simulatePayment(quoteId); return { ok: true as const }; };
export async function redeem(q: TopupQuote): Promise<{ balance: number }> {
  await ownWallet();
  return { balance: await relay.redeemTopup(TopupQuote.parse(q)) };
}

export async function researchResults(caseId: string) {
  const completed = relay.completions().filter((entry) => entry.call.audit?.caseId === caseId);
  const results = completed.flatMap(({ call, outcome }) => {
    if (!("kind" in outcome) || outcome.kind !== "chat" || call.audit?.role === "decoy") return [];
    const runId = call.audit?.runId ?? call.requestId;
    const runSpent = completed.filter((entry) => (entry.call.audit?.runId ?? entry.call.requestId) === runId).reduce((total, entry) => total + entry.outcome.charged, 0);
    return [{ requestId: call.requestId, runId, pieceId: call.audit?.pieceId ?? call.requestId, question: call.messages?.at(-1)?.content ?? "Recovered question", content: outcome.content, answerExpired: outcome.answerExpired ?? false, charged: outcome.charged, runSpent }];
  });
  return { results };
}

export async function receipts(caseId?: string) {
  const ledger = await ledgerReady;
  return {
    receipts: ledger.receipts().filter((r) => !caseId || r.caseId === caseId),
    summary: ledger.summary(caseId),
    disputes: relay.pending.list().filter((call) => call.status === "disputed" && (!caseId || call.audit?.caseId === caseId)).map((call) => ({ requestId: call.requestId, ...(call.dispute ? { reason: call.dispute } : {}), amount: call.proofs.reduce((n, proof) => n + proof.amount, 0) })),
    writtenOff: relay.writtenOff().filter((entry) => !caseId || entry.call.audit?.caseId === caseId).map((entry) => ({ requestId: entry.call.requestId, ...(entry.call.dispute ? { reason: entry.call.dispute } : {}), amount: entry.amount, at: entry.at })),
  };
}

const disputed = (requestId: string) => {
  if (!relay.pending.list().some((call) => call.requestId === requestId && call.status === "disputed")) throw new EngineError("No unresolved dispute for this request", "not_found");
};
export async function retryDispute(requestId: string) {
  await ownWallet();
  disputed(requestId);
  await relay.retryDispute(requestId);
  return { ok: true as const };
}
export async function writeOffDispute(requestId: string) {
  await ownWallet();
  disputed(requestId);
  relay.writeOffDispute(requestId);
  return { ok: true as const };
}

/** Find identifying values in texts on this device, extending the case table. Nothing is sent. */
export async function redact(texts: string[], table: readonly Pseudonym[]): Promise<{ table: Pseudonym[] }> {
  z.array(z.string().max(20_000)).min(1).max(100).parse(texts);
  let next = z.array(Pseudonym).parse(table);
  const useModel = await localModelOk();
  for (const text of texts) if (text.trim()) next = (useModel ? await redactText(local, text, next) : redactWithoutModel(text, next)).table;
  (await ledgerReady).record({ destination: "local", role: "real", payload: `Local redaction of ${texts.length} text(s) for publishing` });
  return { table: next };
}

export async function search(query: string, table: readonly Pseudonym[], caseId?: string) {
  await ownWallet();
  await ledgerReady;
  const q = z.string().trim().min(2).max(400).parse(query);
  const red = (await localModelOk()) ? await redactText(local, q, table) : redactWithoutModel(q, table);
  const call = await relay.prepareSearch(red.text, 5, { role: "real", ...(caseId ? { caseId } : {}) });
  const result = await relay.send(call, newCircuitTag());
  if (result.kind !== "search") throw new Error("unexpected result kind");
  return { redactedQuery: red.text, hits: result.hits, table: red.table, charged: result.charged };
}

/* Sync: straight to the host (or the host named in an invite). */

const syncWith = (host?: string) => {
  if (host !== undefined && host !== HOST_URL && !InviteSyncHost.safeParse(host).success) throw new EngineError("Use a public HTTPS sync host or the configured one", "bad_request");
  return new SyncClient(host ?? HOST_URL, transport.fetchFor(newCircuitTag()));
};
export const syncConfig = async () => ({ host: HOST_URL });
export const push = (caseId: string, token: string, records: Envelope[], host?: string) => syncWith(host).push(caseId, token, records);
export const pull = (caseId: string, token: string, after: number, host?: string) => syncWith(host).pull(caseId, token, after);

/* Research runs. */

const ResearchInput = z.object({
  reviewBeforeSend: z.boolean().optional(),
  task: z.string().trim().min(3).max(4000),
  context: z.array(z.string().max(20_000)).max(20).default([]),
  level: PrivacyLevel,
  table: z.array(Pseudonym).max(500).default([]),
  salt: z.string().regex(/^[0-9a-f]{64}$/),
  model: z.string().optional(),
  caseId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  // Earlier turns of the thread: used on this device to make a follow-up stand alone, never sent.
  history: z.array(z.object({ question: z.string().max(4000), answer: z.string().max(8000) })).max(8).default([]),
});
export type ResearchInput = z.input<typeof ResearchInput>;

const activeRuns = new Map<string, AbortController>();
const approvals = new Map<string, () => void>();

async function cloudModel(requested?: string): Promise<string> {
  const { prices } = await relay.info();
  if (requested) {
    if (prices.some((p) => p.model === requested)) return requested;
    throw new EngineError(`unknown relay model: ${requested}`, "unknown_model");
  }
  if (!prices[0]) throw new EngineError("the relay offers no models");
  return prices[0].model;
}

/** Run a research question; events arrive as the pipeline progresses. */
export async function research(input: ResearchInput, onEvent: (e: ResearchEvent) => void, signal?: AbortSignal): Promise<void> {
  const body = ResearchInput.parse(input);
  if (body.level !== "local") await ownWallet();
  const ledger = await ledgerReady;
  const model = body.level === "local" ? local.id : await cloudModel(body.model);
  const runId = randomId();
  const cancellation = new AbortController();
  const needsReview = body.reviewBeforeSend ?? body.level === "paranoid";
  let approve!: () => void;
  const approval = new Promise<void>((resolve) => { approve = resolve; });
  const cancel = () => cancellation.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  activeRuns.set(runId, cancellation);
  try {
    await runResearch({ local, localModelOk, relay, ledger, wallet }, { ...body, model, runId, signal: cancellation.signal, ...(needsReview ? { waitForApproval: () => approval } : {}) }, (e) => {
      if (e.type === "prepared") approvals.set(runId, approve);
      onEvent(e);
    });
  } catch (err) {
    onEvent({ type: "error", message: (err as Error).message });
  } finally {
    activeRuns.delete(runId);
    approvals.delete(runId);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function sendResearch(runId: string) {
  const approveRun = approvals.get(runId);
  if (!approveRun) throw new EngineError("This run is not waiting for review", "conflict");
  approvals.delete(runId);
  approveRun();
  return { approved: true as const };
}

export async function cancelResearch(runId: string) {
  const controller = activeRuns.get(runId);
  if (!controller) throw new EngineError("unknown or completed run", "not_found");
  controller.abort();
  return { cancelled: true as const };
}

export { InsufficientFunds };
