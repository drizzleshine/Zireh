import { newEvidence } from "@zireh/cases";
import { MAX_ATTACHMENT_BYTES, type Attachment, type Pseudonym } from "@zireh/schema";
import { DownloadSimple as ArrowDownToLine, CircleNotch as Loader2, Paperclip, UploadSimple as Upload } from "@phosphor-icons/react";
import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { toast } from "sonner";
import { formatBytes } from "../../evidence.ts";
import { readFile, replaceImage, scan, titleFor } from "../../intake.ts";
import { myMemberId, save, useStore } from "../../store.ts";
import { useDraft } from "../../drafts.ts";
import { PANE_FOOTER } from "../Pane.tsx";
import { SourcePicker } from "../Sources.tsx";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { FileTile, FileViewer } from "./Files.tsx";
import { ScanStrip } from "./ScanStrip.tsx";

/**
 * One box for everything: write what this is, attach any mix of files (pictures, PDFs,
 * documents, recordings), pick who it came from. It all becomes one item in the case file.
 */
export function Intake({ caseId, table, files, setFiles, onAdded }: { caseId: string; table: readonly Pseudonym[]; files: Attachment[]; setFiles: (fn: (f: Attachment[]) => Attachment[]) => void; onAdded: (id: string) => void }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const [text, setText, clearText] = useDraft(caseId, "evidence.intake", "");
  const [title, setTitle, clearTitle] = useDraft(caseId, "evidence.intake.title", "");
  const [source, setSource] = useState<string>();
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(0);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<number>();
  const fileInput = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const total = files.reduce((n, f) => n + f.size, 0);

  const ingest = async (list: File[]) => {
    setReading((n) => n + list.length);
    for (const file of list) {
      try {
        const attachment = await readFile(file);
        setFiles((f) => {
          if (f.reduce((n, a) => n + a.size, 0) + attachment.size > MAX_ATTACHMENT_BYTES) {
            toast.error(`${file.name} doesn't fit`, { description: `Files on one item can total ${formatBytes(MAX_ATTACHMENT_BYTES)}. Add it as a separate item.` });
            return f;
          }
          return [...f, attachment];
        });
      } catch (error) {
        toast.error("Couldn't read that file", { description: (error as Error).message });
      } finally {
        setReading((n) => n - 1);
      }
    }
  };

  const commit = async () => {
    if (!text.trim() && !files.length) return;
    setAdding(true);
    try {
      const evidence = newEvidence(caseId, myMemberId(caseId), { title: (title.trim() || titleFor(text, files)).slice(0, 200), body: text.trim(), attachments: files });
      await save(caseId, "evidence", source ? { ...evidence, source } : evidence);
      clearText();
      clearTitle();
      setFiles(() => []);
      setSource(undefined);
      toast.success("Added to the case file", { description: "Encrypted in this browser before syncing to your team." });
      onAdded(evidence.id);
    } catch (error) {
      toast.error("Couldn't add evidence", { description: (error as Error).message });
    } finally {
      setAdding(false);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length) {
      e.preventDefault();
      void ingest(pasted);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    const dropped = [...e.dataTransfer.files];
    if (dropped.length) return void ingest(dropped);
    const link = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (link.trim()) setText(text ? `${text}\n${link.trim()}` : link.trim());
  };

  const live = useMemo(() => scan(text, table), [text, table]);

  return (
    <div
      className="relative grid"
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        if (--depth.current <= 0) setOver(false);
      }}
      onDrop={onDrop}
    >
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-3 px-4 pt-4 md:px-6 md:pt-6" aria-label="Attached files">
          {files.map((f, i) => (
            <li key={`${f.sha256}-${i}`}>
              <FileTile file={f} onOpen={() => setViewing(i)} onRemove={() => setFiles((all) => all.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ul>
      )}
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        placeholder={text.trim() || files.length ? `Title: ${titleFor(text, files)}` : "Title (optional)"}
        aria-label="Title"
        className="mx-4 mt-4 h-auto w-auto border-0 bg-transparent px-0 text-base font-semibold shadow-none focus-visible:ring-0 md:mx-6 md:mt-5 md:text-base dark:bg-transparent"
      />
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void commit();
          }
        }}
        autoFocus
        placeholder="What is this, and where did it come from? Paste text or a link, or drop files."
        aria-label="New evidence"
        className="min-h-32 resize-none border-0 bg-transparent px-4 pt-4 font-serif text-[1.0625rem] leading-relaxed shadow-none focus-visible:ring-0 md:px-6 md:pt-5 md:text-[1.0625rem] dark:bg-transparent"
      />
      {live.length > 0 && <ScanStrip hits={live} className="px-4 pb-2 md:px-6" />}
      <div className={PANE_FOOTER}>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void ingest([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <Button type="button" variant="ghost" size="sm" onClick={() => fileInput.current?.click()} className="text-muted-foreground">
          <Paperclip /> Attach
        </Button>
        <SourcePicker rec={rec} value={source} onChange={setSource} />
        {reading > 0 ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Reading on this device…
          </span>
        ) : (
          total > 0 && <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(total)} of {formatBytes(MAX_ATTACHMENT_BYTES)}</span>
        )}
        <Button type="button" size="sm" className="ml-auto" disabled={(!text.trim() && !files.length) || adding || reading > 0} onClick={() => void commit()}>
          {adding ? <Loader2 className="animate-spin" /> : <Upload />}
          Add to case
          <Kbd className="ml-1 hidden bg-primary-foreground/15 text-primary-foreground sm:inline-flex">⌘↵</Kbd>
        </Button>
      </div>
      <div className={cn("pointer-events-none absolute inset-0 grid place-items-center rounded-b-2xl bg-protected-wash/90 text-protected transition-opacity", over ? "opacity-100" : "opacity-0")}>
        <span className="flex items-center gap-2 text-sm font-medium">
          <ArrowDownToLine className="size-5" /> Drop to read on this device. Nothing is uploaded yet.
        </span>
      </div>
      <FileViewer
        files={files}
        index={viewing}
        onIndex={setViewing}
        onClose={() => setViewing(undefined)}
        onRedact={(i, dataUrl) => setFiles((all) => all.map((f, j) => (j === i ? replaceImage(f, dataUrl) : f)))}
      />
    </div>
  );
}
