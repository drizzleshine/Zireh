import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * The one heading every tab and section uses: icon, title, optional count, a one-line hint, and
 * actions on the right. Keeping this identical everywhere is what makes the tabs feel like one app.
 */
export function SectionTitle({ icon: Glyph, title, count, hint, children }: { icon: Icon; title: string; count?: number | undefined; hint?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <div className="grid min-w-0 flex-1 basis-64 gap-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Glyph className="size-4 text-muted-foreground" weight="duotone" /> {title}
          {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
        </h2>
        {hint && <p className="max-w-[70ch] text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** The empty state every list uses. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

/**
 * The first row of every tab. The tab itself is the page title, so this never repeats it: it says
 * what the page is for in one line and holds the page's controls on the right.
 * It sits directly in .page; the -mb-4 brings what follows to 16px, like any heading.
 */
export function PageBar({ hint, children }: { hint: string; children?: ReactNode }) {
  return (
    <div className="-mb-4 flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2">
      <p className="min-w-0 flex-1 basis-64 text-sm text-muted-foreground">{hint}</p>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
