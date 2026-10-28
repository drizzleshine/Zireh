import type { Pseudonym } from "@zireh/schema";
import * as engine from "./engine/index.ts";

/**
 * What the screens call. Everything runs in this page (see engine/): the wallet, the privacy
 * pipeline and the on-device model, talking to the Zireh host directly.
 */

export { EngineError, startLocalModel, research, type ResearchInput } from "./engine/index.ts";

export const api = {
  researchResults: engine.researchResults,
  sendResearch: engine.sendResearch,
  cancelResearch: engine.cancelResearch,
  status: engine.status,
  quote: engine.quote,
  quoteStatus: engine.quoteStatus,
  simulatePayment: engine.simulatePayment,
  redeem: engine.redeem,
  receipts: engine.receipts,
  retryDispute: engine.retryDispute,
  writeOffDispute: engine.writeOffDispute,
  search: engine.search,
  redact: engine.redact,
  syncConfig: engine.syncConfig,
  push: engine.push,
  pull: engine.pull,
};

/** Network errors from the relay or its AI, said plainly. Anything else is shown as written. */
export function plainFailure(message: string | undefined): string {
  if (!message) return "unknown error";
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|unreachable|HTTP 50[234]/i.test(message)) return "the AI behind the relay couldn't be reached";
  return message;
}

/** Credits are µUSD. Small amounts keep two significant digits instead of collapsing to "<$0.0001". */
export const formatUsd = (credits: number): string => {
  if (credits <= 0) return "$0";
  const usd = credits / 1_000_000;
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${Number(usd.toPrecision(2)).toFixed(Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(usd))))).replace(/0+$/, "")}`;
};


/** Scan complete publications in batches of 100, carrying forward every detection. */
export async function scanPublicationTexts(texts: readonly string[], initial: readonly Pseudonym[]): Promise<Pseudonym[]> {
  let table = [...initial];
  for (let offset = 0; offset < texts.length; offset += 100) ({ table } = await api.redact(texts.slice(offset, offset + 100), table));
  return table;
}
