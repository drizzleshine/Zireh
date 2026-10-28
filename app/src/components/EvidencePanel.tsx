import type { Evidence } from "@zireh/schema";
import { CaretLeft, DotsThree as MoreHorizontal, MagnifyingGlass as Search, User as UserRound, FileCsv as FileSpreadsheet, Plus, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { custodyCsv } from "../evidence.ts";
import { type Draft } from "../intake.ts";
import { useIdentities, withIdentities } from "../sources.ts";
import { useStore } from "../store.ts";
import type { OpenItem } from "./CaseView.tsx";
import { navigate } from "../route.ts";
import { SourcesSheet } from "./Sources.tsx";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { Pane, SideItem, SideList, WITH_SIDE } from "./Pane.tsx";
import { PageBar } from "./SectionTitle.tsx";
import { KINDS, kindOf } from "./evidence/kinds.ts";
import { ago } from "./evidence/ago.ts";
import { Intake } from "./evidence/Intake.tsx";
import { Reader } from "./evidence/Reader.tsx";

export function EvidencePanel({ caseId, focus, onOpen }: { caseId: string; focus?: string | undefined; onOpen: OpenItem }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Evidence["kind"] | "all">("all");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  // The open item lives in the URL (/case/<id>/evidence/<item>), so reload and Back keep it.
  const chosen = focus;
  const setChosen = (id: string | undefined) => onOpen("evidence", id);
  // The add box stays out of the way until it's wanted: an empty case, the button, or a file dragged in.
  const intakeOpen = adding || rec.evidence.length === 0 || drafts.length > 0;
  const identities = useIdentities(caseId);
  const table = useMemo(() => withIdentities(caseId, rec.pseudonyms), [caseId, rec.pseudonyms, identities]);

  const counts = useMemo(() => Object.fromEntries(KINDS.map((k) => [k.id, rec.evidence.filter((e) => e.kind === k.id).length])) as Record<Evidence["kind"], number>, [rec.evidence]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...rec.evidence]
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      .filter((e) => (filter === "all" || e.kind === filter) && (!q || e.title.toLowerCase().includes(q) || e.source?.toLowerCase().includes(q) || (e.kind !== "image" && e.body.toLowerCase().includes(q))));
  }, [rec.evidence, query, filter]);
  // Wide screens always show something in the reading pane; phones show the list until one is picked.
  const current = shown.find((e) => e.id === chosen) ?? rec.evidence.find((e) => e.id === chosen) ?? shown[0];
  const step = (by: number) => {
    const i = shown.findIndex((e) => e.id === current?.id);
    const next = shown[Math.min(shown.length - 1, Math.max(0, i + by))];
    // Arrow keys move through the list without filling Back with every step.
    if (next) navigate({ view: "case", caseId, tab: "evidence", item: next.id }, { replace: true });
  };

  return (
    <section className="page" aria-label="Evidence" onDragEnter={(e) => e.dataTransfer.types.includes("Files") && setAdding(true)}>
      <SourcesSheet caseId={caseId} rec={rec} open={sourcesOpen} onOpenChange={setSourcesOpen} />
      <PageBar hint="Files, tips and links for this case, read and encrypted in this browser.">
        {rec.evidence.length > 0 && !adding && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="More">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setSourcesOpen(true)}>
                  <UserRound /> Sources
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    const href = URL.createObjectURL(new Blob([custodyCsv(rec)], { type: "text/csv;charset=utf-8" }));
                    const a = document.createElement("a");
                    a.href = href;
                    a.download = `${rec.case.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}-evidence-log.csv`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(href), 1000);
                    toast.success("List exported", { description: "Who added what, when and from which source. Real names are left out." });
                  }}
                >
                  <FileSpreadsheet /> Export list (CSV)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant={intakeOpen ? "outline" : "default"} onClick={() => setAdding((v) => !v)}>
              {intakeOpen ? <X /> : <Plus />}
              <span className="hidden sm:inline">{intakeOpen ? "Close" : "Add evidence"}</span>
            </Button>
          </>
        )}
      </PageBar>

      <div className={WITH_SIDE}>
        <SideList
          title="Evidence"
          count={rec.evidence.length}
          className={cn(chosen && "max-lg:hidden")}
          top={
            rec.evidence.length === 0 ? undefined : (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setQuery("");
                      else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        step(1);
                      }
                    }}
                    placeholder="Search titles, sources and text"
                    aria-label="Search evidence"
                    className="h-8 pl-8 text-sm"
                  />
                </div>
                <ToggleGroup type="single" size="sm" variant="outline" value={filter} onValueChange={(v) => v && setFilter(v as typeof filter)} aria-label="Show" className="justify-start">
                  <ToggleGroupItem value="all" className="px-2.5 text-xs">
                    All
                  </ToggleGroupItem>
                  {KINDS.filter((k) => counts[k.id]).map((k) => (
                    <ToggleGroupItem key={k.id} value={k.id} className="gap-1 px-2.5 text-xs">
                      {k.label}s <span className="tabular-nums opacity-60">{counts[k.id]}</span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </>
            )
          }
        >
          {rec.evidence.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">No evidence yet. Add your first item to get started.</li>
          ) : shown.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</li>
          ) : (
            shown.map((e) => {
              const Icon = kindOf(e.kind).icon;
              const used = rec.observations.filter((o) => o.evidenceIds.includes(e.id) && o.status !== "rejected").length;
              return (
                <SideItem
                  key={e.id}
                  active={e.id === current?.id}
                  onSelect={() => {
                      setChosen(e.id);
                      setAdding(false);
                    }}
                  icon={<Icon />}
                  title={e.title}
                  meta={
                    <>
                      <span className={e.source ? "" : "text-decoy"}>{e.source ?? "No source"}</span>
                      <span aria-hidden="true">·</span>
                      <span>{ago(e.addedAt)}</span>
                      {used > 0 && <span aria-hidden="true">·</span>}
                      {used > 0 && <span>used {used}×</span>}
                    </>
                  }
                />
              );
            })
          )}
        </SideList>
        {intakeOpen ? (
          <Pane bodyClassName="grid gap-3 p-4 md:p-6">
            <p className="text-center text-xs text-muted-foreground">
              {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            </p>
            <Intake caseId={caseId} table={table} drafts={drafts} setDrafts={setDrafts} />
          </Pane>
        ) : current ? (
          <div className={cn(!chosen && "max-lg:hidden")}>
            <button type="button" onClick={() => setChosen(undefined)} className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden">
              <CaretLeft className="size-4" /> All evidence
            </button>
            <Reader key={current.id} caseId={caseId} evidence={current} query={query} table={table} onOpen={onOpen} />
          </div>
          ) : null}
      </div>
    </section>
  );
}
