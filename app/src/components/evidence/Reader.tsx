import { evidenceHash, memberName, newObservation } from "@zireh/cases";
import type { Evidence, Pseudonym } from "@zireh/schema";
import { PencilSimple, Sparkle, EyeSlash as EyeOff, Lightbulb, LinkSimple as Link2, User as UserRound } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { filesOf, readableText, textOf } from "../../evidence.ts";
import { replaceImage, scan } from "../../intake.ts";
import { myMemberId, save, useStore } from "../../store.ts";
import type { OpenItem } from "../CaseView.tsx";
import { useDraft } from "../../drafts.ts";
import { askAbout } from "../ResearchPanel.tsx";
import { SourcePicker } from "../Sources.tsx";
import { Comments } from "../Comments.tsx";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Pane } from "../Pane.tsx";
import { evidenceIcon, FileTile, FileViewer } from "./Files.tsx";
import { ago } from "./ago.ts";
import { Highlighted } from "./Highlighted.tsx";

/** The reading pane: the whole item, where it came from, what it is used in, and what to do with it. */
export function Reader({ caseId, evidence: e, query, table, onOpen, onEdit }: { caseId: string; evidence: Evidence; query: string; table: readonly Pseudonym[]; onOpen: OpenItem; onEdit: () => void }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const mine = e.addedBy === myMemberId(caseId);
  const [note, setNote, clearNote] = useDraft(caseId, `observation.${e.id}`, "");
  const [noting, setNoting] = useState(false);
  // A half-written observation reopens where it was left.
  const writing = noting || note.length > 0;
  const [viewing, setViewing] = useState<number>();
  const text = textOf(e);
  const files = filesOf(e);
  const hits = useMemo(() => scan(readableText(e), table), [e, table]);
  const used = rec.observations.filter((o) => o.evidenceIds.includes(e.id) && o.status !== "rejected");
  const Icon = evidenceIcon(e);
  const url = /https?:\/\/[^\s]+/.exec(text)?.[0];

  return (
    <Pane
      aria-label={e.title}
      bodyClassName="grid gap-5 p-4 md:p-6"
      footer={
        <>
          <span className="font-mono text-[0.6875rem] text-muted-foreground" title={e.sha256}>
            sha256 {e.sha256.slice(0, 16)}…
          </span>
          <span className="ml-auto flex items-center gap-1">
            {mine && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onEdit}>
                <PencilSimple /> Edit
              </Button>
            )}
            <Comments caseId={caseId} targetId={e.id} />
          </span>
        </>
      }
    >
      <header className="grid gap-1.5">
        <h2 className="text-lg leading-snug font-semibold text-pretty">{e.title}</h2>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Icon className="size-3.5" /> {files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "Text"}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            added by {memberName(rec, e.addedBy)}, {ago(e.addedAt)}
          </span>
          <span aria-hidden="true">·</span>
          {mine ? (
            <SourcePicker
              plain
              rec={rec}
              value={e.source}
              onChange={(source) => {
                const { source: _old, ...rest } = e;
                void save(caseId, "evidence", source ? { ...rest, source } : rest).catch((error: Error) => toast.error("Couldn't change the source", { description: error.message }));
              }}
            />
          ) : (
            <span className={cn("inline-flex items-center gap-1", e.source ? "text-foreground/80" : "text-decoy")} title={`Only ${memberName(rec, e.addedBy)} can change the source of their evidence.`}>
              <UserRound className="size-3.5" /> {e.source ?? "No source"}
            </span>
          )}
        </p>
      </header>

      {writing && (
        <form
          className="field rounded-xl bg-protected-wash/40 p-4"
          onSubmit={async (ev) => {
            ev.preventDefault();
            try {
              await save(caseId, "observations", newObservation(caseId, { kind: "member", memberId: myMemberId(caseId) }, { text: note, evidenceIds: [e.id] }));
              clearNote();
              setNoting(false);
              toast.success("Observation saved", { description: "It can now back a finding." });
            } catch (error) {
              toast.error("Couldn't save the observation", { description: (error as Error).message });
            }
          }}
        >
          <label htmlFor={`obs-${e.id}`} className="text-sm font-medium">
            What do you see in this?
          </label>
          <Textarea id={`obs-${e.id}`} autoFocus required value={note} onChange={(ev) => setNote(ev.target.value)} className="min-h-20 bg-card font-serif text-[0.9375rem]" />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                clearNote();
                setNoting(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm">
              <Lightbulb /> Save observation
            </Button>
          </div>
        </form>
      )}

      {text && (
        <div className="grid max-w-[70ch] gap-2">
          {url && (
            <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1.5 truncate text-sm text-protected underline-offset-2 hover:underline" title="Opens outside Zireh, from your own connection">
              <Link2 className="size-3.5 shrink-0" />
              <span className="truncate">{url}</span>
            </a>
          )}
          <p className="font-serif text-[1rem] leading-relaxed whitespace-pre-wrap">
            <Highlighted text={text.slice(0, 200_000)} hits={hits} query={query} />
          </p>
          {text.length > 200_000 && <p className="text-xs text-muted-foreground">Showing the first 200,000 characters.</p>}
        </div>
      )}

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-3" aria-label="Files">
          {files.map((f, i) => (
            <li key={`${f.sha256}-${i}`}>
              <FileTile file={f} onOpen={() => setViewing(i)} />
            </li>
          ))}
        </ul>
      )}

      {hits.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <EyeOff className="size-3.5 text-protected" /> {hits.length} detail{hits.length === 1 ? "" : "s"} {text ? "underlined here" : "in this item's text"} {hits.length === 1 ? "is" : "are"} replaced before anything goes to an AI.
        </p>
      )}

      <FileViewer
        files={files}
        index={viewing}
        onIndex={setViewing}
        onClose={() => setViewing(undefined)}
        {...(mine
          ? {
              onRedact: (i: number, dataUrl: string) => {
                const attachments = files.map((f, j) => (j === i ? replaceImage(f, dataUrl) : f));
                const { kind: _kind, ...rest } = e;
                void save(caseId, "evidence", { ...rest, body: text, attachments, sha256: evidenceHash(text, attachments) })
                  .then(() => toast.success("Picture redacted", { description: "The hidden areas are gone from the saved copy." }))
                  .catch((error: Error) => toast.error("Couldn't save the redaction", { description: error.message }));
              },
            }
          : {})}
      />

      <div className="grid gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Used in</p>
        {used.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet. Add an observation to start building on it.</p>
        ) : (
          <ul className="grid gap-2">
            {used.map((o) => (
              <li key={o.id} className="border-l-2 pl-3 text-sm">
                <button type="button" onClick={() => onOpen("findings", o.id)} className="text-left underline-offset-4 hover:underline">
                  {o.text.replace(/^Q: .*\n\n/, "").replace(/\s*\[A\d+\]/g, "").slice(0, 140)}
                </button>
                <span className="text-xs text-muted-foreground"> · {o.status === "draft" ? "to check" : "accepted"}</span>
              </li>
            ))}
          </ul>
        )}
        {!writing && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => setNoting(true)}>
              <Lightbulb /> Add observation
            </Button>
            {readableText(e) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  askAbout(caseId, e.id, rec.case.privacy);
                  onOpen("research");
                }}
              >
                <Sparkle /> Ask AI about this
              </Button>
            )}
          </div>
        )}
      </div>
    </Pane>
  );
}
