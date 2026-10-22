import { randomId } from "@zireh/crypto";
import { RelayCallError, type RelayClient } from "@zireh/inference";
import type { Ledger } from "@zireh/ledger";
import type { ChatModel } from "@zireh/llm";
import type { PrivacyLevel, Pseudonym, ResearchEvent, TraceStep } from "@zireh/schema";

export type { ResearchEvent };
import { compile, finish, type Outcome } from "@zireh/shield";
import { newCircuitTag } from "@zireh/tor";
import { InsufficientFunds, maxCost, type Wallet } from "@zireh/wallet";

export interface ResearchRequest {
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly task: string;
  readonly context: readonly string[];
  readonly level: PrivacyLevel;
  readonly table: readonly Pseudonym[];
  readonly salt: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly caseId?: string | undefined; // for the local privacy log only
}

const RETRIES = 4;
/** Concurrent sends. Many brand-new circuits to one onion service at once tend to fail. */
const CONCURRENCY = 4;

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
  deps: { local: ChatModel; relay: RelayClient; ledger: Ledger; wallet: Wallet },
  req: ResearchRequest,
  emit: (e: ResearchEvent) => void,
): Promise<void> {
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
    const plan = await compile(deps.local, { task: req.task, context: req.context, level: req.level, table: req.table, salt: req.salt, ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}) }, {
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
      pieces: plan.pieces.map((p) => ({ id: p.id, role: p.role, question: p.question, wire: p.messages.at(-1)!.content, ...(p.leakScore !== undefined ? { leakScore: p.leakScore } : {}) })),
      blocked: plan.blocked.map((b) => ({ question: b.question, score: b.report.score, inferences: b.report.inferences })),
    });

    if (plan.localAnswer !== undefined) {
      deps.ledger.record({ destination: "local", role: "real", payload: req.task, ...(req.caseId ? { caseId: req.caseId } : {}) });
      const outcome = await finish(deps.local, plan, new Map(), onStep, req.signal);
      emit({ type: "done", outcome: { answer: outcome.answer, redactedAnswer: outcome.redactedAnswer, citations: outcome.citations }, table: plan.table, spent: 0, ms: Date.now() - started });
      return;
    }
    if (plan.pieces.length === 0) throw new Error("every piece was blocked by the leak check; nothing was sent");

    const price = await deps.relay.priceOf(req.model);
    // All or nothing: never take coins for some pieces and then run out, which would leave
    // half a plan pending (and later re-sent by recovery) without the user expecting it.
    const needed = plan.pieces.reduce((n, p) => n + maxCost(price, p.messages, p.maxTokens), 0);
    if (deps.wallet.balance < needed) throw new InsufficientFunds(needed, deps.wallet.balance);

    await pool(
      plan.pieces,
      CONCURRENCY,
      async (piece) => {
        if (req.signal?.aborted) return;
        const call = await deps.relay.prepareChat(req.model, piece.messages, piece.maxTokens);
        if (req.signal?.aborted) { deps.relay.discardPrepared(call); return; }
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
            deps.ledger.record({
              destination: "relay",
              role: piece.role,
              ...(req.caseId ? { caseId: req.caseId } : {}),
              payload: piece.messages,
              circuit,
              charged: result.charged,
              expectedCharge: result.bill.expected,
              overcharged: result.bill.overcharged,
            });
            spent += result.charged;
            settled.add(piece.id);
            answers.set(piece.id, result.content);
            emit({ type: "piece", id: piece.id, status: "answered", circuit, ms: Date.now() - t0, charged: result.charged });
            return;
          } catch (err) {
            const retryable = err instanceof RelayCallError && err.retryable;
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

    if (req.signal?.aborted) { cancelled(); return; }
    const outcome = await finish(deps.local, plan, answers, onStep, req.signal);
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
