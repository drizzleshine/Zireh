import { memberName, type CaseRecords } from "@zireh/cases";
import type { Observation } from "@zireh/schema";
import { Check, CheckCircle, XCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { save } from "../../store.ts";
import type { OpenItem } from "../CaseView.tsx";
import { Comments } from "../Comments.tsx";
import { PANE_FOOTER, SHEET_HEADER } from "../Pane.tsx";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { splitAi } from "./splitAi.ts";

/** One observation at a time, next to what it cites, with accept or reject. */
export function CheckSheet({ caseId, rec, drafts, start, open, onClose, onOpen }: { caseId: string; rec: CaseRecords; drafts: Observation[]; start: string | undefined; open: boolean; onClose: () => void; onOpen?: OpenItem | undefined }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (open) setIndex(Math.max(0, drafts.findIndex((o) => o.id === start)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, start]);
  const o = drafts[Math.min(index, drafts.length - 1)];
  const decide = (status: "accepted" | "rejected") => {
    if (!o) return;
    void save(caseId, "observations", { ...o, status }).catch((error: Error) => toast.error("Couldn't save", { description: error.message }));
  };
  const parts = o ? splitAi(o) : undefined;
  const cited = o ? rec.evidence.filter((e) => o.evidenceIds.includes(e.id)) : [];

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className={SHEET_HEADER}>
          <SheetTitle>Check observations</SheetTitle>
          <SheetDescription>{o ? `${Math.min(index, drafts.length - 1) + 1} of ${drafts.length}. Does the evidence really show this?` : "Nothing left to check."}</SheetDescription>
        </SheetHeader>
        {o && parts ? (
          <>
            <div className="grid flex-1 content-start gap-5 overflow-y-auto p-5">
              <div className="grid gap-1.5">
                <p className="text-xs text-muted-foreground">
                  {o.author.kind === "ai" ? `AI answer saved by ${memberName(rec, o.author.requestedBy)}` : `Noticed by ${memberName(rec, o.author.memberId)}`}
                </p>
                {parts.question && <p className="text-sm text-muted-foreground">Asked: {parts.question}</p>}
                <p className="font-serif text-[17px] leading-relaxed whitespace-pre-wrap">{parts.text}</p>
                {o.author.kind === "ai" && <p className="text-xs text-decoy">An AI wrote this. Only accept what the evidence below actually supports.</p>}
              </div>
              <div className="grid gap-2">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">The evidence it cites</p>
                {cited.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None. Accept it only if you can check it some other way.</p>
                ) : (
                  cited.map((e) => (
                    <div key={e.id} className="grid gap-1 rounded-xl border bg-muted/30 p-3">
                      <button type="button" onClick={() => onOpen?.("evidence", e.id)} className="justify-self-start text-sm font-medium underline-offset-4 hover:underline">
                        {e.title}
                      </button>
                      <span className={cn("text-xs", e.source ? "text-muted-foreground" : "text-decoy")}>{e.source ?? "No source set"}</span>
                      {e.kind !== "image" && <p className="line-clamp-6 font-serif text-sm leading-relaxed text-foreground/80">{e.body.slice(0, 800)}</p>}
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className={PANE_FOOTER}>
              {drafts.length > 1 && (
                <Button variant="ghost" size="sm" onClick={() => setIndex((i) => (i + 1) % drafts.length)}>
                  Skip
                </Button>
              )}
              <Comments caseId={caseId} targetId={o.id} />
              <Button variant="outline" className="ml-auto" onClick={() => decide("rejected")}>
                <XCircle /> Reject
              </Button>
              <Button onClick={() => decide("accepted")}>
                <CheckCircle /> Accept
              </Button>
            </div>
          </>
        ) : (
          <div className="grid flex-1 place-content-center justify-items-center gap-3 p-8 text-center">
            <CheckCircle className="size-10 text-protected" weight="duotone" />
            <p className="text-sm text-muted-foreground">All observations are checked.</p>
            <Button variant="outline" onClick={onClose}>
              Done
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
