import type { Receipt } from "@zireh/schema";
import { Warning as AlertTriangle, CaretRight as ChevronRight, Cpu, Globe, CircleNotch as Loader2, Shuffle, Sparkle as Sparkles } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, formatUsd, plainFailure } from "../api.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { groupByQuestion } from "../log-groups.ts";
import { researchHistory } from "../research-history.ts";
import { Pane } from "./Pane.tsx";
import { PageBar } from "./SectionTitle.tsx";

type Data = Awaited<ReturnType<typeof api.receipts>>;

const credits = (n: number) => `${n.toLocaleString()} credit${n === 1 ? "" : "s"}`;

/** Every payload that left this computer, as sent, with its hash and what it actually cost. */
export function LogPanel({ caseId }: { caseId: string }) {
  const [data, setData] = useState<Data | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [confirmLoss, setConfirmLoss] = useState<string | undefined>();
  const [questions, setQuestions] = useState<Record<string, string>>({});
  useEffect(() => {
    api.receipts(caseId).then(setData, (e: Error) => setError(e.message));
    void researchHistory(caseId).then((records) => setQuestions(Object.fromEntries(records.map((r) => [r.id, r.run.task]))));
  }, [caseId]);

  async function resolveDispute(requestId: string, action: "retry" | "write-off") {
    setBusy(requestId);
    setActionError(undefined);
    try {
      if (action === "retry") await api.retryDispute(requestId);
      else await api.writeOffDispute(requestId);
      setConfirmLoss(undefined);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      try {
        setData(await api.receipts(caseId));
      } catch (e) {
        setActionError((e as Error).message);
      }
      setBusy(undefined);
    }
  }

  if (error) return <section className="page"><p className="text-sm text-destructive">{error}</p></section>;
  if (!data)
    return (
      <section className="flex items-center gap-2 px-4 pt-8 pb-16 text-sm text-muted-foreground md:px-10">
        <Loader2 className="size-4 animate-spin" /> Reading the log…
      </section>
    );
  const { receipts, summary } = data;

  return (
    <section className="page" aria-label="Privacy log">
      <PageBar hint="Everything this case sent, grouped by the question it came from, exactly as it left this computer." />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Requests sent" value={summary.calls.toLocaleString()} />
        <Stat label="Decoys among them" value={summary.decoys.toLocaleString()} hint={summary.calls ? `${Math.round((summary.decoys / summary.calls) * 100)}% of traffic is cover` : undefined} />
        <Stat label="Spent" value={formatUsd(summary.spent)} hint={credits(summary.spent)} />
        <Stat label="Overcharges caught" value={summary.overcharges.toLocaleString()} tone={summary.overcharges ? "bad" : "ok"} hint="Every bill is re-checked against the tokens used" />
      </div>

      {actionError && <p className="text-sm text-destructive" role="alert">{actionError}</p>}
      {data.disputes?.map((dispute) => (
        <div key={dispute.requestId} className="grid gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert">
          <p className="flex gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>
              {dispute.reason} {formatUsd(dispute.amount)} ({credits(dispute.amount)}) at stake. Automatic retries are paused. <span className="font-mono text-xs text-muted-foreground">{dispute.requestId}</span>
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void resolveDispute(dispute.requestId, "retry")}>
              {busy === dispute.requestId && <Loader2 className="animate-spin" />} Re-check once
            </Button>
            {confirmLoss === dispute.requestId ? (
              <>
                <span className="text-muted-foreground">Accept this loss permanently? The audit record is kept.</span>
                <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => void resolveDispute(dispute.requestId, "write-off")}>Accept loss</Button>
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirmLoss(undefined)}>Keep dispute</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirmLoss(dispute.requestId)}>Write off…</Button>
            )}
          </div>
        </div>
      ))}
      {data.writtenOff?.map((entry) => (
        <p key={entry.requestId} className="text-sm text-muted-foreground">
          Written off {formatUsd(entry.amount)} ({credits(entry.amount)}) on {new Date(entry.at).toLocaleString()}. {entry.reason} <span className="font-mono text-xs">{entry.requestId}</span>
        </p>
      ))}

      <Pane title="Requests" count={groupByQuestion(receipts).length || undefined} meta="One row per question. Open it to see each request exactly as the provider got it.">
        {receipts.length === 0 ? (
          <div className="grid justify-items-center gap-1 px-6 py-12 text-center">
            <strong>Nothing has been sent yet</strong>
            <span className="text-sm text-muted-foreground">Ask a question in Research and every request will be listed here.</span>
          </div>
        ) : (
          <ol className="grid divide-y">
            {groupByQuestion(receipts).map((g) => (
              <Group key={g.key} receipts={g.receipts} question={g.runId ? questions[g.runId] : undefined} />
            ))}
          </ol>
        )}
      </Pane>

    </section>
  );
}

