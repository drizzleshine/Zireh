import { newObservation } from "@zireh/cases";
import type { DaemonStatus, PlannedPiece, PrivacyLevel, Pseudonym, ResearchEvent, TraceStep } from "@zireh/schema";
import { Fragment, useMemo, useSyncExternalStore } from "react";
import { formatUsd, research } from "../api.ts";
import { myMemberId, save, savePseudonyms, useStore } from "../store.ts";
import { LEVEL_COPY } from "./levels.ts";
import { SearchBox } from "./SearchBox.tsx";

interface PieceState extends PlannedPiece {
  status: "planned" | "sent" | "answered" | "failed";
  circuit?: string;
  ms?: number;
  charged?: number;
  error?: string;
}

interface Run {
  task: string;
  level: PrivacyLevel;
  steps: { step: TraceStep; atMs: number }[];
  table: readonly Pseudonym[];
  pieces: PieceState[];
  blocked: { question: string; score: number; inferences: string[] }[];
  done?: Extract<ResearchEvent, { type: "done" }>;
  error?: string;
  saved?: boolean;
}

interface Props {
  caseId: string;
  status: DaemonStatus | undefined;
  onBalanceChange: () => void;
  onTopUp: () => void;
}

/**
 * The latest run per case lives outside the component, so it survives tab switches and keeps
 * receiving events while another tab is open.
 */
interface RunSlot {
  run?: Run;
  running: boolean;
  abort?: AbortController;
  draft?: { task: string; level: PrivacyLevel; contextIds: string[] };
}
const slots = new Map<string, RunSlot>();
const slotListeners = new Set<() => void>();
const EMPTY: RunSlot = Object.freeze({ running: false }); // stable: snapshots must not change identity
const getSlot = (caseId: string): RunSlot => slots.get(caseId) ?? EMPTY;
function setSlot(caseId: string, update: (s: RunSlot) => RunSlot) {
  slots.set(caseId, update(getSlot(caseId)));
  for (const l of slotListeners) l();
}
function useSlot(caseId: string): RunSlot {
  return useSyncExternalStore(
    (l) => {
      slotListeners.add(l);
      return () => {
        slotListeners.delete(l);
      };
    },
    () => getSlot(caseId),
  );
}

