import { randomId } from "@zireh/crypto";
import type { QuoteState, TopupQuote } from "@zireh/schema";
import { creditsToZec, memoryQuoteStore, settleMint, QUOTE_TTL_MS, type PaymentWatcher, type QuoteStore, type RateSource } from "./index.ts";

/**
 * Real Zcash payments through ZecCheckout (github.com/samizdatproject/zeccheckout), run as a
 * sidecar next to the relay. ZecCheckout holds only a viewing key: it hands out a fresh shielded
 * address per invoice and scans the chain for payments to it. It can see payments but never spend.
 *
 * The relay keeps its own quote record; ZecCheckout only answers "what has arrived". Minting stays
 * here, guarded by the same once-only check as the simulator.
 */
export interface ZecCheckoutOptions {
  /** ZecCheckout's base URL, e.g. http://zeccheckout:10000 */
  readonly url: string;
  readonly apiKey: string;
  readonly network: "testnet" | "mainnet";
  readonly rate: RateSource;
  readonly quotes?: QuoteStore;
  readonly fetch?: typeof fetch;
}

interface Invoice {
  id: string;
  status: string;
  amount_zat: number;
  address?: string;
  payment_uri?: string;
  expires_at?: number;
  received_zat?: number;
}

/** ZecCheckout statuses → ours. Underpaid and detected both mean "money seen, not yet enough or not yet deep enough". */
const STATES: Record<string, QuoteState> = { pending: "quoted", underpaid: "paid", detected: "paid", paid: "confirmed", expired: "expired" };

const zec = (zat: number) => (zat / 1e8).toFixed(8);
const toZat = (amount: string) => Math.round(Number(amount) * 1e8);

export function zecCheckoutWatcher(options: ZecCheckoutOptions): PaymentWatcher {
  const quotes = options.quotes ?? memoryQuoteStore();
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/$/, "");
  const prefix = options.network === "testnet" ? "utest1" : "u1";

  async function call(path: string, body?: unknown): Promise<Invoice> {
    const res = await doFetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`payment service returned HTTP ${res.status}`);
    const invoice = (await res.json()) as Invoice;
    if (typeof invoice?.id !== "string" || typeof invoice.status !== "string" || !Number.isSafeInteger(invoice.amount_zat)) throw new Error("payment service sent an unexpected reply");
    return invoice;
  }

  const record = (quoteId: string) => {
    const rec = quotes.get(quoteId);
    if (!rec) throw new Error("unknown quote");
    return rec;
  };

  return {
    network: options.network,

    async quote(credits) {
      const amount = creditsToZec(credits, options.rate);
      const quoteId = randomId();
      const invoice = await call("/api/v1/invoices", { amount_zec: amount, order_id: quoteId, expires_in_secs: QUOTE_TTL_MS / 1000 });
      // Don't take the service's word for what it issued: wrong network or amount would mint the wrong coins.
      if (!invoice.address?.startsWith(prefix)) throw new Error(`payment service issued an address for the wrong network`);
      if (invoice.amount_zat !== toZat(amount)) throw new Error("payment service issued the wrong amount");
      const quote: TopupQuote = {
        quoteId,
        credits,
        zec: amount,
        address: invoice.address,
        ...(invoice.payment_uri ? { paymentUri: invoice.payment_uri } : {}),
        expiresAt: new Date((invoice.expires_at ?? 0) * 1000 || Date.now() + QUOTE_TTL_MS).toISOString(),
        network: options.network,
      };
      quotes.put(quoteId, { quote, state: "quoted", invoiceId: invoice.id });
      return quote;
    },

    async refresh(quoteId) {
      const rec = record(quoteId);
      if (rec.state === "minted" || !rec.invoiceId) return;
      const invoice = await call(`/api/v1/invoices/${encodeURIComponent(rec.invoiceId)}`);
      const state = STATES[invoice.status];
      if (!state) throw new Error(`payment service reported an unknown status: ${invoice.status}`);
      if (invoice.amount_zat !== toZat(rec.quote.zec)) throw new Error("payment service changed the invoice amount");
      // Re-read inside the transaction: a mint may have finished while we were asking.
      quotes.atomically(() => {
        const latest = record(quoteId);
        if (latest.state === "minted") return;
        quotes.put(quoteId, { ...latest, state, ...(invoice.received_zat ? { received: zec(invoice.received_zat) } : {}) });
      });
    },

    state: (quoteId) => record(quoteId).state,
    received: (quoteId) => record(quoteId).received,
    lookup: (quoteId) => record(quoteId).quote,
    markMinted: (quoteId, commit) => settleMint(quotes, quoteId, record, commit),
  };
}