/** One question: what you asked (only this device knows), how it went out, and what it cost. */
function Group({ receipts, question }: { receipts: Receipt[]; question: string | undefined }) {
  const [open, setOpen] = useState(false);
  const first = receipts[0]!;
  const real = receipts.filter((r) => r.role === "real").length;
  const decoys = receipts.length - real;
  const spent = receipts.reduce((n, r) => n + (r.charged ?? 0), 0);
  const failed = receipts.filter((r) => r.state === "failed" || r.state === "disputed" || r.state === "written-off").length;
  const kind = first.destination === "local" ? KIND.local : first.destination === "search" ? KIND.search : KIND.question;
  const sent = /^Session [0-9a-f]{64}\n\n([\s\S]*)$/.exec(receipts.find((r) => r.role === "real")?.payloadPreview ?? first.payloadPreview)?.[1] ?? first.payloadPreview;
  const title = question ?? (first.destination === "search" ? `Searched: ${sent}` : sent);

  return (
    <li className={cn(open && "bg-muted/25")}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/40 md:px-5">
        <kind.icon className="mt-1 size-4 shrink-0 text-muted-foreground" />
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="line-clamp-2 text-sm leading-snug font-medium">{title}</span>
          <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground tabular-nums">
            <span>{new Date(first.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
            <span>·</span>
            <span>
              {first.destination === "local" ? "nothing sent" : `${real} request${real === 1 ? "" : "s"}${decoys ? ` + ${decoys} decoy${decoys === 1 ? "" : "s"}` : ""}`}
            </span>
            {first.destination !== "local" && (
              <>
                <span>·</span>
                <span>{formatUsd(spent)}</span>
              </>
            )}
            {failed > 0 && <span className="font-medium text-destructive">· {failed} failed</span>}
          </span>
        </span>
        <ChevronRight className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <ol className="mx-4 mb-4 grid divide-y overflow-clip rounded-xl border bg-card md:mx-5">
          {receipts.map((r) => (
            <Row key={r.id} r={r} />
          ))}
        </ol>
      )}
    </li>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string | undefined; tone?: "ok" | "bad" }) {
  return (
    <div className="grid content-start gap-1 rounded-2xl bg-card p-4 surface">
      <div className={cn("font-display text-2xl font-semibold tracking-tight tabular-nums", tone === "bad" && "text-destructive")}>{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
      {hint && <div className="text-xs text-muted-foreground/80">{hint}</div>}
    </div>
  );
}

const KIND = {
  local: { label: "Answered locally", icon: Cpu },
  decoy: { label: "Decoy", icon: Shuffle },
  search: { label: "Web search", icon: Globe },
  question: { label: "Question", icon: Sparkles },
} as const;

function Row({ r }: { r: Receipt }) {
  const [open, setOpen] = useState(false);
  const kind = r.destination === "local" ? KIND.local : r.role === "decoy" ? KIND.decoy : r.destination === "search" ? KIND.search : KIND.question;
  const salted = /^Session ([0-9a-f]{64})\n\n([\s\S]*)$/.exec(r.payloadPreview);
  const text = salted ? salted[2]! : r.payloadPreview;
  const failed = r.state === "failed" || r.state === "disputed" || r.state === "written-off";

  return (
    <li className="grid gap-2 p-4 md:grid-cols-[150px_1fr_130px] md:gap-5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground md:block md:space-y-1.5">
        <Badge variant={r.role === "decoy" ? "outline" : "secondary"} className={cn("gap-1 font-normal", r.role === "decoy" && "border-decoy/40 bg-decoy-wash text-decoy")}>
          <kind.icon className="size-3" /> {kind.label}
        </Badge>
        <div className="tabular-nums">{new Date(r.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</div>
        {r.state && r.state !== "settled" && <div className={cn(failed && "text-destructive")}>{r.state}</div>}
      </div>
      <div className="min-w-0">
        {salted && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="mb-1.5 inline-block rounded border border-dashed px-1.5 font-mono text-[11px] text-muted-foreground">case salt {salted[1]!.slice(0, 10)}…</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">A random tag per case, so providers can't match your questions with anyone else's.</TooltipContent>
          </Tooltip>
        )}
        <p className={cn("font-serif text-[15px] leading-relaxed whitespace-pre-wrap", !open && "line-clamp-3")}>{text}</p>
        <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground" title={r.payloadSha256}>sha256 {r.payloadSha256}</p>
        {failed && r.error && (
          <p className="mt-1 text-xs text-destructive" title={r.error}>
            Failed: {plainFailure(r.error)}
            {r.state === "failed" && r.charged === 0 && ". Nothing was charged."}
          </p>
        )}
        {(r.payloadWire || text.length > 240) && (
          <Button variant="ghost" size="sm" className="-ml-2 mt-1 h-7 text-xs text-muted-foreground" onClick={() => setOpen(!open)} aria-expanded={open}>
            <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
            {open ? "Hide" : r.payloadWire ? "Complete request body" : "Show all"}
          </Button>
        )}
        {open && r.payloadWire && <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all">{r.payloadWire}</pre>}
      </div>
      <Cost r={r} />
    </li>
  );
}

/** The real charge in µUSD credits, with the device's own estimate beside it. */
function Cost({ r }: { r: Receipt }) {
  if (r.destination === "local") return <div className="text-sm text-muted-foreground md:text-right">Free, on device</div>;
  if (r.charged === undefined) return <div className="text-sm text-muted-foreground md:text-right">Unsettled</div>;
  return (
    <div className="text-sm md:text-right">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="font-semibold tabular-nums">{formatUsd(r.charged)}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          {credits(r.charged)} (1 credit = $0.000001).
          {r.expectedCharge !== undefined && ` This device's own count of the tokens predicts ${credits(r.expectedCharge)}.`}
          {r.charged === 1 && " One credit is the minimum charge per request."}
        </TooltipContent>
      </Tooltip>
      <div className="text-xs text-muted-foreground tabular-nums">{credits(r.charged)}</div>
      {r.expectedCharge !== undefined && r.expectedCharge !== r.charged && <div className="text-xs text-muted-foreground tabular-nums">expected {r.expectedCharge.toLocaleString()}</div>}
      {r.overcharged && <div className="mt-1 text-xs font-medium text-destructive">Billed more than used</div>}
    </div>
  );
}
