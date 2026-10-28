import { type FindingView } from "@zireh/cases";
import { X } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { save } from "../../store.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Authors can reword their own finding; the evidence it rests on stays the same. */
export function EditFinding({ caseId, finding: f, onDone }: { caseId: string; finding: FindingView; onDone: () => void }) {
  const [statement, setStatement] = useState(f.statement);
  const [uncertainty, setUncertainty] = useState(f.uncertainty);
  return (
    <form
      className="grid gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const { reviews: _r, tally: _t, missingObservations: _m, ...finding } = f;
        try {
          await save(caseId, "findings", { ...finding, statement: statement.trim(), uncertainty });
          onDone();
        } catch (error) {
          toast.error("Couldn't save the finding", { description: (error as Error).message });
        }
      }}
    >
      <Textarea required autoFocus value={statement} onChange={(e) => setStatement(e.target.value)} aria-label="Finding" className="min-h-20 font-serif text-[16px]" />
      <Input value={uncertainty} onChange={(e) => setUncertainty(e.target.value)} placeholder="What's still uncertain?" aria-label="What's still uncertain?" />
      <p className="text-xs text-muted-foreground">Reviews stay attached. Ask your team to look again if the meaning changed.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          <X /> Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!statement.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}
