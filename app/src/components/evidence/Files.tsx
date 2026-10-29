import type { Attachment, Evidence } from "@zireh/schema";
import { CaretLeft, CaretRight, DownloadSimple, EyeSlash, File as FileIcon, FilePdf, FileText, FilmStrip, Image as ImageIcon, LinkSimple, MusicNotes, Note, Paperclip, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { downloadFile, fileUrl, filesOf, formatBytes, textOf, viewOf, type FileView } from "../../evidence.ts";
import { ImageRedactor } from "../ImageRedactor.tsx";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const ICON: Record<FileView, typeof FileIcon> = { image: FileIcon, pdf: FilePdf, text: FileText, audio: MusicNotes, video: FilmStrip, other: FileIcon };
const ext = (name: string) => /\.([^.]{1,5})$/.exec(name)?.[1]?.toUpperCase() ?? "FILE";

/** One icon for a list row: what the item mostly is. */
export function evidenceIcon(e: Evidence): typeof FileIcon {
  const files = filesOf(e);
  if (files.length > 1) return Paperclip;
  if (files.length === 1) return viewOf(files[0]!) === "image" ? ImageIcon : ICON[viewOf(files[0]!)];
  return /^\s*https?:\/\/\S+/.test(textOf(e)) ? LinkSimple : Note;
}

/**
 * A blob URL for as long as the component shows the file. Created and revoked in the same
 * effect, so a re-run (React's development double-run, or a new file after a redaction) never
 * leaves the image pointing at a revoked URL.
 */
function useFileUrl(file: Attachment | undefined, enabled = true) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file || !enabled) return setUrl(undefined);
    const next = fileUrl(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file?.sha256, file?.data.length, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return url;
}

