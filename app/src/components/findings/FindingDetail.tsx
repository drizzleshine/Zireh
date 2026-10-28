import { memberName, newReview, type CaseRecords, type FindingView } from "@zireh/cases";
import type { Review } from "@zireh/schema";
import { Check, PencilSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { corroboration } from "../../sources.ts";
import { save } from "../../store.ts";
import type { OpenItem } from "../CaseView.tsx";
import { Comments } from "../Comments.tsx";
import { Pane } from "../Pane.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { splitAi } from "./splitAi.ts";
import { type Tone, TONE_TEXT, TONE_DOT, verdict } from "./verdict.ts";
import { EditFinding } from "./EditFinding.tsx";

const DECISIONS: { id: Review["decision"]; label: string }[] = [
  { id: "support", label: "I agree" },
  { id: "disagree", label: "I disagree" },
  { id: "needs-evidence", label: "Needs more evidence" },
];

/** Everything behind one finding, and the one action most people take here: reviewing it. */
export function FindingDetail({ caseId, rec, finding: f, verdict: v, me, onOpen }: { caseId: string; rec: CaseRecords & { verifiedReviews?: string[] }; finding: FindingView; verdict: { tone: Tone; text: string }; me: string; onOpen?: OpenItem | undefined }) {
  const mine = f.reviews.filter((r) => r.memberId === me).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const c = corroboration(rec, f);
  const observations = rec.observations.filter((o) => f.observationIds.includes(o.id));
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState<{ decision: Review["decision"]; text: string }>();
  const review = (decision: Review["decision"], text = "") =>
    void save(caseId, "reviews", newReview(caseId, me, { findingId: f.id, decision, reason: text })).catch((error: Error) => toast.error("Couldn't save your review", { description: error.message }));

  return (
    <Pane
      bodyClassName="grid gap-6 p-4 md:p-6"
      footer={
        <>
          <span className="text-xs text-muted-foreground">Written by {memberName(rec, f.createdBy)}</span>
          <span className="ml-auto flex items-center gap-1">
            {f.createdBy === me && !editing && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setEditing(true)}>
                <PencilSimple /> Edit
              </Button>
            )}
            <Comments caseId={caseId} targetId={f.id} />
          </span>
        </>
      }
    >
      {editing ? (
        <EditFinding caseId={caseId} finding={f} onDone={() => setEditing(false)} />
      ) : (
        <header className="grid gap-2">
          <p className="font-serif text-[20px] leading-snug text-pretty">{f.statement}</p>
          <p className={cn("flex items-center gap-2 text-sm font-medium", TONE_TEXT[v.tone])}>
            <span className={cn("size-2 rounded-full", TONE_DOT[v.tone])} />
            {v.text}
          </p>
          {f.uncertainty && <p className="text-sm text-muted-foreground">Still uncertain: {f.uncertainty}</p>}
        </header>
      )}

      <div className="grid gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Proven by</p>
        <ul className="grid gap-3">
          {observations.map((o) => (
            <li key={o.id} className="grid gap-1 border-l-2 pl-3">
              <p className="font-serif text-[15px] leading-relaxed">{splitAi(o).text.slice(0, 500)}</p>
              <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 pt-1 text-xs text-muted-foreground">
                {rec.evidence
                  .filter((e) => o.evidenceIds.includes(e.id))
                  .map((e, i) => (
                    <span key={e.id}>
                      {i > 0 && ", "}
                      <button type="button" onClick={() => onOpen?.("evidence", e.id)} className="underline-offset-4 hover:text-foreground hover:underline">
                        {e.title}
                      </button>{" "}
                      <span className={e.source ? "" : "text-decoy"}>({e.source ?? "no source"})</span>
                    </span>
                  ))}
              </p>
              <Comments caseId={caseId} targetId={o.id} />
              </div>
            </li>
          ))}
        </ul>
        {c.level !== "corroborated" && (
          <p className="text-sm text-decoy">
            {c.unattributed > 0 ? "Set a source on the evidence above (open it, then pick a source), or back this with evidence from someone else." : "Back this with evidence from a second, separate source."}
          </p>
        )}
        {f.missingObservations.length > 0 && <p className="text-xs text-decoy">Cites {f.missingObservations.length} observation(s) that were rejected or removed.</p>}
      </div>

      <div className="grid gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Your review</p>
        <div className="flex flex-wrap gap-2">
          {DECISIONS.map((d) => {
            const active = (reason?.decision ?? mine?.decision) === d.id;
            return (
              <Button
                key={d.id}
                size="sm"
                variant={active ? "default" : "outline"}
                onClick={() => {
                  if (d.id === "support") {
                    setReason(undefined);
                    review("support");
                  } else setReason({ decision: d.id, text: "" });
                }}
              >
                {active && <Check />}
                {d.label}
              </Button>
            );
          })}
        </div>
        {reason && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              review(reason.decision, reason.text.trim());
              setReason(undefined);
            }}
          >
            <Input autoFocus required value={reason.text} maxLength={2000} onChange={(e) => setReason({ ...reason, text: e.target.value })} placeholder={reason.decision === "disagree" ? "Why? Your team will see this." : "What evidence is missing?"} className="h-8 min-w-60 flex-1 text-sm" />
            <Button type="button" size="sm" variant="ghost" onClick={() => setReason(undefined)}>
              Cancel
            </Button>
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        )}
        {f.reviews.length > 0 && (
          <ul className="grid gap-0.5 text-xs text-muted-foreground">
            {f.reviews.map((r) => (
              <li key={r.id}>
                {memberName(rec, r.memberId)} {r.decision === "support" ? "agrees" : r.decision === "disagree" ? "disagrees" : "wants more evidence"}
                {r.reason && <>: “{r.reason}”</>}
                {rec.verifiedReviews?.includes(r.id) && " · signed"}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Pane>
  );
}
