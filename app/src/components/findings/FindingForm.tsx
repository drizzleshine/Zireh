import { newFinding, type CaseRecords, type FindingView } from "@zireh/cases";
import type { Observation } from "@zireh/schema";
import { Check, Plus } from "@phosphor-icons/react";
import { toast } from "sonner";
import { useDraft } from "../../drafts.ts";
import { save } from "../../store.ts";
import { PANE_FOOTER } from "../Pane.tsx";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { splitAi } from "./splitAi.ts";

/**
 * Write the claim first, then tick what proves it; the source count updates as you tick. Given a
 * finding, the same form rewords it in place: its reviews stay attached.
 */
export function FindingForm({ caseId, rec, me, accepted, finding, onDone }: { caseId: string; rec: CaseRecords; me: string; accepted: Observation[]; finding?: FindingView; onDone: (id?: string) => void }) {
  // Kept as a draft: navigating away half-way and coming back finds it as you left it.
  const key = `finding.${finding?.id ?? "new"}`;
  const [statement, setStatement, clearStatement] = useDraft(caseId, `${key}.statement`, finding?.statement ?? "");
  const [uncertainty, setUncertainty, clearUncertainty] = useDraft(caseId, `${key}.uncertainty`, finding?.uncertainty ?? "");
  const [picked, setPicked, clearPicked] = useDraft<string[]>(caseId, `${key}.observations`, finding?.observationIds ?? []);
  const choices = [...accepted, ...rec.observations.filter((o) => o.status !== "accepted" && finding?.observationIds.includes(o.id))];
  const sources = new Set(rec.evidence.filter((e) => choices.some((o) => picked.includes(o.id) && o.evidenceIds.includes(e.id))).flatMap((e) => (e.source ? [e.source] : [])));

  return (
    <form
      className="grid min-h-0 flex-1 flex-col"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          let saved;
          if (finding) {
            const { reviews: _r, tally: _t, missingObservations: _m, ...kept } = finding;
            saved = { ...kept, statement: statement.trim(), uncertainty, observationIds: picked };
          } else saved = newFinding(caseId, me, { statement, observationIds: picked, uncertainty });
          await save(caseId, "findings", saved);
          clearStatement();
          clearUncertainty();
          clearPicked();
          if (!finding) toast.success("Finding added", { description: "Your team can now review it." });
          onDone(saved.id);
        } catch (error) {
          toast.error(finding ? "Couldn't save the finding" : "Couldn't add the finding", { description: (error as Error).message });
        }
      }}
    >
      <div className="grid flex-1 content-start gap-5 p-4 md:p-6">
        <div className="grid gap-1.5">
          <Label htmlFor="nf-statement">What are you claiming?</Label>
          <Textarea id="nf-statement" required autoFocus value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="State it as you would print it." className="min-h-24 font-serif text-[1rem]" />
        </div>
        <div className="grid gap-2">
          <div className="flex items-baseline gap-2">
            <Label>What proves it?</Label>
            <span className={cn("ml-auto text-xs", sources.size >= 2 ? "text-protected" : "text-decoy")}>
              {picked.length === 0 ? "Tick at least one" : `${sources.size} source${sources.size === 1 ? "" : "s"}${sources.size >= 2 ? " ✓" : ", two needed to publish"}`}
            </span>
          </div>
          {choices.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No accepted observations yet. Check the new ones first.</p>
          ) : (
            <ul className="grid gap-2">
              {choices.map((o) => {
                const from = rec.evidence.filter((e) => o.evidenceIds.includes(e.id));
                return (
                  <li key={o.id}>
                    <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors has-[:checked]:border-protected/50 has-[:checked]:bg-protected-wash/40">
                      <Checkbox checked={picked.includes(o.id)} onCheckedChange={() => setPicked(picked.includes(o.id) ? picked.filter((x) => x !== o.id) : [...picked, o.id])} className="mt-0.5" />
                      <span className="grid gap-1">
                        <span className="font-serif text-[0.9375rem] leading-snug">{splitAi(o).text.slice(0, 300)}</span>
                        <span className="text-xs text-muted-foreground">{from.map((e) => e.source ?? "no source").join(", ") || "No evidence cited"}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="nf-uncertainty">What's still uncertain? (optional)</Label>
          <Input id="nf-uncertainty" value={uncertainty} onChange={(e) => setUncertainty(e.target.value)} />
        </div>
      </div>
      <div className={PANE_FOOTER}>
        {finding && <span className="text-xs text-muted-foreground">Reviews stay attached. Ask your team to look again if the meaning changed.</span>}
        <span className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              if (finding) {
                clearStatement();
                clearUncertainty();
                clearPicked();
              }
              onDone();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!picked.length || !statement.trim()}>
            {finding ? <Check /> : <Plus />} {finding ? "Save" : "Add finding"}
          </Button>
        </span>
      </div>
    </form>
  );
}