/** One square tile: a thumbnail for pictures, the file type for everything else. */
export function FileTile({ file, onOpen, onRemove, size = "md" }: { file: Attachment; onOpen: () => void; onRemove?: () => void; size?: "sm" | "md" }) {
  const view = viewOf(file);
  const url = useFileUrl(file, view === "image");
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const Icon = view === "image" ? ImageIcon : ICON[view];
  return (
    <div className={cn("group relative shrink-0", size === "sm" ? "size-16" : "size-24")}>
      <button type="button" onClick={onOpen} title={`${file.name} · ${formatBytes(file.size)}`} className="flex size-full flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border bg-muted/40 text-muted-foreground transition-colors hover:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none">
        {url && !broken ? (
          <img src={url} alt={file.name} onError={() => setBroken(true)} className="size-full object-cover" />
        ) : (
          <>
            <Icon className="size-6" />
            <span className="text-[0.625rem] font-medium tracking-wide">{ext(file.name)}</span>
            {size === "md" && <span className="w-full truncate px-2 text-center text-[0.6875rem]">{file.name}</span>}
          </>
        )}
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${file.name}`} className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-foreground">
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/**
 * Full-screen viewer for an item's files. Arrows (or the arrow keys) move between them.
 * Pictures can be redacted when the viewer is given onRedact; files the browser can't show
 * safely offer a download instead.
 */
export function FileViewer({ files, index, onIndex, onClose, onRedact }: { files: readonly Attachment[]; index: number | undefined; onIndex: (i: number) => void; onClose: () => void; onRedact?: (i: number, dataUrl: string) => void }) {
  const file = index === undefined ? undefined : files[index];
  const view = file ? viewOf(file) : "other";
  const url = useFileUrl(file, view === "image" || view === "audio" || view === "video");
  const [redacting, setRedacting] = useState(false);
  // The redacted picture, shown at once while the save comes back with the new file.
  const [fresh, setFresh] = useState<string>();
  const [broken, setBroken] = useState(false);
  const step = (by: number) => index !== undefined && files.length > 1 && onIndex((index + by + files.length) % files.length);

  useEffect(() => {
    setRedacting(false);
    setFresh(undefined);
  }, [index]);
  useEffect(() => setFresh(undefined), [file?.sha256]);
  useEffect(() => setBroken(false), [url, fresh]);

  return (
    <Dialog open={!!file} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={(e) => {
          if (redacting) return;
          if (e.key === "ArrowRight") step(1);
          if (e.key === "ArrowLeft") step(-1);
        }}
        className="flex h-[92svh] max-w-[min(96vw,1400px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,1400px)]"
      >
        {file && (
          <>
            <header className="flex items-center gap-2 border-b px-4 py-2.5">
              <div className="grid min-w-0 flex-1">
                <DialogTitle className="truncate text-sm font-medium">{file.name}</DialogTitle>
                <DialogDescription className="text-xs">
                  {files.length > 1 ? `${index! + 1} of ${files.length} · ` : ""}
                  {formatBytes(file.size)}
                </DialogDescription>
              </div>
              {onRedact && view === "image" && (
                <Button size="sm" variant={redacting ? "secondary" : "ghost"} onClick={() => setRedacting((r) => !r)}>
                  <EyeSlash /> {redacting ? "Done" : "Redact"}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => downloadFile(file)}>
                <DownloadSimple /> Download
              </Button>
              <Button size="icon" variant="ghost" className="size-8" onClick={onClose} aria-label="Close">
                <X />
              </Button>
            </header>
            <div className="relative grid min-h-0 flex-1 place-items-center bg-muted/30">
              {files.length > 1 && !redacting && (
                <>
                  <Button size="icon" variant="secondary" className="absolute top-1/2 left-3 z-10 -translate-y-1/2 rounded-full" onClick={() => step(-1)} aria-label="Previous file">
                    <CaretLeft />
                  </Button>
                  <Button size="icon" variant="secondary" className="absolute top-1/2 right-3 z-10 -translate-y-1/2 rounded-full" onClick={() => step(1)} aria-label="Next file">
                    <CaretRight />
                  </Button>
                </>
              )}
              {view === "image" && redacting && onRedact ? (
                <div className="p-4">
                  <ImageRedactor
                    src={fresh ?? `data:image/jpeg;base64,${file.data}`}
                    canvasClassName="block max-h-[70svh] max-w-full cursor-crosshair touch-none rounded-md"
                    onChange={(dataUrl) => {
                      setFresh(dataUrl);
                      setRedacting(false);
                      onRedact(index!, dataUrl);
                    }}
                  />
                </div>
              ) : view === "image" && (fresh || url) && !broken ? (
                <img src={fresh ?? url} alt={file.name} onError={() => setBroken(true)} className="absolute inset-0 size-full object-contain p-4" />
              ) : view === "pdf" ? (
                <PdfPages file={file} />
              ) : view === "text" ? (
                <pre className="absolute inset-0 overflow-auto p-6 font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap">{file.text}</pre>
              ) : view === "audio" && url ? (
                <audio src={url} controls className="w-[min(90%,30rem)]" />
              ) : view === "video" && url ? (
                <video src={url} controls className="absolute inset-0 size-full bg-black object-contain" />
              ) : (
                <Unviewable file={file} />
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * PDF pages drawn with pdf.js onto canvases: the same in every browser (embedded ones often lack
 * a PDF viewer), and scripts inside the PDF never run.
 */
function PdfPages({ file }: { file: Attachment }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const el = box.current!;
    el.replaceChildren();
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      const task = pdfjs.getDocument({ data: Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0)) });
      const doc = await task.promise;
      for (let i = 1; i <= doc.numPages && !cancelled; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (Math.min(el.clientWidth - 48, 1000) / base.width) * devicePixelRatio });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / devicePixelRatio}px`;
        canvas.className = "mx-auto rounded-sm bg-white shadow-sm";
        el.append(canvas);
        await page.render({ canvas, viewport }).promise;
      }
      await task.destroy();
    })().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [file]);
  if (failed) return <Unviewable file={file} />;
  return <div ref={box} className="absolute inset-0 grid content-start gap-4 overflow-auto p-6" />;
}

function Unviewable({ file }: { file: Attachment }) {
  return (
    <div className="grid justify-items-center gap-3 p-8 text-center">
      <FileIcon className="size-10 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">This file can't be shown here.</p>
      <Button size="sm" onClick={() => downloadFile(file)}>
        <DownloadSimple /> Download {ext(file.name)}
      </Button>
    </div>
  );
}
