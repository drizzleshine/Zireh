import { newEvidence } from "@zireh/cases";
import type { Pseudonym } from "@zireh/schema";
import { DownloadSimple as ArrowDownToLine, FileArrowUp as FileUp, CircleNotch as Loader2, Plus, UploadSimple as Upload } from "@phosphor-icons/react";
import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { toast } from "sonner";
import { fromFile, fromText, scan, type Draft } from "../../intake.ts";
import { myMemberId, save, useStore } from "../../store.ts";
import { useDraft } from "../../drafts.ts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DraftRow } from "./DraftRow.tsx";
import { ScanStrip } from "./ScanStrip.tsx";

/**
 * One box for everything: type or paste text, paste or drop a link, an image, a PDF or a
 * text file. Each becomes a draft the user can check before it joins the encrypted case file.
 */
export function Intake({ caseId, table, drafts, setDrafts }: { caseId: string; table: readonly Pseudonym[]; drafts: Draft[]; setDrafts: (fn: (d: Draft[]) => Draft[]) => void }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const [text, setText, clearText] = useDraft(caseId, "evidence.intake", "");
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(0);
  const [adding, setAdding] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const depth = useRef(0);

  const ingest = async (files: File[]) => {
    setReading((n) => n + files.length);
    for (const file of files) {
      try {
        const draft = await fromFile(file);
        setDrafts((d) => [...d, draft]);
      } catch (error) {
        toast.error("Couldn't read that file", { description: (error as Error).message });
      } finally {
        setReading((n) => n - 1);
      }
    }
  };

  const stageText = () => {
    if (!text.trim()) return;
    setDrafts((d) => [...d, fromText(text.trim())]);
    clearText();
  };

  const commit = async () => {
    const all = text.trim() ? [...drafts, fromText(text.trim())] : drafts;
    const invalid = all.find((d) => !d.title.trim() || !d.body);
    if (invalid) return void toast.error("Every item needs a title and content");
    setAdding(true);
    try {
      for (const d of all) {
        const evidence = newEvidence(caseId, myMemberId(caseId), { kind: d.kind, title: d.title.slice(0, 200), body: d.body });
        await save(caseId, "evidence", d.source ? { ...evidence, source: d.source } : evidence);
        setDrafts((ds) => ds.filter((x) => x.key !== d.key));
      }
      clearText();
      toast.success(all.length === 1 ? "Added to the case file" : `${all.length} items added to the case file`, { description: "Encrypted in this browser before syncing to your team." });
    } catch (error) {
      toast.error("Couldn't add evidence", { description: (error as Error).message });
    } finally {
      setAdding(false);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void ingest(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    const files = [...e.dataTransfer.files];
    if (files.length) return void ingest(files);
    const dropped = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (dropped.trim()) setDrafts((d) => [...d, fromText(dropped.trim())]);
  };

  const live = useMemo(() => scan(text, table), [text, table]);
  const total = drafts.length + (text.trim() ? 1 : 0);

  return (
    <div className="grid gap-3">
      <div
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
        className={cn(
          "sticky bottom-4 z-10 min-w-0 rounded-2xl border bg-card shadow-[0_12px_32px_-16px_rgb(0_0_0/0.45)] transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20",
          over && "border-protected ring-[3px] ring-protected/25",
        )}
      >
        <Textarea
          ref={textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
          }}
          placeholder="Paste or type here, or drop files… Everything is read, scanned and encrypted in this browser."
          aria-label="New evidence"
          className="min-h-24 resize-none border-0 bg-transparent px-4 pt-4 md:px-6 md:pt-6 font-serif text-[17px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[17px] dark:bg-transparent"
        />
        {live.length > 0 && <ScanStrip hits={live} caseId={caseId} table={table} className="px-4 pb-2 md:px-6" />}
        <div className="footer">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,application/pdf,.pdf,text/*,.md,.csv,.json,.log,.eml,.html,.xml,.yaml,.yml,.srt,.vtt"
            onChange={(e) => {
              void ingest([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => fileInput.current?.click()} className="text-muted-foreground">
            <FileUp /> Attach files
          </Button>
          {reading > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Reading {reading} file{reading === 1 ? "" : "s"} on this device…
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {text.trim() && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="outline" size="sm" onClick={stageText}>
                    <Plus /> Add another
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Keep this ready to add, and write or drop the next one</TooltipContent>
              </Tooltip>
            )}
            <Button type="button" size="sm" disabled={!total || adding || reading > 0} onClick={() => void commit()}>
              {adding ? <Loader2 className="animate-spin" /> : <Upload />}
              {total > 1 ? `Add ${total} to case` : "Add to case"}
              <Kbd className="ml-1 hidden bg-primary-foreground/15 text-primary-foreground sm:inline-flex">⌘↵</Kbd>
            </Button>
          </span>
        </div>
        {over && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-protected-wash/90 text-protected">
            <span className="flex items-center gap-2 text-sm font-medium">
              <ArrowDownToLine className="size-5" /> Drop to read on this device. Nothing is uploaded.
            </span>
          </div>
        )}
      </div>

      {drafts.length > 0 && (
        <ul className="grid gap-2" aria-label="Staged evidence">
          {drafts.map((d) => (
            <DraftRow
              key={d.key}
              rec={rec}
              caseId={caseId}
              draft={d}
              table={table}
              onChange={(patch) => setDrafts((ds) => ds.map((x) => (x.key === d.key ? { ...x, ...patch } : x)))}
              onRemove={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
