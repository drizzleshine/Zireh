import { randomId } from "@zireh/crypto";
import {
  ChatPaidResponse,
  MintResponse,
  RelayError,
  RelayInfo,
  SearchPaidResponse,
  SwapRequest,
  QuoteStatus,
  TopupQuote,
  type ChatMessage,
  type FetchLike,
  type Keyset,
  type ModelPrice,
  type Proof,
  type SearchHit,
  type Settlement,
  type Usage,
} from "@zireh/schema";
import { newCircuitTag, type Transport } from "./transport.ts";
import { checkBill, checkSettlement, InsufficientFunds, prepareOutputs, splitAmount, maxCost, prepareChange, prepareTopup, sum, unblindAll, type BillCheck, type PendingOutputs, type Wallet, type MoneyStore } from "@zireh/wallet";
import { z } from "zod";

/** Everything needed to send (or re-send) one paid call. Persisted before the first send. */
export interface PendingCall {
  readonly requestId: string;
  readonly audit?: { readonly role: "real" | "decoy"; readonly caseId?: string; readonly runId?: string; readonly pieceId?: string };
  readonly status?: "reserved" | "disputed" | "settlement-pending";
  readonly dispute?: string;
  readonly attempts?: number;
  readonly nextRetryAt?: number;
  readonly maxCharge?: number;
  readonly kind: "chat" | "search";
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly proofs: readonly Proof[];
  readonly blanks: PendingOutputs;
  readonly keyset: Keyset;
  readonly price?: ModelPrice;
  readonly messages?: readonly ChatMessage[];
}

interface PendingSwap {
  readonly requestId: string;
  readonly keyset: Keyset;
  readonly outputs: PendingOutputs;
  readonly body: z.infer<typeof SwapRequest>;
}

export interface PendingStore {
  readonly money: MoneyStore;
  save(call: PendingCall): void;
  remove(requestId: string): void;
  list(): PendingCall[];
}

export function moneyPendingStore(money: MoneyStore): PendingStore {
  return {
    money,
    save: (call) => money.put(`call:${call.requestId}`, call),
    remove: (id) => money.remove(`call:${id}`),
    list: () => money.list<PendingCall>("call:"),
  };
}


export type CallResult =
  | { readonly answerExpired?: boolean; readonly kind: "chat"; readonly requestId: string; readonly content: string; readonly model: string; readonly usage: Usage; readonly charged: number; readonly bill: BillCheck }
  | { readonly answerExpired?: boolean; readonly kind: "search"; readonly requestId: string; readonly hits: SearchHit[]; readonly charged: number };

export interface RelayObserver {
  attempt(call: PendingCall, circuit: string): void;
  result(call: PendingCall, result: CallResult, recovered: boolean): void;
  failure(call: PendingCall, error: Error, charged?: number): void;
  writtenOff?(call: PendingCall, amount: number): void;
}
export interface WrittenOff {
  readonly call: PendingCall;
  readonly amount: number;
  readonly at: number;
  readonly reported: boolean;
}

export interface Completion {
  readonly call: PendingCall;
  readonly outcome: CallResult | { error: string; charged: number };
  readonly reported: boolean;
}

export class RelayCallError extends Error {
  constructor(
    readonly code: RelayError["error"] | "network" | "settlement_disputed",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RelayCallError";
  }
}

/** Errors where the relay rejected the call before burning any coin. */
const NOT_BURNED = new Set<string>(["bad_request", "insufficient_funds", "unknown_model", "not_found", "quote_unpaid", "limit_exceeded"]);

export interface RelayClientOptions {
  readonly baseUrl: string;
  readonly transport: Transport;
  readonly wallet: Wallet;
  readonly pending?: PendingStore;
  readonly now?: () => number;
}

/**
 * Pays the relay with ecash, each call with its own coins and tag. A call is persisted
 * before it is sent and re-sent with the same requestId after a failure, so a dropped
 * connection never means paying twice or losing change.
 */
