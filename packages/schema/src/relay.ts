import { z } from "zod";
import { ChatRequest, Usage } from "./chat.ts";
import { Amount, BlindedMessage, BlindSignature, Keyset, ModelPrice, Proof } from "./money.ts";

/** Relay HTTP contract. Validated on both sides; the relay trusts nothing else. */

export const RelayInfo = z.object({
  keyset: Keyset,
  prices: z.array(ModelPrice),
  searchPrice: z.number().int().positive(), // credits per search
  searchEnabled: z.boolean(),
  network: z.enum(["testnet", "mainnet", "simulated"]),
  /** Whether the AI behind the relay answered its last health check. Absent from older relays. */
  upstreamOk: z.boolean().optional(),
});
export type RelayInfo = z.infer<typeof RelayInfo>;

export const TopupQuoteRequest = z.object({ credits: z.number().int().positive().max(100_000_000) });
export const TopupQuote = z.object({
  quoteId: z.string(),
  credits: z.number().int().positive(),
  zec: z.string(), // decimal string, e.g. "0.12000000"
  address: z.string(), // fresh shielded (unified) address
  paymentUri: z.string().optional(), // ZIP 321 `zcash:` link with the amount filled in
  expiresAt: z.string(),
  network: z.enum(["testnet", "mainnet", "simulated"]),
});
export type TopupQuote = z.infer<typeof TopupQuote>;

export const QuoteState = z.enum(["quoted", "paid", "confirmed", "minted", "expired"]);
export type QuoteState = z.infer<typeof QuoteState>;
/** `received` (ZEC) is set once part or all of the payment has been seen. */
export const QuoteStatus = z.object({ state: QuoteState, received: z.string().optional() });
export type QuoteStatus = z.infer<typeof QuoteStatus>;

export const MintRequest = z.object({ quoteId: z.string(), outputs: z.array(BlindedMessage).min(1).max(64) });
export const MintResponse = z.object({ signatures: z.array(BlindSignature) });

/** Zero-fee denomination exchange; the complete response is committed with the burn. */
export const SwapRequest = z.object({
  requestId: z.string().regex(/^[0-9a-f]{32}$/),
  proofs: z.array(Proof).min(1).max(64),
  outputs: z.array(BlindedMessage.extend({ amount: Amount })).min(1).max(512),
});

export const ChatPaidRequest = z.object({
  requestId: z.string().regex(/^[0-9a-f]{32}$/), // idempotency key
  request: ChatRequest,
  proofs: z.array(Proof).min(1).max(64),
  changeOutputs: z.array(BlindedMessage).max(64), // blank outputs (amount 0)
});
export type ChatPaidRequest = z.infer<typeof ChatPaidRequest>;

/** Final settlement, sent as the last stream event or fetched later by requestId. */
export const Settlement = z.object({
  requestId: z.string(),
  charged: z.number().int().nonnegative(),
  usage: Usage,
  change: z.array(BlindSignature),
});
export type Settlement = z.infer<typeof Settlement>;

export const ChatPaidResponse = z.object({
  answerExpired: z.boolean().optional(),
  content: z.string(),
  model: z.string(),
  settlement: Settlement,
});
export type ChatPaidResponse = z.infer<typeof ChatPaidResponse>;

export const SearchPaidRequest = z.object({
  requestId: z.string().regex(/^[0-9a-f]{32}$/),
  query: z.string().trim().min(2).max(400),
  maxResults: z.number().int().min(1).max(10),
  proofs: z.array(Proof).min(1).max(64),
  changeOutputs: z.array(BlindedMessage).max(64),
});
export type SearchPaidRequest = z.infer<typeof SearchPaidRequest>;

export const SearchHit = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchPaidResponse = z.object({
  answerExpired: z.boolean().optional(),
  hits: z.array(SearchHit),
  settlement: Settlement,
});
export type SearchPaidResponse = z.infer<typeof SearchPaidResponse>;

export const RelayError = z.object({
  error: z.enum([
    "bad_request",
    "insufficient_funds",
    "token_spent",
    "token_invalid",
    "unknown_model",
    "upstream_error",
    "not_found",
    "quote_unpaid",
    "limit_exceeded",
  ]),
  message: z.string(),
  settlement: Settlement.optional(), // present when coins were burned: full refund as change
});
export type RelayError = z.infer<typeof RelayError>;
