import type { ChatMessage, ModelPrice, Usage } from "@zireh/schema";

/**
 * Upper bound on input tokens from text alone. Tokenizers average 3–4 chars per token for
 * English; 2 chars per token plus per-message overhead keeps the bound safe for any text.
 * Both client and relay use this exact function, so they agree on the hold amount.
 */
export const inputTokenBound = (messages: readonly ChatMessage[]): number =>
  messages.reduce((n, m) => n + Math.ceil(m.content.length / 2) + 8, 0);

const credits = (tokens: number, perMTok: number) => (tokens * perMTok) / 1_000_000;

/** Coins the client must hand over before the call: the worst case. */
export const maxCost = (price: ModelPrice, messages: readonly ChatMessage[], maxTokens: number): number =>
  Math.max(1, Math.ceil(credits(inputTokenBound(messages), price.inputPerMTok) + credits(maxTokens, price.outputPerMTok)));

/** What the call actually cost, from the provider's usage report. */
export const actualCost = (price: ModelPrice, usage: Usage): number =>
  Math.max(1, Math.ceil(credits(usage.prompt_tokens, price.inputPerMTok) + credits(usage.completion_tokens, price.outputPerMTok)));

export interface BillCheck {
  readonly expected: number; // cost recomputed on the client from the reported usage
  readonly charged: number;
  readonly overcharged: boolean;
  readonly reason?: string;
}

/**
 * Client-side audit of one settlement. Flags the relay if it charged more than the usage it
 * reported, reported more input tokens than the bound allows, or more output tokens than
 * the streamed text plausibly contains.
 */
export function checkBill(
  price: ModelPrice,
  messages: readonly ChatMessage[],
  receivedText: string,
  usage: Usage,
  charged: number,
): BillCheck {
  const expected = actualCost(price, usage);
  const reasons: string[] = [];
  if (charged > expected) reasons.push(`charged ${charged} but reported usage costs ${expected}`);
  if (usage.prompt_tokens > inputTokenBound(messages)) reasons.push("reported more input tokens than were sent");
  const outputBound = Math.ceil(receivedText.length / 1.5) + 16;
  if (usage.completion_tokens > outputBound) reasons.push("reported more output tokens than were received");
  return reasons.length
    ? { expected, charged, overcharged: true, reason: reasons.join("; ") }
    : { expected, charged, overcharged: false };
}
