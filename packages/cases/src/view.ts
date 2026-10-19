import type { Case, Evidence, Finding, Member, Observation, Pseudonym, Review } from "@zireh/schema";

/** Everything a case holds, as stored (and synced) records. */
export interface CaseRecords {
  readonly case: Case;
  readonly members: readonly Member[];
  readonly evidence: readonly Evidence[];
  readonly observations: readonly Observation[];
  readonly findings: readonly Finding[];
  readonly reviews: readonly Review[];
  readonly pseudonyms: readonly Pseudonym[];
}

export interface Tally {
  readonly support: number;
  readonly disagree: number;
  readonly needsEvidence: number;
  readonly status: "unreviewed" | "supported" | "disputed" | "needs-evidence";
}

export interface FindingView extends Finding {
  readonly reviews: readonly Review[];
  readonly tally: Tally;
  readonly missingObservations: readonly string[]; // cited ids that don't exist (or were rejected)
}

/** Latest review per member counts; a member changing their mind replaces their old review. */
export function tally(reviews: readonly Review[]): Tally {
  const latest = new Map<string, Review>();
  for (const r of [...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) latest.set(r.memberId, r);
  const current = [...latest.values()];
  const support = current.filter((r) => r.decision === "support").length;
  const disagree = current.filter((r) => r.decision === "disagree").length;
  const needsEvidence = current.filter((r) => r.decision === "needs-evidence").length;
  const status =
    current.length === 0 ? "unreviewed" : disagree > 0 ? "disputed" : needsEvidence > 0 ? "needs-evidence" : "supported";
  return { support, disagree, needsEvidence, status };
}

export function findingViews(records: CaseRecords): FindingView[] {
  const usable = new Set(records.observations.filter((o) => o.status !== "rejected").map((o) => o.id));
  return records.findings.map((f) => {
    const reviews = records.reviews.filter((r) => r.findingId === f.id);
    return { ...f, reviews, tally: tally(reviews), missingObservations: f.observationIds.filter((id) => !usable.has(id)) };
  });
}

/** Evidence, observations and findings in one timeline, newest first. */
export type TimelineItem =
  | { readonly kind: "evidence"; readonly at: string; readonly item: Evidence }
  | { readonly kind: "observation"; readonly at: string; readonly item: Observation }
  | { readonly kind: "finding"; readonly at: string; readonly item: Finding };

export function timeline(records: CaseRecords): TimelineItem[] {
  return [
    ...records.evidence.map((item) => ({ kind: "evidence" as const, at: item.addedAt, item })),
    ...records.observations.map((item) => ({ kind: "observation" as const, at: item.createdAt, item })),
    ...records.findings.map((item) => ({ kind: "finding" as const, at: item.createdAt, item })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

export const memberName = (records: CaseRecords, id: string): string =>
  records.members.find((m) => m.id === id)?.name ?? "Unknown member";
