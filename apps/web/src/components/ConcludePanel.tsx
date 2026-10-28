import { buildPublication, findingViews, latestConclusion, memberName, newConclusion, publicationTexts } from "@zireh/cases";
import { findLeaks } from "@zireh/redact";
import type { Outcome } from "@zireh/schema";
import { ArrowRight, Check, DownloadSimple as Download, CircleNotch as Loader2, Scan as ScanSearch } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { scanPublicationTexts } from "../api.ts";
import { corroboration, verbatimRuns } from "../sources.ts";
import { useDraft } from "../drafts.ts";
import { editPseudonym, myMemberId, save, savePseudonyms, useStore } from "../store.ts";
import type { OpenItem } from "./CaseView.tsx";
import { replyOpen, RightOfReply } from "./RightOfReply.tsx";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Pane } from "./Pane.tsx";
import { PageBar } from "./SectionTitle.tsx";
import { OUTCOMES } from "./conclude/outcomes.ts";
import { type State, Item } from "./conclude/Item.tsx";
import { PublicationPreview } from "./conclude/PublicationPreview.tsx";
import { download } from "./conclude/download.ts";

type Step = 1 | 2 | 3;
const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: "Outcome" },
  { n: 2, label: "Write-up" },
  { n: 3, label: "Check & publish" },
];

/**
 * Finishing a case, one step at a time: decide what you found, write it up, then check it the way
 * an editor or lawyer would and download the page. Later steps open once the earlier ones are done.
 */
