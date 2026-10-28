import { newFinding, type CaseRecords } from "@zireh/cases";
import type { Observation } from "@zireh/schema";
import { Check, Plus } from "@phosphor-icons/react";
import { toast } from "sonner";
import { useDraft } from "../../drafts.ts";
import { save } from "../../store.ts";
import { PANE_FOOTER, SHEET_HEADER } from "../Pane.tsx";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { splitAi } from "./splitAi.ts";

/** Write the claim first, then tick what proves it; the source count updates as you tick. */
export function NewFindingSheet({ caseId, rec, me, accepted, open, onClose }: { caseId: string; rec: CaseRecords; me: string; accepted: Observation[]; open: boolean; onClose: () => void }) {
  // Kept as a draft: closing the panel half-way and coming back finds it as you left it.
  const [statement, setStatement, clearStatement] = useDraft(caseId, "finding.new.statement", "");
  const [uncertainty, setUncertainty, clearUncertainty] = useDraft(caseId, "finding.new.uncertainty", "");
  const [picked, setPicked, clearPicked] = useDraft<string[]>(caseId, "finding.new.observations", []);
  const sources = new Set(rec.evidence.filter((e) => accepted.some((o) => picked.includes(o.id) && o.evidenceIds.includes(e.id))).flatMap((e) => (e.source ? [e.source] : [])));

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className={SHEET_HEADER}>
          <SheetTitle>New finding</SheetTitle>
          <SheetDescription>A sentence you'd print, and the accepted observations that prove it.</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await save(caseId, "findings", newFinding(caseId, me, { statement, observationIds: picked, uncertainty }));
              clearStatement();
              clearUncertainty();
              clearPicked();
              toast.success("Finding added", { description: "Your team can now review it." });
              onClose();
            } catch (error) {
              toast.error("Couldn't add the finding", { description: (error as Error).message });
            }
          }}
        >
          <div className="grid flex-1 content-start gap-5 overflow-y-auto p-5">
            <div className="grid gap-1.5">
              <Label htmlFor="nf-statement">What are you claiming?</Label>
              <Textarea id="nf-statement" required autoFocus value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="State it as you would print it." className="min-h-24 font-serif text-[16px]" />
            </div>
            <div className="grid gap-2">
              <div className="flex items-baseline gap-2">
                <Label>What proves it?</Label>
                <span className={cn("ml-auto text-xs", sources.size >= 2 ? "text-protected" : "text-decoy")}>
                  {picked.length === 0 ? "Tick at least one" : `${sources.size} source${sources.size === 1 ? "" : "s"}${sources.size >= 2 ? " ✓" : ", two needed to publish"}`}
                </span>
              </div>
              {accepted.length === 0 ? (
                <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No accepted observations yet. Check the new ones first.</p>
              ) : (
                <ul className="grid gap-2">
                  {accepted.map((o) => {
                    const from = rec.evidence.filter((e) => o.evidenceIds.includes(e.id));
                    return (
                      <li key={o.id}>
                        <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors has-[:checked]:border-protected/50 has-[:checked]:bg-protected-wash/40">
                          <Checkbox checked={picked.includes(o.id)} onCheckedChange={() => setPicked(picked.includes(o.id) ? picked.filter((x) => x !== o.id) : [...picked, o.id])} className="mt-0.5" />
                          <span className="grid gap-1">
                            <span className="font-serif text-[15px] leading-snug">{splitAi(o).text.slice(0, 300)}</span>
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
          <div className={cn(PANE_FOOTER, "justify-end")}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!picked.length || !statement.trim()}>
              <Plus /> Add finding
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
