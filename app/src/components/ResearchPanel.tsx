import { evidenceContext } from "../evidence.ts";
import { answerOf, onHistoryAdded, reconcileResearch, researchHistory, saveResearch, threadsOf, type Run, type StoredResearch, type Thread } from "../research-history.ts";
import { restore, extendTable } from "@zireh/shield";
import { newObservation } from "@zireh/cases";
import type { DaemonStatus, PrivacyLevel } from "@zireh/schema";
import { Warning as AlertTriangle, ArrowUp, Plus, SlidersHorizontal as Settings2, Square, X, Sparkle as Sparkles, FileText, CircleNotch as Loader2 } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, research } from "../api.ts";
import { useIdentities, withIdentities, withoutIdentities } from "../sources.ts";
import { myMemberId, save, savePseudonyms, editPseudonym, useStore } from "../store.ts";
import { useDraft } from "../drafts.ts";
import { SearchBox } from "./SearchBox.tsx";
import { SendPreview } from "./SendPreview.tsx";
import { Pane, WITH_SIDE } from "./Pane.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { PageBar } from "./SectionTitle.tsx";
import { LevelPicker } from "./research/LevelPicker.tsx";
import { ThreadList } from "./research/ThreadList.tsx";
import { Turn } from "./research/Turn.tsx";
import { readinessNote } from "./research/readiness.ts";
import { setSlot, useSlot, type RunSlot } from "./research/slot.ts";

interface Props {
  caseId: string;
  status: DaemonStatus | undefined;
  onBalanceChange: () => void;
  onTopUp: () => void;
  onSettings: () => void;
}

/** Open a new question in Research with this evidence already attached. */
export function askAbout(caseId: string, evidenceId: string, level: PrivacyLevel) {
  setSlot(caseId, (s) => ({
    ...s,
    ...(s.running ? {} : { thread: "new" }),
    draft: { task: s.draft?.task ?? "", level: s.draft?.level ?? level, contextIds: [...new Set([...(s.draft?.contextIds ?? []), evidenceId])], ...(s.draft?.reviewBeforeSend !== undefined ? { reviewBeforeSend: s.draft.reviewBeforeSend } : {}) },
  }));
}

