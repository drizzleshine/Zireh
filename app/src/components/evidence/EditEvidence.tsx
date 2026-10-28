import { sha256Hex } from "@zireh/crypto";
import type { CaseRecords } from "@zireh/cases";
import type { Evidence } from "@zireh/schema";
import { Check } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { save } from "../../store.ts";
import { PANE_FOOTER } from "../Pane.tsx";
import { SourcePicker } from "../Sources.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * The author can retitle their evidence and change its source. The text of a note or link they
 * wrote can change too, with a new fingerprint; a file or image stays exactly as received.
 */
export function EditEvidence({ caseId, rec, evidence: e, onDone }: { caseId: string; rec: CaseRecords; evidence: Evidence; onDone: () => void }) {
  const [title, setTitle] = useState(e.title);
  const [source, setSource] = useState(e.source);
  const [body, setBody] = useState(e.body);
  const editableBody = e.kind === "note" || e.kind === "link";

  return (
    <form
      className="grid"
      onSubmit={async (ev) => {
        ev.preventDefault();
        const { source: _old, ...rest } = e;
        const next = { ...rest, title: title.trim(), body, sha256: body === e.body ? e.sha256 : sha256Hex(body) };
        try {
          await save(caseId, "evidence", source ? { ...next, source } : next);
          onDone();
        } catch (error) {
          toast.error("Couldn't save the evidence", { description: (error as Error).message });
        }
      }}
    >
      <div className="grid content-start gap-5 p-4 md:p-6">
        <div className="grid gap-1.5">
          <Label htmlFor="ee-title">Title</Label>
          <Input id="ee-title" required autoFocus maxLength={200} value={title} onChange={(ev) => setTitle(ev.target.value)} />
        </div>
        <div className="grid justify-items-start gap-1.5">
          <Label>Source</Label>
          <SourcePicker rec={rec} value={source} onChange={setSource} />
        </div>
        {editableBody ? (
          <div className="grid gap-1.5">
            <Label htmlFor="ee-body">Text</Label>
            <Textarea id="ee-body" required value={body} onChange={(ev) => setBody(ev.target.value)} className="min-h-40 font-serif text-[15px] leading-relaxed" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">The content of a {e.kind === "image" ? "picture" : "file"} can't be changed, so its fingerprint still proves it's what you received.</p>
        )}
      </div>
      <div className={PANE_FOOTER}>
        {editableBody && body !== e.body && <span className="text-xs text-muted-foreground">Changing the text gives it a new fingerprint.</span>}
        <span className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!title.trim() || !body.trim()}>
            <Check /> Save
          </Button>
        </span>
      </div>
    </form>
  );
}
