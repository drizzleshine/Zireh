import { Warning as AlertTriangle, BookmarkSimple as BookmarkPlus, Check, CaretRight as ChevronRight, CircleNotch as Loader2, Copy } from "@phosphor-icons/react";
import { useState } from "react";
import { restore } from "@zireh/shield";
import { formatUsd } from "../../api.ts";
import { answerOf, type StoredResearch } from "../../research-history.ts";
import { Button } from "@/components/ui/button";
import { SwapIcon } from "@/components/ui/swap-icon";
import { cn } from "@/lib/utils";
import { Cited } from "./Cited.tsx";
import { RunDetail } from "./RunDetail.tsx";
import { friendlyError } from "./friendlyError.ts";

/** One question and its answer, with a one-line receipt that opens the full record of what was sent. */
export function Turn({ record, live, running, detail, onDetail, onSave, onSend, onCancel, onTopUp, onRetry }: {
  record: StoredResearch;
  live: boolean;
  running: boolean;
  detail: boolean;
  onDetail: () => void;
  onSave: () => void;
  onSend: () => void;
  onCancel: () => void;
  onTopUp: () => void;
  onRetry: () => void;
}) {
  const { run } = record;
  const [copied, setCopied] = useState(false);
  const answer = answerOf(run, (text) => restore(text, run.table));
  const standalone = run.steps.find((s) => s.step.stage === "standalone")?.step.after;
  const real = run.pieces.filter((p) => p.role === "real").length;
  const decoys = run.pieces.length - real;
  const spent = run.done?.spent ?? run.cancelled?.spent ?? run.recoveredSpent;
  const awaiting = live && running && !!run.prepared && !run.approved && !run.cancelling;
  const broke = !!run.error && /insufficient|not enough|balance/i.test(run.error);
  const answered = run.pieces.filter((p) => p.role === "real" && p.status === "answered").length;

  const receipt = run.example
    ? `Example for this demo · nothing was sent · would go out as ${real} question${real === 1 ? "" : "s"}${decoys ? ` + ${decoys} decoy${decoys === 1 ? "" : "s"}` : ""}`
    : run.level === "local"
      ? "Answered on this device · nothing sent"
      : run.pieces.length
        ? [`${awaiting ? "Ready to send" : run.error && !answer ? "Tried" : "Sent"} as ${real} question${real === 1 ? "" : "s"}${decoys ? ` + ${decoys} decoy${decoys === 1 ? "" : "s"}` : ""}`, spent !== undefined ? formatUsd(spent) : awaiting && run.prepared ? `up to ${formatUsd(run.prepared.estimatedCost)}` : "", run.done ? `${(run.done.ms / 1000).toFixed(1)} s` : ""].filter(Boolean).join(" · ")
        : running
          ? "Preparing on this device…"
          : "Nothing was sent";

  return (
    <li className="grid gap-3">
      <div className="grid justify-items-end gap-1">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-foreground px-4 py-3 text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-background">{run.task}</p>
        {standalone && standalone !== run.task && (
          <p className="max-w-[85%] text-right text-xs text-muted-foreground">
            Asked as: “{standalone}”
          </p>
        )}
      </div>

      <div className="panel surface">
        {answer ? (
          <div className="grid gap-3">
            {run.done ? (
              <div className="font-serif text-[1.0625rem] leading-relaxed whitespace-pre-wrap text-pretty">
                <Cited text={run.done.outcome.answer} invalid={run.done.outcome.citations.invalidCitations} />
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">The full answer didn't arrive, but these parts did.</p>
                <p className="font-serif text-[1.0625rem] leading-relaxed whitespace-pre-wrap">{answer}</p>
              </>
            )}
            {run.done && run.done.outcome.citations.invalidCitations.length > 0 && (
              <p className="flex items-start gap-2 rounded-md bg-destructive/5 p-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                Citations {run.done.outcome.citations.invalidCitations.join(", ")} don't match any answer that came back. Treat those claims as unsupported.
              </p>
            )}
          </div>
        ) : awaiting ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Check className="size-4 text-protected" />
            <span className="flex-1">Prepared on this device. Check what will be sent below, then send.</span>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={onSend}>
              Send
            </Button>
          </div>
        ) : run.cancelled ? (
          <div className="grid gap-2 text-sm">
            <p className="text-muted-foreground">
              Stopped. {run.cancelled.sent} request{run.cancelled.sent === 1 ? "" : "s"} had already gone out.
            </p>
            {run.cancelled.answers.map((a) => (
              <p className="font-serif" key={a.id}>
                {a.answer}
              </p>
            ))}
          </div>
        ) : run.error ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-destructive" role="alert">
            <AlertTriangle className="size-4" />
            <span className="flex-1">{friendlyError(run.error)}</span>
            {broke ? (
              <Button size="sm" variant="outline" onClick={onTopUp}>
                Add money
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Ask again
              </Button>
            )}
          </div>
        ) : running ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            <span className="flex-1">{run.pieces.length ? `Waiting for answers · ${answered} of ${real}` : (run.steps.at(-1)?.step.title ?? "Hiding names on this device…")}</span>
            <Button size="sm" variant="ghost" disabled={run.cancelling} onClick={onCancel}>
              {run.cancelling ? "Stopping…" : "Stop"}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No answer was saved for this question.</p>
        )}

        <div className="footer">
          <button type="button" onClick={onDetail} aria-expanded={detail} className="group flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", detail && "rotate-90")} />
            <span className="truncate tabular-nums">{receipt}</span>
            <span className="hidden shrink-0 font-medium text-foreground/80 sm:inline">· {detail ? "Hide" : "See what was sent"}</span>
          </button>
          {answer && (
            <span className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() =>
                  void navigator.clipboard.writeText(answer).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
              >
                <SwapIcon swapped={copied} from={<Copy />} to={<Check />} /> Copy
              </Button>
              {run.saved ? (
                <span className="flex items-center gap-1 px-2 text-xs text-protected">
                  <Check className="size-3.5" /> In Findings
                </span>
              ) : (
                <Button size="sm" variant="outline" onClick={onSave}>
                  <BookmarkPlus /> Save to Findings
                </Button>
              )}
            </span>
          )}
        </div>
      </div>

      {detail && <RunDetail run={run} running={running} />}
    </li>
  );
}