export function ResearchPanel({ caseId, status, onBalanceChange, onTopUp, onSettings }: Props) {
  const rec = useStore((s) => s.cases[caseId])!;
  const { run, runId, running, abort, draft, historyError, thread: openThread } = useSlot(caseId);
  // The question being typed survives reloads; the in-memory slot wins while this page is open.
  const [savedQuestion, saveQuestion, clearQuestion] = useDraft(caseId, "research.question", "");
  const task = draft?.task ?? savedQuestion;
  const level = draft?.level ?? rec.case.privacy;
  const contextIds = draft?.contextIds ?? [];
  const context = evidenceContext(rec.evidence, contextIds);
  const reviewBeforeSend = draft?.reviewBeforeSend ?? level === "paranoid";
  const [history, setHistory] = useState<StoredResearch[]>([]);
  const [expanded, setExpanded] = useState<string>();
  // Threads whose notice was dismissed ("new" is the unsaved new thread). Kept in this browser.
  const noticeStore = `zireh:research-notice-dismissed:${caseId}`;
  const [dismissed, setDismissedState] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(noticeStore) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const setDismissed = (ids: string[]) => {
    setDismissedState(ids);
    try {
      localStorage.setItem(noticeStore, JSON.stringify(ids.slice(-200)));
    } catch {
      /* remembered until reload */
    }
  };
  const [phrase, setPhrase] = useState("");
  const [phraseError, setPhraseError] = useState<string>();
  const setDraft = (patch: Partial<NonNullable<RunSlot["draft"]>>) =>
    setSlot(caseId, (s) => ({ ...s, draft: { task, level, contextIds, ...s.draft, ...patch } }));
  const setTask = (t: string) => {
    setDraft({ task: t });
    saveQuestion(t);
  };
  const setLevel = (l: PrivacyLevel) => setDraft({ level: l, reviewBeforeSend: l === "paranoid" });
  // Without on-device AI only Standard can run; the other levels promise work only the model can do.
  const noLocalAi = !!status && !status.localModel.ok;
  const blocked = (l: PrivacyLevel) => noLocalAi && l !== "standard";
  useEffect(() => {
    if (blocked(level)) setLevel("standard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noLocalAi, level]);
  const setContextIds = (fn: (ids: string[]) => string[]) => setDraft({ contextIds: fn(contextIds) });
  const setRun = (next: Run | undefined | ((r: Run | undefined) => Run | undefined)) =>
    setSlot(caseId, (s) => {
      const value = typeof next === "function" ? next(s.run) : next;
      return value ? { ...s, run: value } : { running: s.running, ...(s.abort ? { abort: s.abort } : {}) };
    });
  const setRunning = (running: boolean) => setSlot(caseId, (s) => ({ ...s, running }));

  useEffect(() => {
    let active = true;
    const refresh = () => { void reconcileResearch(caseId).then((records) => { if (active) setHistory(records); }); };
    void researchHistory(caseId).then((records) => { if (active) setHistory(records); });
    refresh();
    const timer = setInterval(refresh, 8000);
    const off = onHistoryAdded((id) => { if (id === caseId) void researchHistory(caseId).then((records) => { if (active) setHistory(records); }); });
    return () => { active = false; clearInterval(timer); off(); };
  }, [caseId, run?.done, run?.cancelled, status?.pendingCalls]);

  useEffect(() => {
    if (!running || !runId || !run?.prepared || run.approved || run.cancelling || run.sourceTable === JSON.stringify(rec.pseudonyms)) return;
    setRun((run) => run ? { ...run, cancelling: true } : run);
    void api.cancelResearch(runId).catch(() => {});
  }, [running, runId, run, rec.pseudonyms]);

  // On-device AI is an extra: only Local only needs it. Everything else needs the relay.
  const ready = status && (level === "local" ? status.localModel.ok : status.relay.ok && status.relay.upstreamOk !== false && (status.transport === "direct" || status.tor.ready));

  async function start() {
    const threadId = thread?.id ?? crypto.randomUUID().replace(/-/g, "");
    if (!thread && dismissed.includes("new")) setDismissed([...dismissed.filter((id) => id !== "new"), threadId]);
    // Earlier answers in this thread stay on this computer; they only help rewrite the follow-up.
    const turns = (thread?.turns ?? [])
      .flatMap((t) => {
        const answer = answerOf(t.run, (text) => restore(text, t.run.table));
        return answer ? [{ question: t.run.task, answer: answer.slice(0, 8000) }] : [];
      })
      .slice(-4);
    // A level this device can't run never goes out; it falls back to Standard.
    const sendLevel: PrivacyLevel = blocked(level) ? "standard" : level;
    const current: Run = { threadId, askedAt: new Date().toISOString(), evidenceIds: context.entries.map((entry) => entry.id), sourceTable: JSON.stringify(rec.pseudonyms), task, level: sendLevel, steps: [], table: [], pieces: [], blocked: [] };
    const controller = new AbortController();
    clearQuestion();
    setSlot(caseId, ({ runId: _previous, ...s }) => ({ ...s, run: current, running: true, abort: controller, thread: threadId, draft: { task: "", level, contextIds: [], ...(s.draft?.reviewBeforeSend !== undefined ? { reviewBeforeSend: s.draft.reviewBeforeSend } : {}) } }));
    const update = (fn: (r: Run) => void) =>
      setRun((r) => {
        if (!r) return r;
        const next = { ...r, pieces: [...r.pieces], steps: [...r.steps] };
        fn(next);
        return next;
      });
    try {
      await research(
        {
          task,
          level: sendLevel,
          reviewBeforeSend: reviewBeforeSend && sendLevel !== "local",
          table: withIdentities(caseId, rec.pseudonyms),
          salt: rec.case.salt,
          caseId,
          context: context.entries.map((entry) => entry.text),
          ...(turns.length ? { history: turns } : {}),
        },
        (e) => {
          if (e.type === "started") setSlot(caseId, (s) => ({ ...s, runId: e.runId }));
          else if (e.type === "prepared") update((r) => { r.prepared = { estimatedCost: e.estimatedCost }; });
          else if (e.type === "cancelled") { update((r) => { r.cancelled = e; r.cancelling = false; }); onBalanceChange(); }
          else if (e.type === "step") update((r) => r.steps.push({ step: e.step, atMs: e.atMs }));
          else if (e.type === "redacted") update((r) => (r.table = e.table));
          else if (e.type === "plan")
            update((r) => {
              r.table = e.table;
              r.pieces = e.pieces.map((p) => ({ ...p, status: "planned" }));
              r.blocked = [...e.blocked];
            });
          else if (e.type === "piece")
            update((r) => {
              const i = r.pieces.findIndex((p) => p.id === e.id);
              if (i >= 0) r.pieces[i] = { ...r.pieces[i]!, status: e.status, ...(e.circuit ? { circuit: e.circuit } : {}), ...(e.ms ? { ms: e.ms } : {}), ...(e.charged !== undefined ? { charged: e.charged } : {}), ...(e.error ? { error: e.error } : {}) };
            });
          else if (e.type === "done") {
            update((r) => {
              r.done = e;
              r.table = e.table;
            });
            void savePseudonyms(caseId, withoutIdentities(caseId, e.table));
            onBalanceChange();
          } else if (e.type === "error") update((r) => (r.error = e.message));
        },
        controller.signal,
      );
    } catch (err) {
      update((r) => (r.error = (err as Error).message));
    } finally {
      setRunning(false);
    }
  }

  async function changeHideRule(original: string, remove = false) {
    setPhraseError(undefined);
    try {
      if (running) {
        setRun((run) => run ? { ...run, cancelling: true } : run);
        if (runId) await api.cancelResearch(runId); else abort?.abort();
      }
      if (remove) await editPseudonym(caseId, original, null);
      else {
        const entries = extendTable(rec.pseudonyms, [{ text: original.trim(), kind: "other" }]).map((entry) => entry.original.toLowerCase() === original.trim().toLowerCase() ? { ...entry, manual: true } : entry);
        await save(caseId, "pseudonyms", { id: caseId, caseId, entries });
      }
      setPhrase("");
    } catch (error) { setPhraseError((error as Error).message); }
  }

  async function sendPrepared() {
    if (!runId || !run?.prepared || run.approved || run.cancelling) return;
    setRun({ ...run, approved: true });
    try { await api.sendResearch(runId); }
    catch (error) { setRun((run) => run ? { ...run, approved: false, error: (error as Error).message } : run); }
  }

  /** Save one answer to Findings as a draft observation that cites the evidence asked about. */
  async function saveTurn(record: StoredResearch) {
    const answer = answerOf(record.run, (text) => restore(text, record.run.table));
    if (!answer) return;
    try {
      await save(caseId, "observations", newObservation(caseId, { kind: "ai", runId: record.id, requestedBy: myMemberId(caseId) }, { text: `Q: ${record.run.task}\n\n${answer}`, evidenceIds: record.run.evidenceIds ?? [] }));
      if (record.id === runId) setRun((r) => (r ? { ...r, saved: true } : r));
      else await saveResearch(caseId, record.id, { ...record.run, saved: true });
      setHistory(await researchHistory(caseId));
      toast.success("Saved to Findings", { description: "It's a draft observation there, citing the evidence you asked about." });
    } catch (error) {
      toast.error("Couldn't save", { description: (error as Error).message });
    }
  }

  // The live question joins the saved ones so the open thread shows it as it happens.
  const records = useMemo(() => {
    const list = history.filter((r) => r.id !== runId);
    if (run) list.push({ id: runId ?? "pending", caseId, updatedAt: new Date().toISOString(), run });
    return list;
  }, [history, run, runId, caseId]);
  const threads = useMemo(() => threadsOf(records), [records]);
  const thread: Thread | undefined = openThread === "new" ? undefined : (threads.find((t) => t.id === openThread) ?? (openThread ? undefined : threads[0]));
  const openThreadId = (id: string) => setSlot(caseId, (s) => ({ ...s, thread: id }));
  const followUp = !!thread?.turns.length;
  const newThread = () => {
    if (dismissed.includes("new")) setDismissed(dismissed.filter((id) => id !== "new"));
    setSlot(caseId, (s) => ({ ...s, thread: "new" }));
  };
  const notice = noLocalAi ? (followUp ? "On-device AI is off, so follow-ups aren't rewritten to stand alone. Names are still hidden." : "On-device AI is off: every name-like word is hidden by rule, and only Standard is available.") : undefined;
  const noticeKey = thread?.id ?? "new";

  const textEvidence = rec.evidence.filter((e) => e.kind !== "image");
  // What this device already knows it will hide from the question; the model may find more.
  const identities = useIdentities(caseId);
  const table = useMemo(() => withIdentities(caseId, rec.pseudonyms), [caseId, rec.pseudonyms, identities]);
  const contextTexts = useMemo(() => context.entries.map((entry) => entry.text), [context.entries.map((entry) => entry.id).join()]);
  const canAsk = !!task.trim() && !!ready && !running;
  const cancel = async () => {
    setRun((r) => (r ? { ...r, cancelling: true } : r));
    if (!runId) return void abort?.abort();
    try {
      await api.cancelResearch(runId);
    } catch (err) {
      setRun((r) => (r ? { ...r, cancelling: false, error: (err as Error).message } : r));
    }
  };

  return (
    <section className="page pb-4" aria-label="Research">
      <PageBar hint="Ask about your case. Each question goes out on its own, so the AI never sees the conversation.">
        {thread && (
          <Button size="sm" onClick={newThread}>
            <Plus /> New thread
          </Button>
        )}
      </PageBar>
      {status?.relay.ok && status.relay.search && <SearchBox caseId={caseId} />}

      <div className={WITH_SIDE}>
        <ThreadList threads={threads} openId={thread?.id} liveId={running ? run?.threadId : undefined} onOpen={openThreadId} />

        {/* The open thread in its own frame, like the reading pane in Evidence and Findings. */}
        <Pane bodyClassName="grid gap-6 p-4 md:p-6">
          <p className="text-center text-xs text-muted-foreground">
            {new Date(thread ? (thread.turns[0]!.run.askedAt ?? thread.turns[0]!.updatedAt) : Date.now()).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
          {historyError && <p className="text-sm text-destructive" role="alert">{historyError}</p>}
          {/* Every thread opens with the same greeting, in the answer style. It is part of the view, not stored or sent. */}
          <div className="panel surface max-w-[85%]">
            <p className="font-serif text-[17px] leading-relaxed">Hello, what can I help with?</p>
          </div>
          {thread ? (
            <ol className="grid gap-8" aria-label="Questions in this thread">
              {thread.turns.map((record) => (
                <Turn
                  key={record.id}
                  record={record}
                  live={!!run && record.run === run}
                  running={running && record.run === run}
                  detail={expanded === record.id || (running && record.run === run && !!run.prepared && !run.approved)}
                  onDetail={() => setExpanded((id) => (id === record.id ? undefined : record.id))}
                  onSave={() => void saveTurn(record)}
                  onSend={() => void sendPrepared()}
                  onCancel={() => void cancel()}
                  onTopUp={onTopUp}
                  onRetry={() => setTask(record.run.task)}
                />
              ))}
            </ol>
          ) : null}

      {/* The question box stays in reach at the bottom of the screen, however long the thread gets. */}
      <form
        className="sticky bottom-4 z-10 min-w-0 rounded-2xl border bg-card shadow-[0_12px_32px_-16px_rgb(0_0_0/0.45)] transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20"
        onSubmit={(e) => {
          e.preventDefault();
          if (canAsk) void start();
        }}
      >
        <Label htmlFor="task" className="sr-only">
          Ask a question about this case
        </Label>
        <Textarea
          id="task"
          value={task}
          maxLength={4000}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canAsk) {
              e.preventDefault();
              void start();
            }
          }}
          placeholder={followUp ? "Ask a follow-up…" : "Ask a question about your case…"}
          className="min-h-24 resize-none border-0 bg-transparent px-4 pt-4 md:px-6 md:pt-6 font-serif text-[17px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[17px] dark:bg-transparent"
        />

        {context.entries.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs md:px-6">
            {context.entries.map((entry) => (
              <Badge key={entry.id} variant="secondary" className="gap-1 pr-1 font-normal">
                <FileText className="size-3" />
                <span className="max-w-48 truncate">{entry.title}</span>
                <button type="button" className="rounded-sm p-0.5 hover:bg-background" aria-label={`Remove ${entry.title}`} onClick={() => setContextIds((ids) => ids.filter((x) => x !== entry.id))}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        {level !== "local" && <SendPreview caseId={caseId} task={task} context={contextTexts} table={table} localAi={!noLocalAi} />}
        {context.entries.filter((entry) => entry.truncated).map((entry) => (
          <p className="px-4 pb-2 text-xs text-muted-foreground md:px-6" key={entry.id}>
            {entry.title}: research uses the first {entry.used.toLocaleString()} of {entry.total.toLocaleString()} characters. The whole source stays in Evidence.
          </p>
        ))}
        {context.omitted > 0 && <p className="px-4 pb-2 text-xs text-muted-foreground md:px-6">Only the first 20 selected sources are included; {context.omitted} left out.</p>}

        {!ready && status && readinessNote(status, level) ? (
          <p className="flex items-center gap-2 px-4 pb-4 text-xs text-muted-foreground md:px-6">
            <AlertTriangle className="size-3.5 text-decoy" /> {readinessNote(status, level)}
            {level === "local" && (
              <button type="button" onClick={onSettings} className="ml-auto font-medium text-foreground underline-offset-4 hover:underline">
                Set it up
              </button>
            )}
          </p>
        ) : notice && !dismissed.includes(noticeKey) ? (
          <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg bg-muted/60 py-2 pr-1 pl-3 text-xs text-muted-foreground md:mx-6" role="note">
            {noLocalAi ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-decoy" /> : <Sparkles className="mt-0.5 size-3.5 shrink-0 text-protected" weight="duotone" />}
            <span className="flex-1 pt-px">{notice}</span>
            {noLocalAi && (
              <button type="button" onClick={onSettings} className="shrink-0 pt-px font-medium text-foreground underline-offset-4 hover:underline">
                Turn it on
              </button>
            )}
            <button type="button" onClick={() => setDismissed([...dismissed, noticeKey])} className="hit -my-0.5 shrink-0 rounded p-0.5 hover:bg-background hover:text-foreground" aria-label="Dismiss for this thread">
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        <div className="footer">
          {textEvidence.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
                  <Plus /> Evidence{contextIds.length ? ` (${contextIds.length})` : ""}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-0">
                <Command>
                  <CommandInput placeholder="Find evidence…" />
                  <CommandList>
                    <CommandEmpty>No matching evidence.</CommandEmpty>
                    <CommandGroup heading="Add to your question">
                      {textEvidence.map((e) => (
                        <CommandItem key={e.id} value={`${e.title} ${e.id}`} onSelect={() => setContextIds((ids) => (ids.includes(e.id) ? ids.filter((x) => x !== e.id) : [...ids, e.id]))}>
                          <Checkbox checked={contextIds.includes(e.id)} className="pointer-events-none" />
                          <span className="truncate">{e.title}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}

          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
                <Settings2 /> Options{rec.pseudonyms.some((p) => p.manual) ? ` · ${rec.pseudonyms.filter((p) => p.manual).length} rules` : ""}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="grid w-[min(24rem,calc(100vw-2rem))] gap-4">
              {level !== "local" && (
                <label className="flex items-start gap-2.5 text-sm">
                  <Checkbox checked={reviewBeforeSend} onCheckedChange={(v) => setDraft({ reviewBeforeSend: v === true })} disabled={running} className="mt-0.5" />
                  <span>
                    <span className="font-medium">Review requests before sending</span>
                    <span className="block text-xs text-muted-foreground">See exactly what will be sent and the most it can cost, before it goes.</span>
                  </span>
                </label>
              )}
              <div className="grid gap-2">
                <Label htmlFor="hide-phrase">Always hide a phrase</Label>
                <div className="flex gap-2">
                  <Input id="hide-phrase" maxLength={500} value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder="a codename, an address, a street…" className="h-8" />
                  <Button type="button" size="sm" disabled={phrase.trim().length < 2 || !!run?.cancelling} onClick={() => void changeHideRule(phrase)}>
                    Add
                  </Button>
                </div>
                {rec.pseudonyms.filter((entry) => entry.manual).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {rec.pseudonyms
                      .filter((entry) => entry.manual)
                      .map((entry) => (
                        <Badge key={entry.original} variant="outline" className="gap-1 pr-1 font-normal">
                          {entry.original}
                          <button type="button" className="rounded-sm p-0.5 hover:bg-muted" aria-label={`Stop always hiding ${entry.original}`} onClick={() => void changeHideRule(entry.original, true)}>
                            <X className="size-3" />
                          </button>
                        </Badge>
                      ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">These apply to your whole team.</p>
                {phraseError && <p className="text-xs text-destructive">{phraseError}</p>}
              </div>
            </PopoverContent>
          </Popover>

          <LevelPicker level={level} blocked={blocked} onChange={setLevel} onSettings={noLocalAi ? onSettings : undefined} />
          {running ? (
            <Button type="button" variant="outline" size="sm" disabled={run?.cancelling} onClick={() => void cancel()}>
              {run?.cancelling ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
              {run?.cancelling ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={!canAsk}>
              <ArrowUp />
              {reviewBeforeSend && level !== "local" ? "Prepare" : "Ask"}
              <Kbd className="ml-1 hidden bg-primary-foreground/15 text-primary-foreground sm:inline-flex">⌘↵</Kbd>
            </Button>
          )}
        </div>
      </form>
        </Pane>
      </div>
    </section>
  );
}
