import { findingViews } from "@zireh/cases";
import { ArrowRight, CaretLeft, MagnifyingGlass as Search, Check, Lightbulb, Plus } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { myMemberId, useStore } from "../store.ts";
import type { OpenItem } from "./CaseView.tsx";
import { Pane, SideItem, SideList, WITH_SIDE } from "./Pane.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PageBar } from "./SectionTitle.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { TONE_TEXT, TONE_DOT, verdict } from "./findings/verdict.ts";
import { type Filter, FILTERS } from "./findings/filters.ts";
import { FindingDetail } from "./findings/FindingDetail.tsx";
import { CheckSheet } from "./findings/CheckSheet.tsx";
import { FindingForm } from "./findings/FindingForm.tsx";

/**
 * The claims your team would print, one line each with whether it's ready. Writing a
 * finding happens in the reading pane; checking new observations has its own panel.
 */
export function FindingsPanel({ caseId, focus, onOpen }: { caseId: string; focus?: string | undefined; onOpen?: OpenItem }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const me = myMemberId(caseId);
  const findings = findingViews(rec);
  const drafts = rec.observations.filter((o) => o.status === "draft");
  const accepted = rec.observations.filter((o) => o.status === "accepted");
  // The open finding lives in the URL. An observation id there opens the finding built on it.
  const open = focus && rec.findings.some((f) => f.id === focus) ? focus : focus ? rec.findings.find((f) => f.observationIds.includes(focus))?.id : undefined;
  const setOpen = (id: string | undefined) => onOpen?.("findings", id);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const judged = findings.map((f) => ({ f, v: verdict(rec, f) }));
  const counts = Object.fromEntries(FILTERS.map((x) => [x.id, judged.filter((j) => x.match(j.v.tone)).length])) as Record<Filter, number>;
  const shown = judged.filter((j) => FILTERS.find((x) => x.id === filter)!.match(j.v.tone) && (!query.trim() || j.f.statement.toLowerCase().includes(query.trim().toLowerCase())));
  // Wide screens always show one; phones show the list until one is picked.
  const current = shown.find((j) => j.f.id === open) ?? judged.find((j) => j.f.id === open) ?? shown[0];
  const [checking, setChecking] = useState<string | boolean>(false);
  const [writing, setWriting] = useState(false);
  const [editing, setEditing] = useState<string>();

  // Something another tab pointed at: open the finding it belongs to, or the draft to check.
  useEffect(() => {
    if (!focus) return;
    if (drafts.some((o) => o.id === focus)) setChecking(focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  return (
    <section className="page" aria-label="Findings">
      {!rec.case.requiresSignatures && <p className="rounded-lg border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">This is an older case, so who wrote what can't be proven. New cases fix this.</p>}
      <PageBar hint="The claims you'd print. Each one needs two separate sources and your team's agreement.">
        {findings.length > 0 && !writing && !editing && (
          <Button size="sm" onClick={() => setWriting(true)}>
            <Plus /> New finding
          </Button>
        )}
      </PageBar>

      {drafts.length > 0 && (
        <button type="button" onClick={() => setChecking(true)} className="flex items-center gap-3 rounded-xl border border-decoy/30 bg-decoy-wash px-4 py-3 text-left text-sm transition-colors hover:border-decoy/60">
          <Lightbulb className="size-5 shrink-0 text-decoy" weight="duotone" />
          <span className="flex-1">
            <span className="font-medium">
              {drafts.length} new observation{drafts.length === 1 ? "" : "s"} to check.
            </span>{" "}
            <span className="text-muted-foreground">Accepted ones can back a finding.</span>
          </span>
          <span className="flex items-center gap-1 font-medium">
            Check {drafts.length === 1 ? "it" : "them"} <ArrowRight className="size-4" />
          </span>
        </button>
      )}

      <div className={WITH_SIDE}>
          <SideList
            title="Findings"
            count={findings.length}
            className={cn(open && "max-lg:hidden")}
            top={
              findings.length === 0 ? undefined : (
                <>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} placeholder="Search findings" aria-label="Search findings" className="h-8 pl-8 text-sm" />
                  </div>
                  <ToggleGroup type="single" size="sm" variant="outline" value={filter} onValueChange={(v) => v && setFilter(v as Filter)} aria-label="Show" className="flex-wrap justify-start">
                    {FILTERS.filter((x) => x.id === "all" || counts[x.id]).map((x) => (
                      <ToggleGroupItem key={x.id} value={x.id} className="gap-1 px-2.5 text-xs">
                        {x.label} {x.id !== "all" && <span className="tabular-nums opacity-60">{counts[x.id]}</span>}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </>
              )
            }
          >
            {findings.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">No findings yet. Write the first one to get started.</li>
            ) : shown.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</li>
            ) : (
              shown.map(({ f, v }) => (
                <SideItem
                  key={f.id}
                  active={f.id === current?.f.id}
                  onSelect={() => {
                    setOpen(f.id);
                    setWriting(false);
                    setEditing(undefined);
                  }}
                  icon={<span className="grid size-4 place-items-center"><span className={cn("block size-2.5 rounded-full", TONE_DOT[v.tone])} /></span>}
                  title={f.statement}
                  meta={<span className={TONE_TEXT[v.tone]}>{v.text}</span>}
                />
              ))
            )}
          </SideList>
          {writing || findings.length === 0 ? (
            <Pane title="New finding" meta="Write the claim, then tick what proves it.">
              <FindingForm caseId={caseId} rec={rec} me={me} accepted={accepted} onDone={(id) => { setWriting(false); if (id) setOpen(id); }} />
            </Pane>
          ) : current && editing === current.f.id ? (
            <Pane title="Edit finding" meta="Reword the claim or change what proves it.">
              <FindingForm key={current.f.id} caseId={caseId} rec={rec} me={me} accepted={accepted} finding={current.f} onDone={() => setEditing(undefined)} />
            </Pane>
          ) : current ? (
            <div className={cn(!open && "max-lg:hidden")}>
              <button type="button" onClick={() => setOpen(undefined)} className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden">
                <CaretLeft className="size-4" /> All findings
              </button>
              <FindingDetail key={current.f.id} caseId={caseId} rec={rec} finding={current.f} verdict={current.v} me={me} onOpen={onOpen} onEdit={() => setEditing(current.f.id)} />
            </div>
          ) : null}
      </div>

      <CheckSheet caseId={caseId} rec={rec} drafts={drafts} start={typeof checking === "string" ? checking : undefined} open={checking !== false} onClose={() => setChecking(false)} onOpen={onOpen} />
    </section>
  );
}
