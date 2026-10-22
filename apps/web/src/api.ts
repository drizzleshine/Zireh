import type { DaemonStatus, PrivacyLevel, Pseudonym, Receipt, ResearchEvent, TopupQuote } from "@zireh/schema";
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
    throw new DaemonError("The Zireh daemon isn't running on this computer. Start it with `pnpm dev`.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new DaemonError(data.message ?? data.error ?? `HTTP ${res.status}`, res.status, data.error);
  return data as T;
}

export const api = {
  cancelResearch: (runId: string) => call<{ cancelled: true }>(`/api/research/${runId}/cancel`, {}),
  status: () => call<DaemonStatus>("/api/status"),
  quote: (credits: number) => call<TopupQuote>("/api/wallet/quote", { credits }),
  simulatePayment: (quoteId: string) => call<{ ok: true }>("/api/wallet/simulate-payment", { quoteId }),
  redeem: (quote: TopupQuote) => call<{ balance: number }>("/api/wallet/redeem", quote),
  receipts: (caseId?: string) =>
    call<{ receipts: Receipt[]; summary: { calls: number; real: number; decoys: number; spent: number; overcharges: number } }>(`/api/receipts${caseId ? `?caseId=${caseId}` : ""}`),
  search: (query: string, table: readonly Pseudonym[], caseId?: string) =>
    call<{ redactedQuery: string; hits: { title: string; url: string; content: string }[]; table: Pseudonym[]; charged: number }>("/api/search", { query, table, caseId }),
  redact: (texts: string[], table: readonly Pseudonym[]) => call<{ table: Pseudonym[] }>("/api/redact", { texts, table }),
  push: (caseId: string, token: string, records: Envelope[]) => call<{ cursor: number }>("/api/sync/push", { caseId, token, records }),
  pull: (caseId: string, token: string, after: number) => call<PullResponse>("/api/sync/pull", { caseId, token, after }),
};

export interface ResearchInput {
  readonly task: string;
  readonly context: string[];
  readonly level: PrivacyLevel;
  readonly table: readonly Pseudonym[];
  readonly salt: string;
  readonly caseId?: string;
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

/** Credits are µUSD. */
export const formatUsd = (credits: number): string =>
  credits >= 10_000 ? `$${(credits / 1_000_000).toFixed(2)}` : credits >= 100 ? `$${(credits / 1_000_000).toFixed(4)}` : credits > 0 ? "<$0.0001" : "$0";
