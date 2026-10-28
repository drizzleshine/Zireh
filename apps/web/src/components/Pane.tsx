import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one container every tab uses: a raised card with an optional header (title, count, a line
 * of detail, actions) and footer. Lists, reading panes, checklists and side columns all share it,
 * so moving between tabs never changes how a panel looks.
 */
export function Pane({ title, count, meta, actions, footer, className, bodyClassName, children, ...rest }: {
  title?: ReactNode;
  count?: number | undefined;
  meta?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  return (
    <section className={cn("grid overflow-clip rounded-2xl bg-card surface", className)} {...rest}>
      {(title || actions) && <PaneHeader title={title} count={count} meta={meta} actions={actions} />}
      {children !== undefined && <div className={cn("min-w-0", bodyClassName)}>{children}</div>}
      {footer && <div className={PANE_FOOTER}>{footer}</div>}
    </section>
  );
}

/** Footer and header classes, also used by the side sheets so they match every panel. */
export const PANE_FOOTER = "flex min-h-14 flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2 md:px-5";
export const SHEET_HEADER = "gap-0.5 border-b px-4 py-3 md:px-5 [&_[data-slot=sheet-title]]:text-sm";

export function PaneHeader({ title, count, meta, actions, className }: { title?: ReactNode; count?: number | undefined; meta?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 md:px-5", className)}>
      <div className="grid min-w-0 flex-1 gap-0.5">
        {title && (
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {title}
            {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
          </h2>
        )}
        {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}

/** A side column: a Pane whose body is a list of items to pick from. Used by Evidence, Findings and Research. */
export function SideList({ title, count, top, children, className }: { title: ReactNode; count?: number; top?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Pane title={title} count={count} className={cn("lg:sticky lg:top-28", className)}>
      {top && <div className="grid gap-2 border-b px-3 py-3">{top}</div>}
      <ul className="grid max-h-[calc(100svh-16rem)] gap-0.5 overflow-y-auto p-1.5">{children}</ul>
    </Pane>
  );
}

/** One pickable item in a SideList: an icon, a title of up to two lines, and one line of detail. */
export function SideItem({ active, onSelect, icon, title, meta, live }: { active: boolean; onSelect: () => void; icon?: ReactNode; title: ReactNode; meta: ReactNode; live?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <li>
      <button
        ref={ref}
        type="button"
        onClick={onSelect}
        aria-current={active || undefined}
        className={cn("grid w-full gap-x-2.5 gap-y-0.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none", icon ? "grid-cols-[1rem_minmax(0,1fr)]" : "grid-cols-1", active && "bg-muted")}
      >
        {icon && <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>}
        <span className="line-clamp-2 text-sm leading-snug font-medium">{title}</span>
        <span className={cn("flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums", icon && "col-start-2")}>
          {live && <span className="size-1.5 animate-pulse rounded-full bg-protected" aria-label="Working" />}
          {meta}
        </span>
      </button>
    </li>
  );
}

/** Columns with a side list: the same width on every tab. */
export const WITH_SIDE = "grid items-start gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]";
