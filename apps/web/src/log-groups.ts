import type { Receipt } from "@zireh/schema";

/** Requests from one question belong together; anything without a question stands alone. */
export function groupByQuestion(receipts: readonly Receipt[]) {
  const groups = new Map<string, Receipt[]>();
  for (const r of receipts) {
    const key = r.runId ?? `one:${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups]
    .map(([key, rs]) => ({ key, runId: rs[0]!.runId, receipts: [...rs].sort((a, b) => a.at.localeCompare(b.at)), at: rs.reduce((t, r) => (r.at > t ? r.at : t), "") }))
    .sort((a, b) => b.at.localeCompare(a.at));
}
