import { randomId } from "@zireh/crypto";
import {
  ChatPaidResponse,
  MintResponse,
  RelayError,
  RelayInfo,
  SearchPaidResponse,
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
import { newCircuitTag, type Transport } from "@zireh/tor";
import { checkBill, checkSettlement, memoryMoneyStore, maxCost, prepareChange, prepareTopup, sum, unblindAll, type BillCheck, type PendingOutputs, type Wallet, type MoneyStore } from "@zireh/wallet";
import { z } from "zod";

/** Everything needed to send (or re-send) one paid call. Persisted before the first send. */
export interface PendingCall {
  readonly requestId: string;
  readonly status?: "disputed" | "settlement-pending";
  readonly dispute?: string;
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


export const memoryPendingStore = (money: MoneyStore = memoryMoneyStore()): PendingStore => moneyPendingStore(money);

export type CallResult =
  | { readonly answerExpired?: boolean; readonly kind: "chat"; readonly requestId: string; readonly content: string; readonly model: string; readonly usage: Usage; readonly charged: number; readonly bill: BillCheck }
  | { readonly answerExpired?: boolean; readonly kind: "search"; readonly requestId: string; readonly hits: SearchHit[]; readonly charged: number };

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
const NOT_BURNED = new Set<string>(["bad_request", "insufficient_funds", "unknown_model", "not_found", "quote_unpaid"]);

export interface RelayClientOptions {
  readonly baseUrl: string;
  readonly transport: Transport;
  readonly wallet: Wallet;
  readonly pending?: PendingStore;
}

/**
 * Pays the relay with ecash over Tor. Every call uses its own circuit. A call is persisted
 * before it is sent and re-sent with the same requestId after a failure, so a dropped
 * connection never means paying twice or losing change.
 */
export class RelayClient {
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

  /** Simulated networks only: ask the relay to mark the quote as paid (demo top-ups). */
  async simulatePayment(quoteId: string): Promise<void> {
    await this.request(this.options.transport.fetchFor(newCircuitTag()), "/v1/topup/simulate", z.object({ state: z.string() }), { quoteId });
  }

  /** After paying the quote: exchange it for coins. Returns the new balance. */
  async redeemTopup(quote: TopupQuote): Promise<number> {
    const { keyset } = await this.info();
    const pending = prepareTopup(keyset, quote.credits);
    const { signatures } = await this.request(
      this.options.transport.fetchFor(newCircuitTag()),
      "/v1/topup/mint",
      MintResponse,
      { quoteId: quote.quoteId, outputs: pending.outputs },
    );
    this.options.wallet.add(unblindAll(keyset, pending, signatures));
    return this.options.wallet.balance;
  }

  /** Take coins for the worst case and persist the call. Nothing has left the device yet. */
  async prepareChat(model: string, messages: readonly ChatMessage[], maxTokens: number): Promise<PendingCall> {
    const [price, { keyset }] = await Promise.all([this.priceOf(model), this.info()]);
    return this.prepare("chat", "/v1/chat", keyset, maxCost(price, messages, maxTokens), (requestId, proofs, blanks) => ({
      requestId,
      request: { model, messages, max_tokens: maxTokens },
      proofs,
      changeOutputs: blanks.outputs,
    }), { price, messages });
  }

  async prepareSearch(query: string, maxResults: number): Promise<PendingCall> {
    const { keyset, searchPrice } = await this.info();
    return this.prepare("search", "/v1/search", keyset, searchPrice, (requestId, proofs, blanks) => ({
      requestId,
      query,
      maxResults,
      proofs,
      changeOutputs: blanks.outputs,
    }));
  }

  private prepare(
    kind: PendingCall["kind"],
    path: string,
    keyset: Keyset,
    hold: number,
    body: (requestId: string, proofs: Proof[], blanks: PendingOutputs) => Record<string, unknown>,
    extra: Pick<PendingCall, "price" | "messages"> = {},
  ): PendingCall {
    return this.options.wallet.money.atomically(() => {
      const proofs = this.options.wallet.take(hold);
      const blanks = prepareChange(keyset, sum(proofs));
      const requestId = randomId();
      const call: PendingCall = { requestId, maxCharge: hold, kind, path, proofs, blanks, keyset, body: body(requestId, proofs, blanks), ...extra };
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

  async send(call: PendingCall, circuitTag: string = newCircuitTag()): Promise<CallResult> {
    const fetchFn = this.options.transport.fetchFor(circuitTag);
    try {
      if (call.kind === "chat") {
        const res = await this.request(fetchFn, call.path, ChatPaidResponse, call.body);
        this.settle(call, res.settlement);
        await this.acknowledge(call.requestId);
        const bill = checkBill(call.price!, call.messages!, res.answerExpired ? undefined : res.content, res.settlement.usage, res.settlement.charged, (call.body.request as { max_tokens: number }).max_tokens);
        return { answerExpired: res.answerExpired ?? false, kind: "chat", requestId: call.requestId, content: res.content, model: res.model, usage: res.settlement.usage, charged: res.settlement.charged, bill };
      }
      const res = await this.request(fetchFn, call.path, SearchPaidResponse, call.body);
      this.settle(call, res.settlement);
      await this.acknowledge(call.requestId);
      return { answerExpired: res.answerExpired ?? false, kind: "search", requestId: call.requestId, hits: res.hits, charged: res.settlement.charged };
    } catch (err) {
      if (err instanceof z.ZodError) {
        const reason = "Settlement disputed: the relay returned a malformed response";
        this.pending.save({ ...call, status: "disputed", dispute: reason });
        throw new RelayCallError("settlement_disputed", reason, true);
      }
      if (err instanceof RelayCallError && !err.retryable) {
        const settlement = (err as RelayCallError & { settlement?: Settlement }).settlement;
        if (settlement) { this.settle(call, settlement); await this.acknowledge(call.requestId); }
        else if (NOT_BURNED.has(err.code)) {
          this.options.wallet.money.atomically(() => {
            this.options.wallet.add(call.proofs);
            this.pending.remove(call.requestId);
          });
        } else if (this.pending.list().some((pending) => pending.requestId === call.requestId)) {
          this.pending.save({ ...call, status: "settlement-pending" });
        }
      }
      throw err; // retryable errors keep the call pending for `recover`
    }
  }

  /** Credit change once: only a call that is still pending can be settled. */
  private settle(call: PendingCall, settlement: Settlement) {
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
      this.options.wallet.money.put(`ack:${call.requestId}`, { requestId: call.requestId });
      this.pending.remove(call.requestId);
    });
  }

  private async acknowledge(requestId: string): Promise<void> {
    if (!this.options.wallet.money.get(`ack:${requestId}`)) return;
    try {
      await this.request(this.options.transport.fetchFor(newCircuitTag()), "/v1/settlement/ack", z.object({ ok: z.literal(true) }), { requestId });
      this.options.wallet.money.remove(`ack:${requestId}`);
    } catch { /* Coins are already committed; retry the durable acknowledgement later. */ }
  }

  /** Re-send every call that never got a definite answer (e.g. after a crash or dropped circuit). */
  async recover(): Promise<{ recovered: CallResult[]; failed: RelayCallError[] }> {
    const recovered: CallResult[] = [];
    const failed: RelayCallError[] = [];
    for (const call of this.pending.list()) {
      try {
        recovered.push(await this.send(call));
      } catch (err) {
        if (err instanceof RelayCallError) failed.push(err);
        else throw err;
      }
    }
    for (const ack of this.options.wallet.money.list<{ requestId: string }>("ack:")) await this.acknowledge(ack.requestId);
    return { recovered, failed };
  }
}
