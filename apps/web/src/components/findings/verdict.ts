import { type CaseRecords, type FindingView } from "@zireh/cases";
import { corroboration } from "../../sources.ts";

export type Tone = "good" | "warn" | "bad" | "none";
export const TONE_TEXT: Record<Tone, string> = { good: "text-protected", warn: "text-decoy", bad: "text-destructive", none: "text-muted-foreground" };
export const TONE_DOT: Record<Tone, string> = { good: "bg-protected", warn: "bg-decoy", bad: "bg-destructive", none: "bg-muted-foreground/40" };

/** The one thing to know about a finding: ready, or the single most important thing in the way. */
export function verdict(rec: CaseRecords, f: FindingView): { tone: Tone; text: string } {
  const c = corroboration(rec, f);
  if (f.tally.status === "disputed") return { tone: "bad", text: "Your team disagrees" };
  if (c.level !== "corroborated") return { tone: "warn", text: c.level === "single" ? "Needs a second source" : "No source noted on its evidence" };
  if (f.tally.status === "needs-evidence") return { tone: "warn", text: "Team asked for more evidence" };
  if (f.tally.status === "unreviewed") return { tone: "none", text: "Waiting for your team to review" };
  return { tone: "good", text: `Ready · ${c.sources.length} sources · team agrees` };
}
