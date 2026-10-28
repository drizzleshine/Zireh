import { evidenceHash, type CaseRecords } from "@zireh/cases";
import type { Evidence } from "@zireh/schema";
import { Check } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { filesOf, textOf } from "../../evidence.ts";
import { save } from "../../store.ts";
import { PANE_FOOTER } from "../Pane.tsx";
import { SourcePicker } from "../Sources.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * The author can retitle their evidence, change its source and rewrite their own text. Files stay
 * exactly as received (pictures can be redacted from the viewer); the fingerprint follows the text.
 */
export function EditEvidence({ caseId, rec, evidence: e, onDone }: { caseId: string; rec: CaseRecords; evidence: Evidence; onDone: () => void }) {
  const [title, setTitle] = useState(e.title);
  const [source, setSource] = useState(e.source);
  const original = textOf(e);
  const files = filesOf(e);
  const [body, setBody] = useState(original);

  return (
    <form
      className="grid"
      onSubmit={async (ev) => {
        ev.preventDefault();
        const { source: _old, kind: _kind, ...rest } = e;
        const text = body.trim();
        const next = { ...rest, title: title.trim(), body: text, ...(files.length ? { attachments: files } : {}), sha256: text === original && !e.kind ? e.sha256 : evidenceHash(text, files) };
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
        <div className="grid gap-1.5">
          <Label htmlFor="ee-body">Text</Label>
          <Textarea id="ee-body" required={!files.length} value={body} onChange={(ev) => setBody(ev.target.value)} className="min-h-40 font-serif text-[15px] leading-relaxed" />
        </div>
        {files.length > 0 && <p className="text-sm text-muted-foreground">Files stay exactly as received. To hide part of a picture, open it and use Redact.</p>}
      </div>
      <div className={PANE_FOOTER}>
        {body !== original && <span className="text-xs text-muted-foreground">Changing the text gives it a new fingerprint.</span>}
        <span className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!title.trim() || (!body.trim() && !files.length)}>
            <Check /> Save
          </Button>
        </span>
      </div>
    </form>
  );
}