export function ConcludePanel({ caseId, onOpen }: { caseId: string; onOpen: OpenItem }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const current = latestConclusion(rec);
  const findings = findingViews(rec);
  // Unsaved edits are drafts on top of the last saved version, so they survive a reload or a tab switch.
  const [outcome, setOutcome, clearOutcome] = useDraft<Outcome>(caseId, "conclude.outcome", current?.outcome ?? "unresolved");
  const [summary, setSummary, clearSummary] = useDraft(caseId, "conclude.summary", current?.summary ?? "");
  const [openQuestion, setOpenQuestion, clearOpen] = useDraft(caseId, "conclude.openQuestion", current?.openQuestion ?? "");
  const [picked, setPicked, clearPicked] = useDraft<string[]>(caseId, "conclude.findings", current?.findingIds ?? findings.filter((f) => f.tally.status === "supported").map((f) => f.id));
  const clearWriteUp = () => {
    clearOutcome();
    clearSummary();
    clearOpen();
    clearPicked();
  };
  const [step, setStep] = useState<Step>(current ? 3 : 1);
  const [hideNames, setHideNames] = useState(true);
  // Showing real names is allowed, but only once someone says why it's safe.
  const [namesAgreed, setNamesAgreed] = useState(false);
  const [scan, setScan] = useState<"idle" | "running" | "done" | string>("idle");
  const [showNames, setShowNames] = useState(false);

  const [scannedHash, setScannedHash] = useState<string>();
  const [reviewedHash, setReviewedHash] = useState<string>();
  const snapshot = current ? buildPublication(rec, { hideNames: false, publishedAt: current.createdAt }) : undefined;
  const preview = current ? buildPublication(rec, { hideNames, publishedAt: current.createdAt }) : undefined;
  const clean = !!preview && findLeaks(publicationTexts(preview.publication).join("\n"), rec.pseudonyms).length === 0;
  const scanned = !!snapshot && scannedHash === snapshot.hash;
  const approved = !!preview && reviewedHash === preview.hash;
  const unsaved = !current || outcome !== current.outcome || summary.trim() !== current.summary || openQuestion !== current.openQuestion || [...picked].sort().join() !== [...current.findingIds].sort().join();
  const disputedPicked = findings.filter((f) => picked.includes(f.id) && f.tally.status === "disputed").length;

  const chosen = findings.filter((f) => picked.includes(f.id));
  const thin = chosen.filter((f) => corroboration(rec, f).level !== "corroborated");
  const openReplies = rec.replies.filter((r) => replyOpen(r) && (r.findingIds.length === 0 || r.findingIds.some((id) => picked.includes(id))));
  const verbatim = useMemo(() => (preview ? verbatimRuns(publicationTexts(preview.publication).join("\n"), rec) : []), [preview?.hash, rec]);

  const sourcesState: State = chosen.length === 0 ? "todo" : thin.length ? "warn" : "done";
  const repliesState: State = openReplies.length ? "warn" : rec.replies.length ? "done" : "todo";
  const verbatimState: State = verbatim.length ? "warn" : "done";
  const namesState: State = hideNames ? (scanned && !clean ? "warn" : scanned && approved ? "done" : "todo") : namesAgreed ? "done" : "todo";
  const states = [sourcesState, repliesState, verbatimState, namesState];
  const done = states.filter((x) => x === "done").length;
  const canDownload = !!current && !unsaved && namesState === "done";
  const saved = !!current && !unsaved;
  const ask = OUTCOMES.find((o) => o.id === outcome)!;

  async function runScan() {
    setScan("running");
    setScannedHash(undefined);
    setReviewedHash(undefined);
    try {
      const table = await scanPublicationTexts(publicationTexts(snapshot!.publication), rec.pseudonyms);
      await savePseudonyms(caseId, table);
      setScannedHash(snapshot!.hash);
      setScan("done");
    } catch (err) {
      setScan((err as Error).message);
    }
  }

  return (
    <section className="page" aria-label="Conclude">
      <PageBar hint="Finish the case in three steps: what you found, how you'd put it, and the checks before it goes out." />

      <ol className="flex flex-wrap items-center gap-2" aria-label="Steps">
        {STEPS.map(({ n, label }, i) => {
          const reachable = n < 3 || saved;
          const complete = n === 1 ? step > 1 || !!current : n === 2 ? saved : canDownload;
          return (
            <li key={n} className="flex items-center gap-2">
              {i > 0 && <span className="h-px w-6 bg-border" aria-hidden="true" />}
              <button
                type="button"
                disabled={!reachable}
                onClick={() => setStep(n)}
                aria-current={step === n ? "step" : undefined}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-full border px-3 text-sm transition-colors disabled:opacity-50",
                  step === n ? "border-foreground/20 bg-card font-medium surface" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <span className={cn("grid size-5 place-items-center rounded-full text-[11px] font-semibold", complete ? "bg-protected text-background" : step === n ? "bg-foreground text-background" : "bg-muted text-muted-foreground")}>
                  {complete ? <Check className="size-3" weight="bold" /> : n}
                </span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <Pane title="What did you find?" meta="Pick the one that's fair to everyone in the story. You can change it later.">
          <div className="grid gap-3 p-4 md:grid-cols-3 md:p-6">
            {OUTCOMES.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  setOutcome(o.id);
                  setStep(2);
                }}
                className={cn("grid content-start gap-1.5 rounded-xl border p-4 text-left transition-colors hover:border-foreground/30", outcome === o.id && "border-protected/60 bg-protected-wash/40")}
              >
                <span className="flex items-center gap-2 font-medium">
                  {outcome === o.id && <Check className="size-4 text-protected" />}
                  {o.label}
                </span>
                <span className="text-sm text-muted-foreground">{o.plain}</span>
              </button>
            ))}
          </div>
        </Pane>
      )}

      {step === 2 && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!unsaved) return setStep(3);
            try {
              await save(caseId, "conclusions", newConclusion(caseId, myMemberId(caseId), current, { outcome, summary, findingIds: picked, openQuestion }));
              clearWriteUp();
              toast.success("Saved", { description: current ? `Version ${current.revision + 1}. Older versions are kept.` : "Now check it before it goes out." });
              setStep(3);
            } catch (error) {
              toast.error("Couldn't save", { description: (error as Error).message });
            }
          }}
        >
          <Pane
            title={`Write-up · ${ask.label}`}
            meta={!current ? "Not saved yet" : unsaved ? "Unsaved changes" : `Saved · version ${current.revision} by ${memberName(rec, current.createdBy)}`}
            bodyClassName="grid gap-6 p-4 md:p-6"
            footer={
              <>
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button type="submit" size="sm" className="ml-auto" disabled={!summary.trim() || picked.length === 0}>
                  {unsaved ? "Save and continue" : "Continue"} <ArrowRight />
                </Button>
              </>
            }
          >
            <div className="field">
              <Label htmlFor="c-summary">{ask.ask}</Label>
              <Textarea id="c-summary" required autoFocus maxLength={10_000} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Say it the way you'd tell your editor." className="min-h-32 font-serif text-[16px] leading-relaxed" />
            </div>
            <div className="field">
              <Label htmlFor="c-open">{ask.open}</Label>
              <Input id="c-open" maxLength={2000} required={outcome !== "resolved"} value={openQuestion} onChange={(e) => setOpenQuestion(e.target.value)} />
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Findings it rests on</legend>
              {findings.length === 0 && (
                <p className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No findings yet.
                  <Button type="button" size="sm" variant="outline" onClick={() => onOpen("findings")}>
                    Write one
                  </Button>
                </p>
              )}
              {findings.map((f) => {
                const c = corroboration(rec, f);
                return (
                  <label key={f.id} className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors has-[:checked]:border-protected/50 has-[:checked]:bg-protected-wash/40">
                    <Checkbox checked={picked.includes(f.id)} onCheckedChange={() => setPicked(picked.includes(f.id) ? picked.filter((x) => x !== f.id) : [...picked, f.id])} className="mt-0.5" />
                    <span className="flex-1 font-serif text-[15px] leading-snug">{f.statement}</span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
                      <span className={cn(c.level === "corroborated" ? "text-protected" : "text-decoy")}>{c.level === "corroborated" ? `${c.sources.length} sources` : c.level === "single" ? "1 source" : "No source"}</span>
                      <span className={cn(f.tally.status === "supported" ? "text-protected" : f.tally.status === "disputed" ? "text-destructive" : "text-muted-foreground")}>{f.tally.status === "supported" ? "Team agrees" : f.tally.status === "disputed" ? "Team disagrees" : f.tally.status === "needs-evidence" ? "Needs evidence" : "Not reviewed"}</span>
                    </span>
                  </label>
                );
              })}
              {disputedPicked > 0 && outcome === "resolved" && <p className="text-sm text-decoy">Your team disagrees on {disputedPicked} of these. “Disputed” may be fairer.</p>}
            </fieldset>
          </Pane>
        </form>
      )}

      {step === 3 && current && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Pane
            title="Before it goes out"
            meta="What an editor or lawyer asks first. Only the names check is required to download."
            actions={
              <Badge variant="outline" className={cn("font-normal tabular-nums", done === 4 ? "border-protected/30 bg-protected-wash text-protected" : "text-muted-foreground")}>
                {done} of 4 done
              </Badge>
            }
            footer={
              <div className="grid w-full gap-1.5 py-2">
                <Button
                  disabled={!canDownload}
                  onClick={() => {
                    if (!current || unsaved) return;
                    const plain = buildPublication(rec, { hideNames: false, publishedAt: current.createdAt });
                    const final = buildPublication(rec, { hideNames, publishedAt: current.createdAt });
                    if (hideNames && (scannedHash !== plain.hash || reviewedHash !== final.hash || findLeaks(publicationTexts(final.publication).join("\n"), rec.pseudonyms).length)) {
                      setScan("The page changed. Scan and read it again before downloading.");
                      return;
                    }
                    download(final.publication, final.hash);
                  }}
                >
                  <Download /> Download the page
                </Button>
                <p className="text-xs text-muted-foreground">
                  {canDownload ? "One web page file with no tracking. Its fingerprint lets anyone check it hasn't been changed." : unsaved ? "Save the write-up first." : "Finish the names check above."}
                  {preview && <span className="font-mono" title={`Fingerprint: ${preview.hash}`}> · {preview.hash.slice(0, 12)}</span>}
                </p>
              </div>
            }
          >
            <ul className="grid divide-y">
              <Item state={sourcesState} title="Two sources for every finding" need="Recommended" detail={chosen.length === 0 ? "Pick the findings this rests on." : thin.length === 0 ? "Each finding has at least two separate sources." : `${thin.length} finding${thin.length === 1 ? " has" : "s have"} one source or none noted.`}>
                {thin.length > 0 && (
                  <Button size="sm" variant="outline" className="justify-self-start" onClick={() => onOpen("findings", thin[0]!.id)}>
                    Fix sources <ArrowRight />
                  </Button>
                )}
              </Item>
              <Item state={repliesState} title="Everyone named can reply" need="Recommended" detail={openReplies.length ? `Waiting on ${openReplies.map((r) => r.party).join(", ")}.` : rec.replies.length ? "Everyone has replied, declined, or had their deadline." : "Add each person or organization a finding is about."}>
                <RightOfReply caseId={caseId} rec={rec} me={myMemberId(caseId)} compact />
              </Item>
              <Item state={verbatimState} title="No copying from private documents" need="Recommended" detail={verbatim.length ? `${verbatim.length} passage${verbatim.length === 1 ? " is" : "s are"} copied word for word. Leaked papers are often worded differently for each person, so an exact quote can expose your source.` : "Nothing is quoted word for word from private evidence."}>
                {verbatim.length > 0 && (
                  <ul className="grid gap-1">
                    {verbatim.slice(0, 4).map((v, i) => (
                      <li key={i} className="rounded-md bg-muted px-2.5 py-1.5 font-serif text-sm">
                        “{v.snippet}” <span className="font-sans text-xs text-muted-foreground">· {v.evidenceTitle}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Item>
              <Item
                state={namesState}
                title="Names"
                need="Required"
                detail={
                  hideNames
                    ? !scanned
                      ? "Names and places will be replaced by their descriptions. Scan the page so none slips through."
                      : !clean
                        ? "A name is still showing. Describe it below, then scan again."
                        : approved
                          ? "Scanned and read. Names are hidden."
                          : "Scanned. Read the preview, then confirm."
                    : namesAgreed
                      ? "Real names will be published."
                      : "Real names will be published. Confirm it's safe below."
                }
              >
                <ToggleGroup
                  type="single"
                  size="sm"
                  variant="outline"
                  value={hideNames ? "hide" : "show"}
                  onValueChange={(v) => {
                    if (!v) return;
                    setHideNames(v === "hide");
                    setNamesAgreed(false);
                  }}
                  aria-label="Names"
                  className="justify-start"
                >
                  <ToggleGroupItem value="hide" className="px-3 text-xs">
                    Hide names and places
                  </ToggleGroupItem>
                  <ToggleGroupItem value="show" className="px-3 text-xs">
                    Show real names
                  </ToggleGroupItem>
                </ToggleGroup>
                {hideNames ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {(!scanned || !clean) && (
                      <Button size="sm" variant="outline" disabled={scan === "running" || unsaved} onClick={() => void runScan()}>
                        {scan === "running" ? <Loader2 className="animate-spin" /> : <ScanSearch />}
                        {scan === "running" ? "Scanning…" : scanned ? "Scan again" : "Scan"}
                      </Button>
                    )}
                    {scanned && clean && !approved && (
                      <Button size="sm" onClick={() => setReviewedHash(preview!.hash)}>
                        <Check /> I've read the preview
                      </Button>
                    )}
                    {rec.pseudonyms.length > 0 && (
                      <button type="button" onClick={() => setShowNames((v) => !v)} className="text-xs font-medium underline-offset-4 hover:underline">
                        {showNames ? "Done" : `How ${rec.pseudonyms.length} names read`}
                      </button>
                    )}
                  </div>
                ) : (
                  <label className="flex items-start gap-2.5 text-sm">
                    <Checkbox checked={namesAgreed} onCheckedChange={(v) => setNamesAgreed(v === true)} className="mt-0.5" />
                    <span>Everyone named has agreed, or is a public figure acting in public.</span>
                  </label>
                )}
                {hideNames && showNames && (
                  <div className="grid max-h-64 gap-1.5 overflow-y-auto rounded-lg border bg-background p-2">
                    {rec.pseudonyms.map((p) => (
                      <div key={p.original} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2">
                        <span className="truncate text-xs font-medium" title={p.original}>
                          {p.original}
                        </span>
                        <Input
                          aria-label={`How ${p.original} should read`}
                          defaultValue={p.hint ?? ""}
                          maxLength={80}
                          className="h-7 text-xs"
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== p.hint) void editPseudonym(caseId, p.original, v);
                          }}
                        />
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => void editPseudonym(caseId, p.original, null)}>
                          Show
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {scan !== "idle" && scan !== "running" && scan !== "done" && <p className="text-xs text-destructive">{scan}</p>}
              </Item>
            </ul>
          </Pane>

          <Pane title="Preview" meta={hideNames ? "What readers get, with names replaced by their descriptions." : "What readers get, with real names."} bodyClassName="p-4 md:p-6" className="lg:sticky lg:top-28">
            {preview && <PublicationPreview publication={preview.publication} />}
          </Pane>
        </div>
      )}
    </section>
  );
}
