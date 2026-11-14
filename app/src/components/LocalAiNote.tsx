import type { AppStatus } from "@zireh/schema";
import { Warning as AlertTriangle, X } from "@phosphor-icons/react";
import { useState } from "react";
import { navigate } from "../route.ts";
import { cn } from "@/lib/utils";

/**
 * Shown where people write while the on-device AI is off. Direct sends that writing as-is.
 * Private and Paranoid need the model to hide names.
 */
export function LocalAiNote({ status, className }: { status: AppStatus | undefined; className?: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (!status || status.localModel.ok || dismissed) return null;
  return (
    <div className={cn("flex items-start gap-2 rounded-lg bg-muted/60 py-2 pr-1 pl-3 text-xs text-muted-foreground", className)} role="note">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-decoy" />
      <span className="flex-1 pt-px">On-device AI is off. Direct sends what you write as-is. Private and Paranoid need it to hide names.</span>
      <button type="button" onClick={() => navigate({ view: "settings" })} className="shrink-0 pt-px font-medium text-foreground underline-offset-4 hover:underline">
        Turn it on
      </button>
      <button type="button" onClick={() => setDismissed(true)} className="hit -my-0.5 shrink-0 rounded p-0.5 hover:bg-background hover:text-foreground" aria-label="Dismiss">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
