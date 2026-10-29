import { evidenceHash, type CaseRecords } from "@zireh/cases";
import { MAX_ATTACHMENT_BYTES, type Attachment, type Evidence } from "@zireh/schema";
import { Check, CircleNotch as Loader2, Paperclip } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { filesOf, formatBytes, textOf } from "../../evidence.ts";
import { readFile, replaceImage } from "../../intake.ts";
import { save } from "../../store.ts";
import { PANE_FOOTER } from "../Pane.tsx";
import { SourcePicker } from "../Sources.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FileTile, FileViewer } from "./Files.tsx";

/**
 * The author can retitle their evidence, change its source, rewrite their own text and add or
 * remove files (pictures can be redacted too). Every change to text or files gives a new fingerprint.
 */
export function EditEvidence({ caseId, rec, evidence: e, onDone }: { caseId: string; rec: CaseRecords; evidence: Evidence; onDone: () => void }) {
  const [title, setTitle] = useState(e.title);
  const [source, setSource] = useState(e.source);
  const original = textOf(e);
  const originalFiles = filesOf(e);
  const [body, setBody] = useState(original);
  const [files, setFiles] = useState<Attachment[]>(originalFiles);
  const [reading, setReading] = useState(0);
  const [viewing, setViewing] = useState<number>();
  const fileInput = useRef<HTMLInputElement>(null);
  const total = files.reduce((n, f) => n + f.size, 0);
  const filesChanged = files.length !== originalFiles.length || files.some((f, i) => f.sha256 !== originalFiles[i]?.sha256);
  const changed = body.trim() !== original || filesChanged;

  const ingest = async (list: File[]) => {
    setReading((n) => n + list.length);
    for (const file of list) {
      try {
        const attachment = await readFile(file);
        setFiles((all) => {
          if (all.reduce((n, a) => n + a.size, 0) + attachment.size > MAX_ATTACHMENT_BYTES) {
            toast.error(`${file.name} doesn't fit`, { description: `Files on one item can total ${formatBytes(MAX_ATTACHMENT_BYTES)}. Add it as a separate item.` });
            return all;
          }
          return [...all, attachment];
        });
      } catch (error) {
        toast.error("Couldn't read that file", { description: (error as Error).message });
      } finally {
        setReading((n) => n - 1);
      }
    }
  };

  return (
    <form
      className="grid"
      onSubmit={async (ev) => {
        ev.preventDefault();
        const { source: _old, kind: _kind, attachments: _files, ...rest } = e;
        const text = body.trim();
        const next = { ...rest, title: title.trim(), body: text, ...(files.length ? { attachments: files } : {}), sha256: changed || e.kind ? evidenceHash(text, files) : e.sha256 };
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
          <Textarea id="ee-body" required={!files.length} value={body} onChange={(ev) => setBody(ev.target.value)} className="min-h-40 font-serif text-[0.9375rem] leading-relaxed" />
        </div>
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Label>Files</Label>
            <span className="text-xs text-muted-foreground tabular-nums">{reading > 0 ? "Reading on this device…" : `${formatBytes(total)} of ${formatBytes(MAX_ATTACHMENT_BYTES)}`}</span>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(ev) => {
                void ingest([...(ev.target.files ?? [])]);
                ev.target.value = "";
              }}
            />
            <Button type="button" size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => fileInput.current?.click()}>
              {reading > 0 ? <Loader2 className="animate-spin" /> : <Paperclip />} Attach
            </Button>
          </div>
          {files.length > 0 ? (
            <ul className="flex flex-wrap gap-3" aria-label="Files">
              {files.map((f, i) => (
                <li key={`${f.sha256}-${i}`}>
                  <FileTile file={f} onOpen={() => setViewing(i)} onRemove={() => setFiles((all) => all.filter((_, j) => j !== i))} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No files. Attach pictures, PDFs, documents or recordings.</p>
          )}
        </div>
      </div>
      <div className={PANE_FOOTER}>
        {changed && <span className="text-xs text-muted-foreground">Changing the text or files gives this item a new fingerprint.</span>}
        <span className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!title.trim() || (!body.trim() && !files.length) || reading > 0}>
            <Check /> Save
          </Button>
        </span>
      </div>
      <FileViewer
        files={files}
        index={viewing}
        onIndex={setViewing}
        onClose={() => setViewing(undefined)}
        onRedact={(i, dataUrl) => setFiles((all) => all.map((f, j) => (j === i ? replaceImage(f, dataUrl) : f)))}
      />
    </form>
  );
}
