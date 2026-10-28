import { randomId, sha256Hex } from "@zireh/crypto";
import type { QuoteState, TopupQuote } from "@zireh/schema";

/**
 * Relay-side payment intake. A quote gives the client a fresh shielded address and an
 * amount; the watcher reports when that address has received it. Implementations:
 *  - `simulatedWatcher`: no chain; payments are marked by hand. Labeled "simulated".
 *  Real testnet/mainnet payments are watched by the Rust host (host/src/features/payments).
 */
export interface PaymentWatcher {
  readonly network: TopupQuote["network"];
  quote(credits: number): TopupQuote | Promise<TopupQuote>;
  /** Pull the latest payment status for a quote before `state` is read. Absent when state is always current. */
  refresh?(quoteId: string): Promise<void>;
  state(quoteId: string): QuoteState;
  /** ZEC received so far, when the watcher knows it (shows partial payments). */
  received?(quoteId: string): string | undefined;
  /** The quote as issued (credits are what the relay may mint for it). Throws if unknown. */
  lookup(quoteId: string): TopupQuote;
  /** Called once coins are issued, so a quote can never mint twice. */
  markMinted(quoteId: string, commit?: () => void): void;
}

export interface RateSource {
  /** USD per 1 ZEC. */
  usdPerZec(): number;
}

export const fixedRate = (usdPerZec: number): RateSource => ({ usdPerZec: () => usdPerZec });

export const QUOTE_TTL_MS = 15 * 60 * 1000;

/** credits are µUSD; ZEC has 8 decimals (zatoshi). Rounds up so the relay is never short. */
export function creditsToZec(credits: number, rate: RateSource): string {
  const zatoshi = Math.ceil((credits / 1_000_000 / rate.usdPerZec()) * 1e8);
  return (zatoshi / 1e8).toFixed(8);
}

export interface QuoteRecord {
  quote: TopupQuote;
  state: QuoteState;
  /** The payment service's own id for this quote, when one issued the address. */
  invoiceId?: string;
  received?: string;
}

export interface QuoteStore {
  get(id: string): QuoteRecord | undefined;
  put(id: string, record: QuoteRecord): void;
  atomically<T>(work: () => T): T;
}

export function memoryQuoteStore(): QuoteStore {
  let quotes = new Map<string, QuoteRecord>();
  return {
    get: (id) => structuredClone(quotes.get(id)),
    put: (id, record) => { quotes.set(id, structuredClone(record)); },
    atomically(work) {
      const before = structuredClone(quotes);
      try { return work(); } catch (error) { quotes = before; throw error; }
    },
  };
}

export interface SimulatedWatcher extends PaymentWatcher {
  quote(credits: number): TopupQuote;
  /** Demo only: pretend the shielded payment for this quote arrived and confirmed. */
  simulatePayment(quoteId: string): void;
}

export function simulatedWatcher(rate: RateSource, now: () => number = Date.now, quotes: QuoteStore = memoryQuoteStore()): SimulatedWatcher {
  const get = (quoteId: string): QuoteRecord => {
    const rec = quotes.get(quoteId);
    if (!rec) throw new Error("unknown quote");
    if (rec.state === "quoted" && Date.parse(rec.quote.expiresAt) < now()) { rec.state = "expired"; quotes.put(quoteId, rec); }
    return rec;
  };
  return {
    network: "simulated",
    quote(credits) {
      const quoteId = randomId();
      const quote: TopupQuote = {
        quoteId,
        credits,
        zec: creditsToZec(credits, rate),
        // Looks like a unified address but is marked as simulated so it can't be mistaken for one.
        address: `usim1${sha256Hex(quoteId).slice(0, 58)}`,
        expiresAt: new Date(now() + QUOTE_TTL_MS).toISOString(),
        network: "simulated",
      };
      quotes.put(quoteId, { quote, state: "quoted" });
      return quote;
    },
    state: (quoteId) => get(quoteId).state,
    lookup: (quoteId) => get(quoteId).quote,
    simulatePayment(quoteId) {
      const rec = get(quoteId);
      if (rec.state !== "quoted") throw new Error(`quote is ${rec.state}`);
      rec.state = "confirmed";
      quotes.put(quoteId, rec);
    },
    markMinted: (quoteId, commit) => settleMint(quotes, quoteId, get, commit),
  };
}

/** Confirmed → minted exactly once, committed together with the minted response. */
export function settleMint(quotes: QuoteStore, quoteId: string, get: (quoteId: string) => QuoteRecord, commit?: () => void): void {
  quotes.atomically(() => {
    const rec = get(quoteId);
    if (rec.state !== "confirmed") throw new Error(`quote is ${rec.state}, not confirmed`);
    quotes.put(quoteId, { ...rec, state: "minted" });
    commit?.();
  });
}

