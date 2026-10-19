import { canonicalJson, sha256Hex } from "@zireh/crypto";
import type { Outcome, Pseudonym } from "@zireh/schema";
import { findingViews, latestConclusion, memberName, type CaseRecords } from "./view.ts";

/**
 * A findings page: an immutable snapshot of the conclusion, the findings it rests on, the
 * observations they cite, and the evidence hashes behind them. Its hash identifies exactly
 * this content. With `hideNames`, every value in the case's pseudonym table is replaced by
 * its vague description, so the page can be shared without exposing sources.
 */
export interface Publication {
  readonly schema: "zireh/publication/v1";
  readonly title: string;
  readonly question: string;
  readonly publishedAt: string;
  readonly namesHidden: boolean;
  readonly conclusion?: { outcome: Outcome; summary: string; openQuestion: string; revision: number };
  readonly findings: {
    statement: string;
    uncertainty: string;
    status: string;
    support: number;
    disagree: number;
    observations: { text: string; by: string; evidence: { title: string; sha256: string }[] }[];
  }[];
  readonly authors: string[];
}

const hide = (text: string, table: readonly Pseudonym[]): string => {
  let out = text;
  for (const p of [...table].sort((a, b) => b.original.length - a.original.length)) {
    out = out.replace(new RegExp(p.original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), p.hint ?? p.placeholder);
  }
  return out;
};

export function buildPublication(records: CaseRecords, options: { hideNames: boolean; publishedAt?: string }): { publication: Publication; hash: string } {
  const t = (s: string) => (options.hideNames ? hide(s, records.pseudonyms) : s);
  const conclusion = latestConclusion(records);
  const chosen = conclusion ? new Set(conclusion.findingIds) : undefined;
  const findings = findingViews(records)
    .filter((f) => !chosen || chosen.has(f.id))
    .map((f) => ({
      statement: t(f.statement),
      uncertainty: t(f.uncertainty),
      status: f.tally.status,
      support: f.tally.support,
      disagree: f.tally.disagree,
      observations: f.observationIds
        .map((id) => records.observations.find((o) => o.id === id))
        .filter((o) => o !== undefined && o.status === "accepted")
        .map((o) => ({
          text: t(o!.text),
          by: o!.author.kind === "ai" ? "AI (reviewed by the team)" : options.hideNames ? "a team member" : memberName(records, o!.author.memberId),
          evidence: o!.evidenceIds
            .map((id) => records.evidence.find((e) => e.id === id))
            .filter((e) => e !== undefined)
            .map((e) => ({ title: t(e!.title), sha256: e!.sha256 })),
        })),
    }));
  const publication: Publication = {
    schema: "zireh/publication/v1",
    title: t(records.case.title),
    question: t(records.case.question),
    publishedAt: options.publishedAt ?? new Date().toISOString(),
    namesHidden: options.hideNames,
    ...(conclusion ? { conclusion: { outcome: conclusion.outcome, summary: t(conclusion.summary), openQuestion: t(conclusion.openQuestion), revision: conclusion.revision } } : {}),
    findings,
    authors: options.hideNames ? [] : records.members.map((m) => m.name),
  };
  return { publication, hash: sha256Hex(canonicalJson(publication)) };
}
