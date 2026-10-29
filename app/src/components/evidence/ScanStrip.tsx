import { EyeSlash as EyeOff } from "@phosphor-icons/react";
import { useState } from "react";
import { KIND_LABEL, type Hit } from "../../intake.ts";
import { cn } from "@/lib/utils";

/** Hide-list names found in this text: each is replaced before any AI call. */
export function ScanStrip({ hits, className }: { hits: readonly Hit[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const list = open ? hits : hits.slice(0, 8);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", className)}>
      <span className="mr-1 flex items-center gap-1 font-medium text-protected">
        <EyeOff className="size-3.5" />
        {hits.length} on hide list
      </span>
      {list.map((h) => (
        <span key={h.text} title="Replaced in every question" className="inline-flex max-w-56 items-center gap-1 rounded-full border border-protected/30 bg-protected-wash px-2 py-0.5 text-protected">
          <span className="truncate">{h.text}</span>
          <span className="text-muted-foreground">{KIND_LABEL[h.kind]}</span>
        </span>
      ))}
      {hits.length > 8 && (
        <button type="button" className="px-1 text-muted-foreground underline-offset-2 hover:underline" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `+${hits.length - 8} more`}
        </button>
      )}
    </div>
  );
}