export function ResearchPanel({ caseId, status, onBalanceChange, onTopUp }: Props) {
  const rec = useStore((s) => s.cases[caseId])!;
  const { run, running, abort, draft } = useSlot(caseId);
  const task = draft?.task ?? "";
  const level = draft?.level ?? rec.case.privacy;
  const contextIds = draft?.contextIds ?? [];
  const setDraft = (patch: Partial<NonNullable<RunSlot["draft"]>>) =>
    setSlot(caseId, (s) => ({ ...s, draft: { task, level, contextIds, ...s.draft, ...patch } }));
  const setTask = (t: string) => setDraft({ task: t });
  const setLevel = (l: PrivacyLevel) => setDraft({ level: l });
  const setContextIds = (fn: (ids: string[]) => string[]) => setDraft({ contextIds: fn(contextIds) });
  const setRun = (next: Run | undefined | ((r: Run | undefined) => Run | undefined)) =>
    setSlot(caseId, (s) => {
      const value = typeof next === "function" ? next(s.run) : next;
      return value ? { ...s, run: value } : { running: s.running, ...(s.abort ? { abort: s.abort } : {}) };
    });
  const setRunning = (running: boolean) => setSlot(caseId, (s) => ({ ...s, running }));

  const ready = status?.localModel.ok && (level === "local" || (status.relay.ok && (status.transport === "direct" || status.tor.ready)));

  async function start() {
    const current: Run = { task, level, steps: [], table: [], pieces: [], blocked: [] };
    const controller = new AbortController();
    setRun(current);
    setSlot(caseId, (s) => ({ ...s, running: true, abort: controller }));
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
          level,
          table: rec.pseudonyms,
          salt: rec.case.salt,
          caseId,
          context: rec.evidence.filter((e) => contextIds.includes(e.id) && e.kind !== "image").map((e) => `${e.title}\n${e.body}`),
        },
        (e) => {
          if (e.type === "step") update((r) => r.steps.push({ step: e.step, atMs: e.atMs }));
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
            void savePseudonyms(caseId, e.table);
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

  async function saveAsObservation() {
    if (!run?.done) return;
    const me = myMemberId(caseId);
    const runId = crypto.randomUUID().replace(/-/g, "");
    await save(caseId, "observations", newObservation(caseId, { kind: "ai", runId, requestedBy: me }, { text: `Q: ${run.task}\n\n${run.done.outcome.answer}`, evidenceIds: contextIds }));
    setRun({ ...run, saved: true });
  }

  return (
    <section className="panel" aria-label="Research">
      <div className="composer">
        <div className="field">
          <label htmlFor="task">Ask a question about this case</label>
          <textarea
            id="task"
            className="textarea"
            value={task}
            maxLength={4000}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Write it the way you'd say it, names and all. Zireh hides them before anything leaves this computer."
          />
        </div>
        {rec.evidence.length > 0 && (
          <div className="context-pick" role="group" aria-label="Evidence to include">
            <span className="level-note">Include evidence:</span>
            {rec.evidence
              .filter((e) => e.kind !== "image")
              .map((e) => (
                <button key={e.id} className="chip" aria-pressed={contextIds.includes(e.id)} onClick={() => setContextIds((ids) => (ids.includes(e.id) ? ids.filter((x) => x !== e.id) : [...ids, e.id]))}>
                  {e.title}
                </button>
              ))}
          </div>
        )}
        <div className="composer-foot">
          <div className="levels" role="group" aria-label="Privacy level">
            {(Object.keys(LEVEL_COPY) as PrivacyLevel[]).map((l) => (
              <button key={l} aria-pressed={level === l} onClick={() => setLevel(l)}>
                {LEVEL_COPY[l].name}
              </button>
            ))}
          </div>
          <span className="level-note">{LEVEL_COPY[level].note}</span>
          <span className="spacer" />
          {running ? (
            <button className="btn" onClick={() => abort?.abort()}>
              Stop
            </button>
          ) : (
            <button className="btn primary" disabled={!task.trim() || !ready} onClick={start}>
              Ask privately
            </button>
          )}
        </div>
        {!ready && status && <p className="level-note">{readinessNote(status, level)}</p>}
      </div>

      {status?.relay.ok && status.relay.search && <SearchBox caseId={caseId} />}

      {run && <RunView run={run} running={running} onSave={saveAsObservation} onTopUp={onTopUp} />}
    </section>
  );
}

function readinessNote(status: DaemonStatus, level: PrivacyLevel): string {
  if (!status.localModel.ok) return `The local model (${status.localModel.id}) isn't available. Start Ollama and pull it first.`;
  if (level === "local") return "";
  if (!status.relay.ok) return "The relay can't be reached. Local only still works.";
  if (status.transport === "tor" && !status.tor.ready) return `Connecting to Tor (${status.tor.progress}%). Requests wait until it's ready.`;
  return "";
}

function RunView({ run, running, onSave, onTopUp }: { run: Run; running: boolean; onSave: () => void; onTopUp: () => void }) {
  const real = run.pieces.filter((p) => p.role === "real").length;
  const decoys = run.pieces.length - real;
  const broke = run.error?.toLowerCase().includes("need") || run.error?.toLowerCase().includes("insufficient");
  return (
    <>
      <div className="compare">
        <section className="column device" aria-label="On this computer">
          <h2>
            What you asked <span className="tag">stays on this computer</span>
          </h2>
          <p className="doc">
            <Redacted text={run.task} table={run.table} />
          </p>
          {run.table.length > 0 && (
            <div className="hidden-list">
              {run.table.map((p) => (
                <div className="row" key={p.placeholder}>
                  <span className="ph">{p.original}</span>
                  <span className="as">sent as “{p.hint ?? p.placeholder}”</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="column provider" aria-label="What the provider saw">
          <h2>
            What the provider saw{" "}
            <span className="tag">{run.level === "local" ? "nothing" : run.pieces.length ? `${run.pieces.length} unrelated requests` : running ? "preparing…" : ""}</span>
          </h2>
          {run.level === "local" && run.done && <p className="provider-note">Answered by the model on this computer. Nothing was sent.</p>}
          <div className="envelopes">
            {run.pieces.map((p, i) => (
              <Envelope key={p.id} piece={p} index={i} />
            ))}
          </div>
          {run.blocked.map((b) => (
            <div className="blocked" key={b.question}>
              <strong>Not sent: leak check scored {b.score}</strong>
              <p className="doc">{b.question}</p>
              <p>{b.inferences.join("; ")}</p>
            </div>
          ))}
          {decoys > 0 && <p className="provider-note">Each request went out separately, on its own Tor circuit, paid with its own coins. The provider can't tell the {decoys} decoys from the {real} real questions. Only you can.</p>}
        </section>
      </div>

      {run.steps.length > 0 && (
        <ol className="pipeline" aria-label="What happened">
          {run.steps.map(({ step, atMs }, i) => (
            <li key={i} className="done">
              <div>
                <div className="title">{step.title}</div>
                <div className="detail">{step.detail}</div>
              </div>
              <span className="time">{(atMs / 1000).toFixed(1)} s</span>
            </li>
          ))}
        </ol>
      )}

      {run.error && (
        <div className="error">
          {run.error}
          {broke && (
            <>
              {" "}
              <button className="btn small" onClick={onTopUp}>
                Top up
              </button>
            </>
          )}
        </div>
      )}

      {run.done && (
        <article className="answer" aria-label="Answer">
          <div className="doc">
            <Cited text={run.done.outcome.answer} invalid={run.done.outcome.citations.invalidCitations} />
          </div>
          {run.done.outcome.citations.invalidCitations.length > 0 && (
            <p className="notice">
              Citations {run.done.outcome.citations.invalidCitations.join(", ")} don't match any answer that came back. Treat those claims as
              unsupported.
            </p>
          )}
          <div className="answer-foot">
            <span>Cost {formatUsd(run.done.spent)}</span>
            <span>Took {(run.done.ms / 1000).toFixed(1)} s</span>
            <span className="spacer" />
            {run.saved ? (
              <span>Saved to findings as a draft</span>
            ) : (
              <button className="btn small" onClick={onSave}>
                Save as observation
              </button>
            )}
          </div>
        </article>
      )}
    </>
  );
}

function Envelope({ piece, index }: { piece: PieceState; index: number }) {
  return (
    <div className={`envelope ${piece.role} ${piece.status === "failed" ? "failed" : ""}`} style={{ ["--i" as string]: index }}>
      {(() => {
        const m = /^Session ([0-9a-f]{64})\n\n([\s\S]*)$/.exec(piece.wire);
        return m ? (
          <>
            <span className="salt" title="A random per-case prefix. It keeps this case's cached prompts separate from everyone else's.">
              case salt {m[1]!.slice(0, 10)}…
            </span>
            <p className="wire">{m[2]}</p>
          </>
        ) : (
          <p className="wire">{piece.wire}</p>
        );
      })()}
      <div className="meta">
        <span className={`role ${piece.role}`}>{piece.role === "real" ? "Real question" : "Decoy, answer discarded"}</span>
        {piece.circuit && <span>circuit {piece.circuit.slice(2, 8)}</span>}
        <span className={piece.status === "sent" ? "status-sent" : undefined}>
          {piece.status === "planned" ? "queued" : piece.status === "sent" ? "sending…" : piece.status === "answered" ? `${((piece.ms ?? 0) / 1000).toFixed(1)} s` : `failed: ${piece.error}`}
        </span>
        {piece.charged !== undefined && <span>{formatUsd(piece.charged)}</span>}
        {piece.leakScore !== undefined && <span>leak score {piece.leakScore}</span>}
      </div>
    </div>
  );
}

/** The question with every hidden value covered by an ink bar, drawn one after another. */
function Redacted({ text, table }: { text: string; table: readonly Pseudonym[] }) {
  const parts = useMemo(() => {
    if (!table.length) return [text];
    const escaped = [...table].sort((a, b) => b.original.length - a.original.length).map((p) => p.original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  }, [text, table]);
  const originals = new Set(table.map((p) => p.original.toLowerCase()));
  let n = 0;
  return (
    <>
      {parts.map((part, i) =>
        originals.has(part.toLowerCase()) ? (
          <span key={i} className="redacted" style={{ ["--i" as string]: n++ }} title="Hidden before sending">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Cited({ text, invalid }: { text: string; invalid: string[] }) {
  return (
    <>
      {text.split(/(\[A\d+\])/g).map((part, i) => {
        const m = /^\[(A\d+)\]$/.exec(part);
        if (!m) return <Fragment key={i}>{part}</Fragment>;
        return (
          <span key={i} className={`cite ${invalid.includes(m[1]!) ? "bad" : ""}`}>
            {m[1]}
          </span>
        );
      })}
    </>
  );
}
