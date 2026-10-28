import type { DaemonStatus, PrivacyLevel, Pseudonym, QuoteStatus, Receipt, ResearchEvent, TopupQuote } from "@zireh/schema";
import type { Envelope, PullResponse } from "@zireh/sync";

/** Client for the local daemon. Every request carries the header the daemon requires. */

export class DaemonError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-zireh": "1", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new DaemonError("Can't reach Zireh's privacy service on this computer. Start it with `pnpm dev`.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new DaemonError(data.message ?? data.error ?? `HTTP ${res.status}`, res.status, data.error);
  return data as T;
}

export const api = {
  researchResults: (caseId: string) => call<{ results: { requestId: string; runId: string; pieceId: string; question: string; content: string; answerExpired: boolean; charged: number; runSpent: number }[] }>(`/api/research/results?caseId=${caseId}`),
  sendResearch: (runId: string) => call<{ approved: true }>(`/api/research/${runId}/send`, {}),
  cancelResearch: (runId: string) => call<{ cancelled: true }>(`/api/research/${runId}/cancel`, {}),
  status: () => call<DaemonStatus>("/api/status"),
  quote: (credits: number) => call<TopupQuote>("/api/wallet/quote", { credits }),
  quoteStatus: (quoteId: string) => call<QuoteStatus>(`/api/wallet/quote-status?quoteId=${quoteId}`),
  simulatePayment: (quoteId: string) => call<{ ok: true }>("/api/wallet/simulate-payment", { quoteId }),
  redeem: (quote: TopupQuote) => call<{ balance: number }>("/api/wallet/redeem", quote),
  receipts: (caseId?: string) =>
    call<{ receipts: Receipt[]; disputes: { requestId: string; reason?: string; amount: number }[]; writtenOff: { requestId: string; reason?: string; amount: number; at: number }[]; summary: { calls: number; real: number; decoys: number; spent: number; overcharges: number } }>(`/api/receipts${caseId ? `?caseId=${caseId}` : ""}`),
  retryDispute: (requestId: string) => call<{ ok: true }>(`/api/disputes/${requestId}/retry`, {}),
  writeOffDispute: (requestId: string) => call<{ ok: true }>(`/api/disputes/${requestId}/write-off`, {}),
  search: (query: string, table: readonly Pseudonym[], caseId?: string) =>
    call<{ redactedQuery: string; hits: { title: string; url: string; content: string }[]; table: Pseudonym[]; charged: number }>("/api/search", { query, table, caseId }),
  redact: (texts: string[], table: readonly Pseudonym[]) => call<{ table: Pseudonym[] }>("/api/redact", { texts, table }),
  syncConfig: () => call<{ host: string }>("/api/sync/config"),
  push: (caseId: string, token: string, records: Envelope[], host?: string) => call<{ cursor: number }>("/api/sync/push", { caseId, token, records, ...(host ? { host } : {}) }),
  pull: (caseId: string, token: string, after: number, host?: string) => call<PullResponse>("/api/sync/pull", { caseId, token, after, ...(host ? { host } : {}) }),
};

export interface ResearchInput {
  readonly reviewBeforeSend?: boolean;
  readonly task: string;
  readonly context: string[];
  readonly level: PrivacyLevel;
  readonly table: readonly Pseudonym[];
  readonly salt: string;
  readonly caseId?: string;
  /** Earlier turns of the thread, used on this computer to make a follow-up stand alone. */
  readonly history?: readonly { question: string; answer: string }[];
}

/** Run a research question; events arrive as the pipeline progresses. */
export async function research(input: ResearchInput, onEvent: (e: ResearchEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/research", {
    method: "POST",
    headers: { "x-zireh": "1", "content-type": "application/json" },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new DaemonError(data.message ?? data.error ?? `HTTP ${res.status}`, res.status);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (chunk.startsWith("data: ")) onEvent(JSON.parse(chunk.slice(6)) as ResearchEvent);
    }
  }
}

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


/** Scan complete publications in daemon-sized batches, carrying forward every detection. */
export async function scanPublicationTexts(texts: readonly string[], initial: readonly Pseudonym[]): Promise<Pseudonym[]> {
  let table = [...initial];
  for (let offset = 0; offset < texts.length; offset += 100) ({ table } = await api.redact(texts.slice(offset, offset + 100), table));
  return table;
}
