import { extendTable } from "@zireh/redact";
import type { Pseudonym } from "@zireh/schema";
import { Check, EyeSlash as EyeOff } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { KIND_LABEL, type Hit } from "../../intake.ts";
import { withoutIdentities } from "../../sources.ts";
import { savePseudonyms } from "../../store.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** What the device found that would be hidden before any AI call, with one-click "always hide". */
export function ScanStrip({ hits, caseId, table, className }: { hits: readonly Hit[]; caseId: string; table: readonly Pseudonym[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const known = hits.filter((h) => h.known).length;
  const sure = hits.filter((h) => !h.known && !h.guess);
  const guesses = hits.filter((h) => h.guess);
  const hide = async (h: Hit) => {
    try {
      await savePseudonyms(caseId, withoutIdentities(caseId, extendTable(table, [{ text: h.text, kind: h.kind }])));
      toast.success(`“${h.text}” will always be hidden`, { description: "Added to this case's hide list for every member." });
    } catch (error) {
      toast.error("Couldn't update the hide list", { description: (error as Error).message });
    }
  };
  const list = open ? hits : hits.slice(0, 8);

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", className)}>
      <span className="mr-1 flex items-center gap-1 font-medium text-protected">
        <EyeOff className="size-3.5" />
        {known ? `${known} on hide list` : null}
        {known && (sure.length || guesses.length) ? " · " : null}
        {sure.length ? `${sure.length} detail${sure.length === 1 ? "" : "s"}` : null}
        {sure.length && guesses.length ? " · " : null}
        {guesses.length ? `${guesses.length} possible name${guesses.length === 1 ? "" : "s"}` : null}
      </span>
      {list.map((h) => (
        <Tooltip key={h.text}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => !h.known && void hide(h)}
              className={cn(
                "inline-flex max-w-56 items-center gap-1 rounded-full border px-2 py-0.5 transition-colors",
                h.known ? "border-protected/30 bg-protected-wash text-protected" : h.guess ? "border-dashed hover:border-protected hover:text-protected" : "hover:border-protected hover:text-protected",
              )}
            >
              {h.known && <Check className="size-3" />}
              <span className="truncate">{h.text}</span>
              <span className="text-muted-foreground">{KIND_LABEL[h.kind]}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{h.known ? "Already replaced in every question" : h.guess ? "Looks like a name. Click to always hide it." : "Detected on this device. Click to always hide it."}</TooltipContent>
        </Tooltip>
      ))}
      {hits.length > 8 && (
        <button type="button" className="px-1 text-muted-foreground underline-offset-2 hover:underline" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `+${hits.length - 8} more`}
        </button>
      )}
    </div>
  );
}