export class RelayClient {
  private observer: RelayObserver | undefined;
  private readonly active = new Map<string, Promise<CallResult>>();
  observe(observer: RelayObserver): void { this.observer = observer; }

  private infoCache: RelayInfo | undefined;
  readonly pending: PendingStore;

  constructor(private readonly options: RelayClientOptions) {
    this.pending = options.pending ?? moneyPendingStore(options.wallet.money);
    if (this.pending.money !== options.wallet.money) throw new Error("wallet and pending calls must share one transactional money store");
  }

  get transportKind(): Transport["kind"] {
    return this.options.transport.kind;
  }

  private url(path: string) {
    return `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async request<S extends z.ZodType>(fetchFn: FetchLike, path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await fetchFn(this.url(path), body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (err) {
      throw new RelayCallError("network", `relay unreachable: ${(err as Error).message}`, true);
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const parsed = RelayError.safeParse(json);
      if (!parsed.success) throw new RelayCallError("network", `relay returned HTTP ${res.status}`, res.status >= 500);
      throw Object.assign(new RelayCallError(parsed.data.error, parsed.data.message, false), { settlement: parsed.data.settlement });
    }
    return schema.parse(json);
  }

  /** Relay keys and prices, fetched over a fresh circuit. */
  async info(refresh = false): Promise<RelayInfo> {
    if (!this.infoCache || refresh) this.infoCache = await this.request(this.options.transport.fetchFor(newCircuitTag()), "/v1/info", RelayInfo);
    return this.infoCache;
  }

  async priceOf(model: string): Promise<ModelPrice> {
    const price = (await this.info()).prices.find((p) => p.model === model);
    if (!price) throw new RelayCallError("unknown_model", `relay does not sell ${model}`, false);
    return price;
  }

  quote(credits: number): Promise<TopupQuote> {
    return this.request(this.options.transport.fetchFor(newCircuitTag()), "/v1/topup/quote", TopupQuote, { credits });
  }

  /** Where a top-up's payment stands: quoted, paid (seen), confirmed, minted or expired. */
  quoteStatus(quoteId: string): Promise<QuoteStatus> {
    return this.request(this.options.transport.fetchFor(newCircuitTag()), `/v1/topup/state?quoteId=${encodeURIComponent(quoteId)}`, QuoteStatus);
  }

  /** Simulated networks only: ask the relay to mark the quote as paid (demo top-ups). */
  async simulatePayment(quoteId: string): Promise<void> {
    await this.request(this.options.transport.fetchFor(newCircuitTag()), "/v1/topup/simulate", z.object({ state: z.string() }), { quoteId });
  }

  /** After paying the quote: persist blinding secrets before minting, then commit the coins once. */
  async redeemTopup(quote: TopupQuote): Promise<number> {
    const money = this.options.wallet.money;
    const key = `topup:${quote.quoteId}`;
    if (money.get(`minted:${quote.quoteId}`)) return this.options.wallet.balance;
    const { keyset } = await this.info();
    const pending = money.atomically(() => {
      if (money.get(`minted:${quote.quoteId}`)) return undefined;
      const saved = money.get<{ quote: TopupQuote; keyset: Keyset; outputs: PendingOutputs }>(key);
      if (saved) return saved;
      const created = { quote, keyset, outputs: prepareTopup(keyset, quote.credits) };
      money.put(key, created);
      return created;
    });
    if (!pending) return this.options.wallet.balance;
    const { signatures } = await this.request(this.options.transport.fetchFor(newCircuitTag()), "/v1/topup/mint", MintResponse,
      { quoteId: quote.quoteId, outputs: pending.outputs.outputs });
    if (signatures.length !== pending.outputs.outputs.length || signatures.some((signature, i) => signature.keysetId !== pending.keyset.id || signature.amount !== pending.outputs.outputs[i]!.amount)) {
      throw new RelayCallError("settlement_disputed", "Top-up signatures do not match the saved outputs", true);
    }
    const proofs = unblindAll(pending.keyset, pending.outputs, signatures);
    money.atomically(() => {
      if (!money.get(key)) return;
      this.options.wallet.add(proofs);
      money.put(`minted:${quote.quoteId}`, { credits: pending.quote.credits });
      money.remove(key);
    });
    return this.options.wallet.balance;
  }

  /** Exchange enough coins into exact independent holds plus untouched-value change. */
  async swap(amounts: readonly number[]): Promise<void> {
    if (!amounts.length || amounts.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error("invalid swap amounts");
    const { keyset } = await this.info();
    const money = this.options.wallet.money;
    const pending = money.atomically(() => {
      const proofs = this.options.wallet.take(amounts.reduce((n, a) => n + a, 0));
      const outputs = prepareOutputs(keyset, [...amounts.flatMap(splitAmount), ...splitAmount(sum(proofs) - amounts.reduce((n, a) => n + a, 0))]);
      const requestId = randomId();
      const body = SwapRequest.parse({ requestId, proofs, outputs: outputs.outputs });
      const saved = { requestId, keyset, outputs, body } satisfies PendingSwap;
      money.put(`swap:${requestId}`, saved);
      return saved;
    });
    await this.redeemSwap(pending);
  }

  private async redeemSwap(pending: PendingSwap): Promise<void> {
    const money = this.options.wallet.money;
    let signatures: z.infer<typeof MintResponse>["signatures"];
    try {
      ({ signatures } = await this.request(this.options.transport.fetchFor(newCircuitTag()), "/v1/swap", MintResponse, pending.body));
    } catch (error) {
      if (error instanceof RelayCallError && NOT_BURNED.has(error.code)) money.atomically(() => {
        if (!money.get(`swap:${pending.requestId}`)) return;
        this.options.wallet.add(pending.body.proofs);
        money.remove(`swap:${pending.requestId}`);
      });
      throw error;
    }
    if (signatures.length !== pending.outputs.outputs.length || signatures.some((sig, i) => sig.keysetId !== pending.keyset.id || sig.amount !== pending.outputs.outputs[i]!.amount)) {
      throw new RelayCallError("settlement_disputed", "Swap signatures do not match the saved outputs", true);
    }
    const proofs = unblindAll(pending.keyset, pending.outputs, signatures);
    money.atomically(() => {
      if (!money.get(`swap:${pending.requestId}`)) return;
      this.options.wallet.add(proofs);
      money.put(`swapped:${pending.requestId}`, { amount: sum(proofs) });
      money.remove(`swap:${pending.requestId}`);
    });
  }

  /** Reserve the entire plan atomically. A denomination shortage triggers one zero-fee swap. */
  async prepareChats(model: string, pieces: readonly { messages: readonly ChatMessage[]; maxTokens: number; audit?: PendingCall["audit"] }[]): Promise<PendingCall[]> {
    const [price, { keyset }] = await Promise.all([this.priceOf(model), this.info()]);
    const holds = pieces.map((p) => maxCost(price, p.messages, p.maxTokens));
    const needed = holds.reduce((n, a) => n + a, 0);
    if (this.options.wallet.balance < needed) throw new InsufficientFunds(needed, this.options.wallet.balance);
    const allocate = () => this.options.wallet.money.atomically(() => pieces.map((p, i) => this.prepare("chat", "/v1/chat", keyset, holds[i]!, (requestId, proofs, blanks) => ({
      requestId, request: { model, messages: p.messages, max_tokens: p.maxTokens }, proofs, changeOutputs: blanks.outputs,
    }), { price, messages: p.messages, ...(p.audit ? { audit: p.audit } : {}) }, true)));
    try { return allocate(); }
    catch (error) {
      if (!(error instanceof InsufficientFunds)) throw error;
      await this.swap(holds);
      return allocate();
    }
  }

  /** Startup only: these reservations were never submitted and must never be recovered as sends. */
  discardUnsent(): void {
    for (const call of this.pending.list()) if (call.status === "reserved") this.discardPrepared(call);
  }

  /** Take coins for the worst case and persist the call. Nothing has left the device yet. */
  async prepareChat(model: string, messages: readonly ChatMessage[], maxTokens: number, audit?: PendingCall["audit"]): Promise<PendingCall> {
    const [price, { keyset }] = await Promise.all([this.priceOf(model), this.info()]);
    return this.prepare("chat", "/v1/chat", keyset, maxCost(price, messages, maxTokens), (requestId, proofs, blanks) => ({
      requestId,
      request: { model, messages, max_tokens: maxTokens },
      proofs,
      changeOutputs: blanks.outputs,
    }), { price, messages, ...(audit ? { audit } : {}) });
  }

  async prepareSearch(query: string, maxResults: number, audit?: PendingCall["audit"]): Promise<PendingCall> {
    const { keyset, searchPrice } = await this.info();
    return this.prepare("search", "/v1/search", keyset, searchPrice, (requestId, proofs, blanks) => ({
      requestId,
      query,
      maxResults,
      proofs,
      changeOutputs: blanks.outputs,
    }), audit ? { audit } : {});
  }

  private prepare(
    kind: PendingCall["kind"],
    path: string,
    keyset: Keyset,
    hold: number,
    body: (requestId: string, proofs: Proof[], blanks: PendingOutputs) => Record<string, unknown>,
    extra: Pick<PendingCall, "price" | "messages" | "audit"> = {},
    reserved = false,
  ): PendingCall {
    return this.options.wallet.money.atomically(() => {
      const proofs = this.options.wallet.take(hold);
      const blanks = prepareChange(keyset, sum(proofs));
      const requestId = randomId();
      const call: PendingCall = { requestId, maxCharge: hold, kind, path, proofs, blanks, keyset, body: body(requestId, proofs, blanks), ...(reserved ? { status: "reserved" as const } : {}), ...extra };
      this.pending.save(call);
      return call;
    });
  }

  /** Send (or re-send) a prepared call on the given circuit. Idempotent per requestId. */
  discardPrepared(call: PendingCall): void {
    if (!this.pending.list().some((c) => c.requestId === call.requestId)) return;
    this.options.wallet.money.atomically(() => {
      this.options.wallet.add(call.proofs);
      this.pending.remove(call.requestId);
    });
  }

  send(call: PendingCall, circuitTag: string = newCircuitTag(), recovered = false): Promise<CallResult> {
    const running = this.active.get(call.requestId);
    if (running) return running;
    const promise = this.sendOnce(call, circuitTag, recovered).finally(() => this.active.delete(call.requestId));
    this.active.set(call.requestId, promise);
    return promise;
  }

  private async sendOnce(call: PendingCall, circuitTag: string, recovered: boolean): Promise<CallResult> {
    if (this.options.wallet.money.get(`written-off:${call.requestId}`)) throw new Error("This request was written off; it cannot be resent");
    const completed = this.options.wallet.money.get<Completion>(`completion:${call.requestId}`);
    if (completed) {
      this.notifyCompletion(call.requestId, recovered);
      await this.acknowledge(call.requestId);
      if ("kind" in completed.outcome) return completed.outcome;
      throw new RelayCallError("upstream_error", completed.outcome.error, false);
    }
    if (call.status === "reserved") {
      if (!this.pending.list().some((saved) => saved.requestId === call.requestId)) throw new Error("reservation was released");
      call = { ...call, status: "settlement-pending" };
      this.pending.save(call); // durable submission intent before any network activity
    }
    const fetchFn = this.options.transport.fetchFor(circuitTag);
    try {
      this.observer?.attempt(call, circuitTag);
      if (call.kind === "chat") {
        const res = await this.request(fetchFn, call.path, ChatPaidResponse, call.body);
        const bill = checkBill(call.price!, call.messages!, res.answerExpired ? undefined : res.content, res.settlement.usage, res.settlement.charged, (call.body.request as { max_tokens: number }).max_tokens);
        const result: CallResult = { answerExpired: res.answerExpired ?? false, kind: "chat", requestId: call.requestId, content: res.content, model: res.model, usage: res.settlement.usage, charged: res.settlement.charged, bill };
        this.settle(call, res.settlement, result);
        this.notifyCompletion(call.requestId, recovered);
        await this.acknowledge(call.requestId);
        return result;
      }
      const res = await this.request(fetchFn, call.path, SearchPaidResponse, call.body);
      const result: CallResult = { answerExpired: res.answerExpired ?? false, kind: "search", requestId: call.requestId, hits: res.hits, charged: res.settlement.charged };
      this.settle(call, res.settlement, result);
      this.notifyCompletion(call.requestId, recovered);
      await this.acknowledge(call.requestId);
      return result;
    } catch (err) {
      if (err instanceof z.ZodError) {
        const reason = "Settlement disputed: the relay returned a malformed response";
        this.pending.save({ ...call, status: "disputed", dispute: reason });
        this.observer?.failure(call, new Error(reason));
        throw new RelayCallError("settlement_disputed", reason, true);
      }
      if (err instanceof RelayCallError && !err.retryable) {
        const settlement = (err as RelayCallError & { settlement?: Settlement }).settlement;
        if (settlement) { this.settle(call, settlement, { error: err.message, charged: settlement.charged }); this.notifyCompletion(call.requestId, recovered); await this.acknowledge(call.requestId); }
        else if (NOT_BURNED.has(err.code)) {
          this.options.wallet.money.atomically(() => {
            this.options.wallet.add(call.proofs);
            this.pending.remove(call.requestId);
          });
        } else if (this.pending.list().some((pending) => pending.requestId === call.requestId)) {
          this.pending.save({ ...call, status: "settlement-pending" });
        }
      }
      const saved = this.pending.list().find((pending) => pending.requestId === call.requestId);
      if (saved && saved.status !== "disputed") {
        const attempts = (saved.attempts ?? 0) + 1;
        const delay = Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts - 1, 6));
        this.pending.save({ ...saved, attempts, nextRetryAt: (this.options.now ?? Date.now)() + delay });
      }
      this.observer?.failure(call, err as Error);
      throw err; // retryable errors keep the call pending for `recover`
    }
  }

  /** A disputed settlement is only rechecked by this explicit, single-send action. */
  async retryDispute(requestId: string): Promise<CallResult> {
    const call = this.pending.list().find((pending) => pending.requestId === requestId && pending.status === "disputed");
    if (!call) throw new RelayCallError("not_found", "No unresolved dispute for this request", false);
    return this.send(call);
  }

  /** Accept the full locked stake as a loss, retaining evidence without returning spent coins. */
  writeOffDispute(requestId: string): void {
    if (this.active.has(requestId)) throw new Error("Wait for the manual re-check to finish");
    const money = this.options.wallet.money;
    money.atomically(() => {
      const call = this.pending.list().find((pending) => pending.requestId === requestId && pending.status === "disputed");
      if (!call) throw new RelayCallError("not_found", "No unresolved dispute for this request", false);
      money.put(`written-off:${requestId}`, { call, amount: sum(call.proofs), at: (this.options.now ?? Date.now)(), reported: false } satisfies WrittenOff);
      this.pending.remove(requestId);
    });
    this.notifyWrittenOff(requestId);
  }

  writtenOff(): WrittenOff[] { return this.options.wallet.money.list<WrittenOff>("written-off:"); }

  private notifyWrittenOff(requestId: string): void {
    const key = `written-off:${requestId}`;
    const entry = this.options.wallet.money.get<WrittenOff>(key);
    if (!entry || entry.reported || !this.observer?.writtenOff) return;
    this.observer.writtenOff(entry.call, entry.amount);
    this.options.wallet.money.put(key, { ...entry, reported: true });
  }

  /** Credit change once: only a call that is still pending can be settled. */
  private settle(call: PendingCall, settlement: Settlement, outcome: Completion["outcome"]) {
    if (!this.pending.list().some((c) => c.requestId === call.requestId)) return;
    const audit = checkSettlement(call.requestId, sum(call.proofs), call.maxCharge ?? sum(call.proofs), call.blanks.outputs.length, call.keyset.id, settlement);
    let change: Proof[];
    try {
      if (audit.overcharged) throw new Error(audit.reason);
      change = unblindAll(call.keyset, call.blanks, settlement.change);
    } catch (error) {
      const reason = `Settlement disputed: ${(error as Error).message}`;
      this.pending.save({ ...call, status: "disputed", dispute: reason });
      throw new RelayCallError("settlement_disputed", reason, true);
    }
    this.options.wallet.money.atomically(() => {
      this.options.wallet.add(change);
      this.options.wallet.money.put(`completion:${call.requestId}`, { call, outcome, reported: false } satisfies Completion);
      this.options.wallet.money.put(`ack:${call.requestId}`, { requestId: call.requestId });
      this.pending.remove(call.requestId);
    });
  }

  private notifyCompletion(requestId: string, recovered: boolean): void {
    const key = `completion:${requestId}`;
    const completion = this.options.wallet.money.get<Completion>(key);
    if (!this.observer || !completion || completion.reported) return;
    if ("kind" in completion.outcome) this.observer.result(completion.call, completion.outcome, recovered);
    else this.observer.failure(completion.call, new Error(completion.outcome.error), completion.outcome.charged);
    this.options.wallet.money.put(key, { ...completion, reported: true });
  }

  completions(): Completion[] { return this.options.wallet.money.list<Completion>("completion:"); }

  private async acknowledge(requestId: string): Promise<void> {
    if (!this.options.wallet.money.get(`ack:${requestId}`)) return;
    try {
      await this.request(this.options.transport.fetchFor(newCircuitTag()), "/v1/settlement/ack", z.object({ ok: z.literal(true) }), { requestId });
      this.options.wallet.money.remove(`ack:${requestId}`);
    } catch { /* Coins are already committed; retry the durable acknowledgement later. */ }
  }

  /** Re-send every call that never got a definite answer (e.g. after a crash or dropped circuit). */
  async recover(): Promise<{ recovered: CallResult[]; failed: RelayCallError[]; topups: number }> {
    const recovered: CallResult[] = [];
    const failed: RelayCallError[] = [];
    let topups = 0;
    for (const entry of this.writtenOff()) this.notifyWrittenOff(entry.call.requestId);
    for (const completion of this.completions()) {
      if (!completion.reported) this.notifyCompletion(completion.call.requestId, true);
    }
    for (const pending of this.options.wallet.money.list<{ quote: TopupQuote }>("topup:")) {
      try { await this.redeemTopup(pending.quote); topups++; }
      catch (error) { if (error instanceof RelayCallError) failed.push(error); else throw error; }
    }
    for (const swap of this.options.wallet.money.list<PendingSwap>("swap:")) {
      try { await this.redeemSwap(swap); }
      catch (error) { if (error instanceof RelayCallError) failed.push(error); else throw error; }
    }
    for (const call of this.pending.list()) {
      if (call.status === "reserved" || call.status === "disputed" || (call.nextRetryAt ?? 0) > (this.options.now ?? Date.now)() || this.active.has(call.requestId)) continue;
      try {
        recovered.push(await this.send(call, newCircuitTag(), true));
      } catch (err) {
        if (err instanceof RelayCallError) failed.push(err);
        else throw err;
      }
    }
    for (const ack of this.options.wallet.money.list<{ requestId: string }>("ack:")) await this.acknowledge(ack.requestId);
    return { recovered, failed, topups };
  }
}
