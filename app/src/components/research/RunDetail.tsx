import { CaretRight as ChevronRight } from "@phosphor-icons/react";
import type { Run } from "../../research-history.ts";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Envelope } from "./Envelope.tsx";

/** The full record of one question: what stayed here, what the provider received, and each step. */
export function RunDetail({ run, running }: { run: Run; running: boolean }) {
  const real = run.pieces.filter((p) => p.role === "real").length;
  const decoys = run.pieces.length - real;
  const sent = run.pieces.some((piece) => piece.status !== "planned");
  return (
    <div className="grid gap-4">
      <div className={cn("grid overflow-hidden rounded-xl bg-card surface", run.table.length > 0 && "md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]")}>
        {run.table.length > 0 && (
        <section className="grid content-start gap-4 border-t-[3px] border-t-protected p-4 md:p-6" aria-label="Hidden on this device">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            Hidden on this device <Badge variant="outline" className="border-protected/30 bg-protected-wash font-normal text-protected tabular-nums">{run.table.length}</Badge>
          </h2>
            <dl className="grid gap-1.5 text-sm">
              {run.table.map((p) => (
                <div className="grid grid-cols-[minmax(0,auto)_1fr] items-baseline gap-3" key={p.placeholder}>
                  <dt className="truncate font-medium">{p.original}</dt>
                  <dd className="text-muted-foreground">sent as “{p.hint ?? p.placeholder}”</dd>
                </div>
              ))}
            </dl>
        </section>
        )}
        <section className={cn("grid content-start gap-4 border-t-[3px] border-t-foreground p-4 md:p-6", run.table.length > 0 && "md:border-l")} aria-label="Requests for the provider">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {run.example ? "What the provider would see" : sent ? "What the provider saw" : "Prepared for the provider"}
            <Badge variant="secondary" className="font-normal">
              {run.level === "local" ? "nothing" : run.pieces.length ? run.pieces.length === 1 ? "1 request" : `${run.pieces.length} separate requests` : running ? "preparing…" : "—"}
            </Badge>
          </h2>
          {run.level === "local" && run.done && <p className="text-sm text-muted-foreground">Answered by the model on this device. Nothing was sent.</p>}
          {running && !run.pieces.length && run.level !== "local" && (
            <div className="grid gap-2">
              {[0, 1].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          )}
          <div className="grid gap-2.5">
            {run.pieces.map((p, i) => (
              <Envelope key={p.id} piece={p} index={i} />
            ))}
          </div>
          {run.blocked.map((b) => (
            <div className="grid gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" key={b.question}>
              <strong className="text-destructive">Not sent: leak check scored {b.score}</strong>
              <p className="font-serif">{b.question}</p>
              <p className="text-xs text-muted-foreground">{b.inferences.join("; ")}</p>
            </div>
          ))}
          {decoys > 0 && (
            <p className="text-xs text-muted-foreground">
              {real} real question{real === 1 ? "" : "s"} and {decoys} decoy{decoys === 1 ? "" : "s"}. Only this device knows which is which.
            </p>
          )}
        </section>
      </div>

      {run.steps.length > 0 && (
        <Collapsible defaultOpen={running}>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
            Step by step · {run.steps.length} steps
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="mt-3 grid gap-0 border-l pl-5" aria-label="What happened">
              {run.steps.map(({ step, atMs }, i) => (
                <li key={i} className="relative pb-3 last:pb-0">
                  <span className="absolute -left-[25px] top-1.5 size-2 rounded-full bg-protected ring-4 ring-background" />
                  <div className="flex items-baseline gap-3">
                    <span className="text-sm font-medium">{step.title}</span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums" title="Time since you asked">+{(atMs / 1000).toFixed(1)} s</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{step.detail}</p>
                </li>
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      )}

    </div>
  );
}
