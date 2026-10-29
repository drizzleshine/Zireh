import { CaretLeft, DotsThree as MoreHorizontal, MagnifyingGlass as Search, User as UserRound, FileCsv as FileSpreadsheet, Plus, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { custodyCsv } from "../evidence.ts";
import type { AppStatus, Attachment } from "@zireh/schema";
import { LocalAiNote } from "./LocalAiNote.tsx";
import { filesOf, readableText } from "../evidence.ts";
import { useIdentities, withIdentities } from "../sources.ts";
import { useStore } from "../store.ts";
import type { OpenItem } from "./CaseView.tsx";
import { navigate } from "../route.ts";
import { SourcesSheet } from "./Sources.tsx";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Pane, SideItem, SideList, WITH_SIDE } from "./Pane.tsx";
import { PageBar } from "./SectionTitle.tsx";
import { evidenceIcon } from "./evidence/Files.tsx";
import { ago } from "./evidence/ago.ts";
import { Intake } from "./evidence/Intake.tsx";
import { Reader } from "./evidence/Reader.tsx";
import { EditEvidence } from "./evidence/EditEvidence.tsx";

export function EvidencePanel({ caseId, focus, onOpen, status }: { caseId: string; focus?: string | undefined; onOpen: OpenItem; status: AppStatus | undefined }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const [files, setFiles] = useState<Attachment[]>([]);
  const [query, setQuery] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string>();
  // The open item lives in the URL (/case/<id>/evidence/<item>), so reload and Back keep it.
  const chosen = focus;
  const setChosen = (id: string | undefined) => onOpen("evidence", id);
  // The add box stays out of the way until it's wanted: an empty case, the button, or a file dragged in.
  const intakeOpen = adding || rec.evidence.length === 0 || files.length > 0;
  const identities = useIdentities(caseId);
  const table = useMemo(() => withIdentities(caseId, rec.pseudonyms), [caseId, rec.pseudonyms, identities]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...rec.evidence]
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      .filter((e) => !q || e.title.toLowerCase().includes(q) || e.source?.toLowerCase().includes(q) || filesOf(e).some((f) => f.name.toLowerCase().includes(q)) || readableText(e).toLowerCase().includes(q));
  }, [rec.evidence, query]);
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
        {rec.evidence.length > 0 && !adding && !editing && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="More">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
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
            <Button size="sm" variant="outline" onClick={() => setSourcesOpen(true)}>
              <UserRound /> <span className="hidden sm:inline">Sources</span>
            </Button>
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
                    placeholder="Search titles, sources, text and files"
                    aria-label="Search evidence"
                    className="h-8 pl-8 text-sm"
                  />
                </div>
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
              const Icon = evidenceIcon(e);
              const fileCount = filesOf(e).length;
              const used = rec.observations.filter((o) => o.evidenceIds.includes(e.id) && o.status !== "rejected").length;
              return (
                <SideItem
                  key={e.id}
                  active={e.id === current?.id}
                  onSelect={() => {
                      setChosen(e.id);
                      setAdding(false);
                      setEditing(undefined);
                    }}
                  icon={<Icon />}
                  title={e.title}
                  meta={
                    <>
                      <span className={e.source ? "" : "text-decoy"}>{e.source ?? "No source"}</span>
                      <span aria-hidden="true">·</span>
                      <span>{ago(e.addedAt)}</span>
                      {fileCount > 0 && <span aria-hidden="true">·</span>}
                      {fileCount > 0 && <span>{fileCount} file{fileCount === 1 ? "" : "s"}</span>}
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
          <Pane title="New evidence" meta="Text and files are read and encrypted in this browser.">
            <LocalAiNote status={status} className="mx-4 mt-4 md:mx-6" />
            <Intake caseId={caseId} table={table} files={files} setFiles={setFiles} onAdded={(id) => { setAdding(false); setChosen(id); }} />
          </Pane>
        ) : current && editing === current.id ? (
          <Pane title="Edit evidence" meta={current.title}>
            <LocalAiNote status={status} className="mx-4 mt-4 md:mx-6" />
            <EditEvidence key={current.id} caseId={caseId} rec={rec} evidence={current} onDone={() => setEditing(undefined)} />
          </Pane>
        ) : current ? (
          <div className={cn(!chosen && "max-lg:hidden")}>
            <button type="button" onClick={() => setChosen(undefined)} className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden">
              <CaretLeft className="size-4" /> All evidence
            </button>
            <Reader key={current.id} caseId={caseId} evidence={current} query={query} table={table} onOpen={onOpen} onEdit={() => setEditing(current.id)} />
          </div>
          ) : null}
      </div>
    </section>
  );
}
