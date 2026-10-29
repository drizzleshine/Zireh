import { CalendarBlank as CalendarRange, FileText, User as UserRound } from "@phosphor-icons/react";
import { Fragment, useMemo } from "react";
import { chronology, type ChronoEvent } from "../chronology.ts";
import { useStore } from "../store.ts";
import type { OpenItem } from "./CaseView.tsx";
import { PageBar } from "./SectionTitle.tsx";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const dateLabel = (e: ChronoEvent) => (e.precision === "month" ? "—" : e.end ? `${day(e.date)}–${new Date(`${e.end}T12:00:00`).getDate()}` : day(e.date));

/** Every date written in the evidence, in order, each tied to where it came from. */
export function TimelinePanel({ caseId, onOpen }: { caseId: string; onOpen: OpenItem }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const { events, undated } = useMemo(() => chronology(rec.evidence), [rec.evidence]);
  // Separate sources that put something on the same day: the strongest sign two accounts agree.
  const sourcesOn = (date: string) => new Set(events.filter((e) => e.date === date && e.evidence.source).map((e) => e.evidence.source)).size;
  const guessed = events.some((e) => e.guessedYear);

  if (events.length === 0)
    return (
      <section className="page">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
          <CalendarRange className="size-8 text-muted-foreground" />
          <strong>No dates found yet</strong>
          <p className="max-w-sm text-sm text-muted-foreground">Dates inserted into your evidence, show up here in order.</p>
        </div>
      </section>
    );

  let lastMonth = "";
  return (
    <section className="page" aria-label="Timeline">
      <PageBar hint={`Dates found in your evidence, in order. Click one to open where it came from.${guessed ? " Where no year is written, the year the item was added is assumed." : ""}`} />

      <ol className="relative grid">
        {events.map((e, i) => {
          const month = e.date.slice(0, 7);
          const header = month !== lastMonth;
          lastMonth = month;
          const sameDay = events[i - 1]?.date === e.date;
          const agreeing = sourcesOn(e.date);
          return (
            <Fragment key={e.key}>
              {header && (
                <li className="sticky top-24 z-10 -mx-1 bg-background/90 px-1 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur">
                  {new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
                </li>
              )}
              <li className="grid grid-cols-[72px_20px_1fr] gap-x-3 md:grid-cols-[96px_20px_1fr]">
                <div className="pt-4 text-right text-sm font-medium tabular-nums" title={`Written as “${e.label}”${e.guessedYear ? ", year assumed" : ""}`}>
                  {sameDay ? "" : dateLabel(e)}
                </div>
                <div className="relative flex justify-center">
                  <span className="absolute inset-y-0 w-px bg-border" />
                  <span className="relative mt-5 size-2 rounded-full bg-muted-foreground/40 ring-4 ring-background" />
                </div>
                <button type="button" onClick={() => onOpen("evidence", e.evidence.id)} className="card my-2 gap-2 text-left surface transition-colors hover:bg-muted/30">
                  <p className="font-serif text-[0.9375rem] leading-relaxed">{e.text}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <FileText className="size-3.5" /> {e.evidence.title}
                    </span>
                    <Badge variant="outline" className={cn("gap-1 font-normal", !e.evidence.source && "text-decoy")}>
                      <UserRound className="size-3" /> {e.evidence.source ?? "No source"}
                    </Badge>
                    {!sameDay && agreeing > 1 && <span className="text-protected">{agreeing} sources on this day</span>}
                  </div>
                </button>
              </li>
            </Fragment>
          );
        })}
      </ol>

      {undated.length > 0 && (
        <p className="text-xs text-muted-foreground">
          No dates found in {undated.length} item{undated.length === 1 ? "" : "s"}:{" "}
          {undated.map((e, i) => (
            <Fragment key={e.id}>
              {i > 0 && ", "}
              <button type="button" onClick={() => onOpen("evidence", e.id)} className="underline-offset-4 hover:text-foreground hover:underline">
                {e.title}
              </button>
            </Fragment>
          ))}
          .
        </p>
      )}
    </section>
  );
}
