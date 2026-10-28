import { observePayments } from "./audit.ts";
import { randomId } from "@zireh/crypto";
import { RelayCallError, type PendingCall, type RelayClient } from "@zireh/inference";
import type { Ledger } from "@zireh/ledger";
import type { ChatModel } from "@zireh/llm";
import type { PrivacyLevel, Pseudonym, ResearchEvent, TraceStep } from "@zireh/schema";

export type { ResearchEvent };
import { compile, finish, type Outcome, type Turn } from "@zireh/shield";
import { newCircuitTag } from "@zireh/tor";
import { InsufficientFunds, maxCost, type Wallet } from "@zireh/wallet";

export interface ResearchRequest {
  readonly signal?: AbortSignal;
  readonly waitForApproval?: () => Promise<void>;
  readonly runId?: string;
  readonly task: string;
  readonly context: readonly string[];
  readonly level: PrivacyLevel;
  readonly table: readonly Pseudonym[];
  readonly salt: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly caseId?: string | undefined; // for the local privacy log only
  readonly history?: readonly Turn[]; // earlier turns of the thread; stay on this computer
}

const RETRIES = 4;
/** Four circuits at once avoids the rendezvous failures seen with unbounded fan-out. */
const CONCURRENCY = 4;
export const SEND_JITTER_MS = 3000;

/** Independent CSPRNG jitter; cancellation wakes sleeping, unsent workers immediately. */
function jitter(signal?: AbortSignal): Promise<void> {
  const random = crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, 1 + Math.floor(random * SEND_JITTER_MS));
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

/** Run tasks with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
}

/**
 * One research question, end to end: compile locally, send every piece (real and decoy) on its
 * own circuit and paid with its own coins, then reassemble locally. Fails closed: if anything
 * before sending fails, nothing is sent.
 */
