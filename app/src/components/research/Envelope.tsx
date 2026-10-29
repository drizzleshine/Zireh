import { CaretRight as ChevronRight, Shuffle } from "@phosphor-icons/react";
import { formatUsd, plainFailure } from "../../api.ts";
import type { PieceState } from "../../research-history.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function Envelope({ piece, index }: { piece: PieceState; index: number }) {
  const m = /^Session ([0-9a-f]{64})\n\n([\s\S]*)$/.exec(piece.wire);
  const decoy = piece.role !== "real";
  return (
    <div
      className={cn("arrive grid gap-2 rounded-lg border p-3", decoy && "border-transparent bg-decoy-wash", piece.status === "failed" && "border-destructive")}
      style={{ ["--i" as string]: index }}
    >
      {m && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="justify-self-start rounded border border-dashed px-1.5 font-mono text-[0.6875rem] text-muted-foreground">case salt {m[1]!.slice(0, 10)}…</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">A random tag per case, so providers can't match your questions with anyone else's.</TooltipContent>
        </Tooltip>
      )}
      <p className="font-serif text-[0.9375rem] leading-snug">{m ? m[2] : piece.wire}</p>
      {piece.messages && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" /> All request messages
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-background/60 p-2 text-[0.6875rem] whitespace-pre-wrap">{piece.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n")}</pre>
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className={cn("flex items-center gap-1 font-medium", decoy ? "text-decoy" : "text-foreground")}>
          {decoy && <Shuffle className="size-3" />}
          {decoy ? "Decoy · answer discarded" : "Real question"}
        </span>
        <span className={cn(piece.status === "sent" && "animate-pulse")}>
          {piece.status === "planned" ? "queued" : piece.status === "sent" ? "sending…" : piece.status === "answered" ? `${((piece.ms ?? 0) / 1000).toFixed(1)} s` : `failed: ${plainFailure(piece.error)}`}
        </span>
        {piece.charged !== undefined && <span className="tabular-nums">{formatUsd(piece.charged)}</span>}
        {piece.leakScore !== undefined && <span>leak score {piece.leakScore}</span>}
      </div>
    </div>
  );
}
