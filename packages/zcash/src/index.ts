import { randomId, sha256Hex } from "@zireh/crypto";
import type { QuoteState, TopupQuote } from "@zireh/schema";

/**
 * Relay-side payment intake. A quote gives the client a fresh shielded address and an
 * amount; the watcher reports when that address has received it. Implementations:
 *  - `simulatedWatcher`: no chain; payments are marked by hand. Labeled "simulated".
 *  - a lightwalletd/viewing-key watcher (planned; see context/decisions.md).
 */
export interface PaymentWatcher {
  readonly network: TopupQuote["network"];
  quote(credits: number): TopupQuote;
  state(quoteId: string): QuoteState;
  /** Called once coins are issued, so a quote can never mint twice. */
  markMinted(quoteId: string): void;
}

export interface RateSource {
  /** USD per 1 ZEC. */
  usdPerZec(): number;
}

export const fixedRate = (usdPerZec: number): RateSource => ({ usdPerZec: () => usdPerZec });

const QUOTE_TTL_MS = 15 * 60 * 1000;

/** credits are µUSD; ZEC has 8 decimals (zatoshi). Rounds up so the relay is never short. */
export function creditsToZec(credits: number, rate: RateSource): string {
  const zatoshi = Math.ceil((credits / 1_000_000 / rate.usdPerZec()) * 1e8);
  return (zatoshi / 1e8).toFixed(8);
}

interface QuoteRecord {
  quote: TopupQuote;
  state: QuoteState;
}

export interface SimulatedWatcher extends PaymentWatcher {
  /** Demo only: pretend the shielded payment for this quote arrived and confirmed. */
  simulatePayment(quoteId: string): void;
}

export function simulatedWatcher(rate: RateSource, now: () => number = Date.now): SimulatedWatcher {
  const quotes = new Map<string, QuoteRecord>();
  const get = (quoteId: string): QuoteRecord => {
    const rec = quotes.get(quoteId);
    if (!rec) throw new Error("unknown quote");
    if (rec.state === "quoted" && Date.parse(rec.quote.expiresAt) < now()) rec.state = "expired";
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
      quotes.set(quoteId, { quote, state: "quoted" });
      return quote;
    },
    state: (quoteId) => get(quoteId).state,
    simulatePayment(quoteId) {
      const rec = get(quoteId);
      if (rec.state !== "quoted") throw new Error(`quote is ${rec.state}`);
      rec.state = "confirmed";
    },
    markMinted(quoteId) {
      const rec = get(quoteId);
      if (rec.state !== "confirmed") throw new Error(`quote is ${rec.state}, not confirmed`);
      rec.state = "minted";
    },
  };
}