export async function runResearch(
  deps: { local: ChatModel; localModelOk?: () => Promise<boolean>; relay: RelayClient; ledger: Ledger; wallet: Wallet; transport?: { readonly kind: "tor" | "direct" } },
  req: ResearchRequest,
  emit: (e: ResearchEvent) => void,
): Promise<void> {
  observePayments(deps.relay, deps.ledger);
  const started = Date.now();
  const runId = req.runId ?? randomId();
  const submitted = new Set<string>();
  const settled = new Set<string>();
  const answers = new Map<string, string>();
  const realIds = new Set<string>();
  let table: readonly Pseudonym[] = req.table;
  let spent = 0;
  emit({ type: "started", runId });
  const cancelled = () => emit({ type: "cancelled", runId, sent: submitted.size, settled: settled.size, answers: [...answers].filter(([id]) => realIds.has(id)).map(([id, answer]) => ({ id, answer })), table, spent, ms: Date.now() - started });
  try {
    req.signal?.throwIfAborted();
    const onStep = (step: TraceStep) => emit({ type: "step", step, atMs: Date.now() - started });
    // On-device AI is optional: without it the pipeline hides by pattern and sends one plain question.
    const local = deps.localModelOk && !(await deps.localModelOk()) ? undefined : deps.local;
    const plan = await compile(local, { task: req.task, context: req.context, level: req.level, table: req.table, salt: req.salt, ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}), ...(req.history?.length ? { history: req.history } : {}) }, {
      onStep,
      ...(req.signal ? { signal: req.signal } : {}),
      onRedacted: (nextTable) => { table = nextTable; emit({ type: "redacted", table }); },
    });

    table = plan.table;
    for (const piece of plan.pieces) if (piece.role === "real") realIds.add(piece.id);
    req.signal?.throwIfAborted();
    emit({
      type: "plan",
      table: plan.table,
      pieces: plan.pieces.map((p) => ({ id: p.id, role: p.role, question: p.question, messages: p.messages, wire: p.messages.at(-1)!.content, ...(p.leakScore !== undefined ? { leakScore: p.leakScore } : {}) })),
      blocked: plan.blocked.map((b) => ({ question: b.question, score: b.report.score, inferences: b.report.inferences })),
    });

    if (plan.localAnswer !== undefined) {
      deps.ledger.record({ destination: "local", role: "real", payload: req.task, ...(req.caseId ? { caseId: req.caseId } : {}) });
      const outcome = await finish(local, plan, new Map(), onStep, req.signal);
      emit({ type: "done", outcome: { answer: outcome.answer, redactedAnswer: outcome.redactedAnswer, citations: outcome.citations }, table: plan.table, spent: 0, ms: Date.now() - started });
      return;
    }
    if (plan.pieces.length === 0) throw new Error("every piece was blocked by the leak check; nothing was sent");

    const price = await deps.relay.priceOf(req.model);
    // All or nothing: never take coins for some pieces and then run out, which would leave
    // half a plan pending (and later re-sent by recovery) without the user expecting it.
    const needed = plan.pieces.reduce((n, p) => n + maxCost(price, p.messages, p.maxTokens), 0);
    if (deps.wallet.balance < needed) throw new InsufficientFunds(needed, deps.wallet.balance);
    if (req.waitForApproval) {
      emit({ type: "prepared", runId, estimatedCost: needed });
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { cleanup(); reject(req.signal?.reason ?? new Error("Cancelled")); };
        const cleanup = () => req.signal?.removeEventListener("abort", aborted);
        if (req.signal?.aborted) { aborted(); return; }
        req.signal?.addEventListener("abort", aborted, { once: true });
        req.waitForApproval!().then(() => { cleanup(); resolve(); }, (error: unknown) => { cleanup(); reject(error); });
      });
      req.signal?.throwIfAborted();
      if (deps.wallet.balance < needed) throw new InsufficientFunds(needed, deps.wallet.balance);
    }

    const calls = await deps.relay.prepareChats(req.model, plan.pieces.map((piece) => ({
      messages: piece.messages, maxTokens: piece.maxTokens,
      audit: { role: piece.role, pieceId: piece.id, runId, ...(req.caseId ? { caseId: req.caseId } : {}) },
    })));
    const unsent = new Set(calls);
    try {
      await pool(
        plan.pieces.map((piece, index) => ({ piece, call: calls[index]! })),
        CONCURRENCY,
        async ({ piece, call }) => {
        await jitter(req.signal);
        if (req.signal?.aborted) return;
        unsent.delete(call);
        deps.ledger.startRun(call.requestId, piece.id, maxCost(price, piece.messages, piece.maxTokens));
        for (let attempt = 0; attempt <= RETRIES; attempt++) {
          const circuit = newCircuitTag(); // a dropped circuit is replaced, never reused
          const t0 = Date.now();
          submitted.add(piece.id);
          emit({ type: "piece", id: piece.id, status: "sent", circuit });
          try {
            if (attempt === 0) deps.ledger.advance(call.requestId, "submitted");
            const result = await deps.relay.send(call, circuit);
            if (result.kind !== "chat") throw new Error("unexpected result kind");
            deps.ledger.advance(call.requestId, "settled", { charged: result.charged, usage: result.usage });
            spent += result.charged;
            settled.add(piece.id);
            answers.set(piece.id, result.content);
            emit({ type: "piece", id: piece.id, status: "answered", circuit, ms: Date.now() - t0, charged: result.charged });
            return;
          } catch (err) {
            const retryable = err instanceof RelayCallError && err.retryable && err.code !== "settlement_disputed";
            if (retryable && attempt < RETRIES) {
              if (attempt === 0) deps.ledger.advance(call.requestId, "submission-unknown");
              await new Promise((r) => setTimeout(r, 750 * (attempt + 1))); // let Tor settle
              continue; // same requestId, new circuit: the relay answers from its store if it already ran
            }
            deps.ledger.advance(call.requestId, "failed", { error: (err as Error).message });
            emit({ type: "piece", id: piece.id, status: "failed", circuit, error: (err as Error).message });
            return;
          }
        }
      },
      );
    } finally {
      for (const call of unsent) deps.relay.discardPrepared(call);
    }

    // Say what actually went over the network, and how: Tor circuits or a plain connection.
    const failed = plan.pieces.length - settled.size;
    onStep({
      stage: "send",
      title: `Sent ${submitted.size} request${submitted.size === 1 ? "" : "s"}`,
      detail: [
        deps.transport?.kind === "direct" ? "Over a direct connection, not Tor: the relay could see this computer's address." : "Each on its own Tor circuit, paid with separate coins.",
        `${settled.size} answered${failed ? `, ${failed} failed or not sent` : ""}.`,
      ].join(" "),
    });
    if (req.signal?.aborted) { cancelled(); return; }
    const outcome = await finish(local, plan, answers, onStep, req.signal);
    emit({
      type: "done",
      outcome: { answer: outcome.answer, redactedAnswer: outcome.redactedAnswer, citations: outcome.citations },
      table: plan.table,
      spent,
      ms: Date.now() - started,
    });
  } catch (err) {
    if (req.signal?.aborted) cancelled();
    else throw err;
  }
}
