import { Warning as AlertTriangle, Check } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export type State = "done" | "todo" | "warn";

export function Item({ state, title, need, detail, children }: { state: State; title: string; need: "Required" | "Recommended"; detail: string; children?: React.ReactNode }) {
  return (
    <li className="grid gap-2.5 p-4 md:px-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
            state === "done" ? "bg-protected text-background" : state === "warn" ? "bg-decoy-wash text-decoy" : "border-2 border-muted-foreground/40",
          )}
          aria-label={state === "done" ? "Done" : state === "warn" ? "Needs attention" : "To do"}
        >
          {state === "done" ? <Check className="size-3" weight="bold" /> : state === "warn" ? <AlertTriangle className="size-3" weight="bold" /> : null}
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            {title}
            <span className={cn("rounded px-1.5 text-[10px] font-medium tracking-wide uppercase", need === "Required" ? "bg-foreground/10 text-foreground" : "text-muted-foreground")}>{need}</span>
          </p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
      {children && <div className="grid gap-2 pl-8">{children}</div>}
    </li>
  );
}
