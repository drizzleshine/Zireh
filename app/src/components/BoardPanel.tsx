import { memberName, newLink } from "@zireh/cases";
import type { Link } from "@zireh/schema";
import { addEdge, Background, BackgroundVariant, ConnectionMode, MarkerType, MiniMap, Panel, ReactFlow, ReactFlowProvider, reconnectEdge, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge } from "@xyflow/react";
import { ArrowsIn, ArrowsOut, CornersIn, SquaresFour as LayoutGrid, LinkSimple as Link2, Lightbulb, Minus, Graph as Network, Notepad as NotebookText, Plus, Scales as Scale, Trash as Trash2, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "../theme.ts";
import { toast } from "sonner";
import { moveOnBoard, myMemberId, save, useStore } from "../store.ts";
import { Comments } from "./Comments.tsx";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { SwapIcon } from "@/components/ui/swap-icon";
import type { OpenItem } from "./CaseView.tsx";
import { PaneHeader } from "./Pane.tsx";
import { type Kind, type CardData, type CardNode, type LinkEdge, COLUMN_X, ROW_H, clip, cardsOf } from "./board/model.ts";
import { CardNodeView } from "./board/CardNodeView.tsx";
import { LinkActions, LinkEdgeView, sideToward } from "./board/LinkEdgeView.tsx";
import { ToolButton } from "./board/ToolButton.tsx";
import { useExpand } from "./board/useExpand.ts";
import { LegendArrow } from "./board/LegendArrow.tsx";

const nodeTypes = { card: CardNodeView };
const edgeTypes = { link: LinkEdgeView };

/**
 * The case board: every clue, observation and finding as a card on an infinite canvas.
 * Citations (observation → evidence, finding → observation) are drawn automatically and are
 * read-only. Team connections are cables: drag from any card edge to another card to make
 * one, drag a cable's end to move it to a different card, select it to rename or remove it.
 */
export function BoardPanel({ caseId, onOpen }: { caseId: string; onOpen: OpenItem }) {
  return (
    <ReactFlowProvider>
      <Board caseId={caseId} onOpen={onOpen} />
    </ReactFlowProvider>
  );
}

function Board({ caseId, onOpen }: { caseId: string; onOpen: OpenItem }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const cards = useMemo(() => cardsOf(rec), [rec]);
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const { dark } = useTheme();
  const { expanded, frame, slot, toggle } = useExpand(() => requestAnimationFrame(() => void fitView({ duration: 480, padding: 0.15, maxZoom: 1.1 })));
  const [show, setShow] = useState<Kind[]>(["evidence", "observation", "finding"]);
  const [editing, setEditing] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const me = myMemberId(caseId);

  const defaultPos = useCallback(
    (id: string, kind: Kind) => {
      const row = cards.filter((c) => c.data.kind === kind).findIndex((c) => c.id === id);
      return { x: COLUMN_X[kind], y: row * ROW_H };
    },
    [cards],
  );

  const derivedNodes = useMemo<CardNode[]>(
    () =>
      cards
        .filter((c) => show.includes(c.data.kind))
        .map((c) => ({ id: c.id, type: "card", position: rec.board[c.id] ?? defaultPos(c.id, c.data.kind), data: c.data })),
    [cards, rec.board, show, defaultPos],
  );

  const liveLinks = useMemo(() => rec.links.filter((l) => !l.removedAt), [rec.links]);
  const derivedEdges = useMemo<LinkEdge[]>(() => {
    const visible = new Set(derivedNodes.map((n) => n.id));
    const cite = (from: string, to: string): LinkEdge => ({
      id: `cite:${from}:${to}`,
      source: from,
      target: to,
      type: "link",
      data: { label: "", team: false, mine: false, by: "" },
      selectable: false,
      reconnectable: false,
      deletable: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--muted-foreground)" },
    });
    return [
      ...rec.observations.flatMap((o) => o.evidenceIds.map((e) => cite(e, o.id))),
      ...rec.findings.flatMap((f) => f.observationIds.map((o) => cite(o, f.id))),
      ...liveLinks.map(
        (l): LinkEdge => ({
          id: l.id,
          source: l.from,
          target: l.to,
          type: "link",
          data: { label: l.label, team: true, mine: l.createdBy === me, by: memberName(rec, l.createdBy) },
          reconnectable: l.createdBy === me,
          deletable: l.createdBy === me,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--protected)" },
        }),
      ),
    ].filter((e) => visible.has(e.source) && visible.has(e.target));
  }, [rec.observations, rec.findings, liveLinks, derivedNodes, me, rec]);

  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(derivedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<LinkEdge>(derivedEdges);
  // Synced records are the source of truth; keep local selection while a teammate's edit arrives.
  useEffect(() => setNodes((prev) => derivedNodes.map((n) => ({ ...n, selected: prev.find((p) => p.id === n.id)?.selected ?? false }))), [derivedNodes, setNodes]);
  useEffect(() => setEdges((prev) => derivedEdges.map((e) => ({ ...e, selected: prev.find((p) => p.id === e.id)?.selected ?? false }))), [derivedEdges, setEdges]);

  const routed = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges.map((e) => {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      return a && b ? { ...e, sourceHandle: sideToward(a, b), targetHandle: sideToward(b, a) } : e;
    });
  }, [nodes, edges]);

  const linkById = (id: string) => liveLinks.find((l) => l.id === id && l.createdBy === me);
  const persist = async (link: Link, message: string) => {
    try {
      await save(caseId, "links", link);
    } catch (error) {
      toast.error(message, { description: (error as Error).message });
    }
  };

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    if (liveLinks.some((l) => (l.from === c.source && l.to === c.target) || (l.from === c.target && l.to === c.source))) return void toast("These cards are already connected");
    const link = newLink(caseId, myMemberId(caseId), { from: c.source, to: c.target, label: "" });
    setEdges((eds) => addEdge({ ...c, id: link.id, type: "link", data: { label: "", team: true, mine: true, by: "" } }, eds));
    setEditing(link.id);
    void persist(link, "Couldn't save the connection");
  };

  const onReconnect = (old: Edge, c: Connection) => {
    const link = linkById(old.id);
    if (!link || !c.source || !c.target || c.source === c.target) return;
    setEdges((eds) => reconnectEdge(old as LinkEdge, c, eds, { shouldReplaceId: false }));
    void persist({ ...link, from: c.source, to: c.target }, "Couldn't move the connection");
  };

  const remove = (id: string) => {
    const link = linkById(id);
    if (!link) return;
    setEdges((eds) => eds.filter((e) => e.id !== id));
    void persist({ ...link, removedAt: new Date().toISOString() }, "Couldn't remove the connection");
  };

  const rename = (id: string, label: string) => {
    const link = linkById(id);
    if (link && link.label !== label.trim()) void persist({ ...link, label: label.trim() }, "Couldn't rename the connection");
  };

  const arrange = async () => {
    const moves = cards.map((c) => ({ id: c.id, ...defaultPos(c.id, c.data.kind) }));
    setNodes((ns) => ns.map((n) => ({ ...n, position: moves.find((m) => m.id === n.id) ?? n.position })));
    requestAnimationFrame(() => void fitView({ duration: 400, padding: 0.15 }));
    for (const m of moves) await moveOnBoard(caseId, m.id, m.x, m.y);
  };

  const selected = cards.find((c) => c.id === selectedId);
  const selectedLinks = selected ? liveLinks.filter((l) => l.from === selected.id || l.to === selected.id) : [];
  const titleOf = (id: string) => cards.find((c) => c.id === id)?.data.title ?? "a removed item";

  if (cards.length === 0)
    return (
      <section className="page">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
          <Network className="size-8 text-muted-foreground" />
          <strong className="text-base">The board is empty</strong>
          <p className="max-w-sm text-sm text-muted-foreground">Add evidence and it shows up here as cards you can move and link.</p>
        </div>
      </section>
    );

  // Exactly the space under the case header (inset margins + header), so the page never scrolls.
  return (
    <section className="flex h-[calc(100svh-7.25rem)] min-h-[30rem] flex-col gap-3 px-4 py-3 md:px-6" aria-label="Case board">
      <p className="shrink-0 text-sm text-muted-foreground">Evidence on the left, what people noticed in the middle, findings on the right. Drag from a card's edge to another card to link them.</p>
      <LinkActions.Provider value={{ rename, remove, editing, setEditing }}>
        {expanded && <div className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px] animate-in fade-in-0 duration-300" onClick={toggle} aria-hidden="true" />}
        <div ref={slot} className="relative min-h-0 flex-1">
        <div ref={frame} className={cn("overflow-hidden border bg-card", expanded ? "fixed inset-3 z-50 rounded-[1.375rem] shadow-2xl md:inset-4" : "absolute inset-0 rounded-[1.375rem]")} role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined} aria-label={expanded ? "Case board, expanded" : undefined}>
          <ReactFlow<CardNode, LinkEdge>
            nodes={nodes}
            edges={routed}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onEdgesDelete={(eds) => eds.forEach((e) => linkById(e.id) && remove(e.id))}
            onNodeDragStop={(_, __, dragged) => dragged.forEach((n) => void moveOnBoard(caseId, n.id, n.position.x, n.position.y))}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => {
              setSelectedId(undefined);
              setEditing(undefined);
            }}
            connectionMode={ConnectionMode.Loose}
            connectionRadius={48}
            reconnectRadius={18}
            connectionLineStyle={{ stroke: "var(--protected)", strokeWidth: 2 }}
            deleteKeyCode={["Backspace", "Delete"]}
            colorMode={dark ? "dark" : "light"}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            className="[--xy-background-color:transparent]"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--border)" />
            <Panel position="bottom-left" className="!m-3 flex flex-col overflow-hidden rounded-lg border bg-background shadow-sm">
              <ToolButton label="Zoom in" onClick={() => void zoomIn({ duration: 200 })}><Plus /></ToolButton>
              <ToolButton label="Zoom out" onClick={() => void zoomOut({ duration: 200 })}><Minus /></ToolButton>
              <ToolButton label="Show everything" onClick={() => void fitView({ duration: 400, padding: 0.15, maxZoom: 1.1 })}><CornersIn /></ToolButton>
            </Panel>
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              className="!hidden !rounded-md !border md:!block"
              nodeColor={(n) => ((n.data as CardData).kind === "finding" ? "var(--foreground)" : (n.data as CardData).kind === "observation" ? "var(--protected)" : "var(--muted-foreground)")}
              maskColor="color-mix(in oklab, var(--background) 70%, transparent)"
            />
            <Panel position="top-left" className="!m-3 flex flex-wrap items-center gap-2">
              <ToggleGroup type="multiple" variant="outline" size="sm" value={show} onValueChange={(v) => v.length && setShow(v as Kind[])} className="bg-background shadow-sm">
                <ToggleGroupItem value="evidence" className="gap-1.5 px-2.5 text-xs">
                  <NotebookText className="size-3.5" /> Evidence
                </ToggleGroupItem>
                <ToggleGroupItem value="observation" className="gap-1.5 px-2.5 text-xs">
                  <Lightbulb className="size-3.5" /> Observations
                </ToggleGroupItem>
                <ToggleGroupItem value="finding" className="gap-1.5 px-2.5 text-xs">
                  <Scale className="size-3.5" /> Findings
                </ToggleGroupItem>
              </ToggleGroup>
              <Button variant="outline" size="sm" className="bg-background text-xs shadow-sm" onClick={() => void arrange()}>
                <LayoutGrid /> Tidy up
              </Button>
            </Panel>
            <Panel position="top-right" className="!m-3 flex items-center gap-2">
              <span className="hidden h-8 items-center gap-4 rounded-lg border bg-background/90 px-3 text-xs text-muted-foreground shadow-sm backdrop-blur lg:flex">
                <span className="flex items-center gap-2">
                  <LegendArrow color="var(--muted-foreground)" dashed />
                  Backs up
                </span>
                <span className="flex items-center gap-2">
                  <LegendArrow color="var(--protected)" />
                  Linked
                </span>
              </span>
              <Button variant="outline" size="sm" className="bg-background text-xs shadow-sm" onClick={toggle} aria-label={expanded ? "Shrink the board" : "Expand the board"}>
                <SwapIcon swapped={expanded} from={<ArrowsOut />} to={<ArrowsIn />} />
                {expanded ? "Done" : "Expand"}
              </Button>
            </Panel>
          </ReactFlow>

          {selected && (
            <aside className="absolute inset-y-3 right-3 z-10 flex w-[min(20rem,calc(100%-24px))] flex-col overflow-clip rounded-2xl bg-card shadow-xl surface animate-in slide-in-from-right-4 fade-in-0 duration-200" aria-label="Selected card">
              <PaneHeader
                title={selected.data.kind === "evidence" ? "Evidence" : selected.data.kind === "observation" ? "Observation" : "Finding"}
                meta={selected.data.sub}
                actions={
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => setSelectedId(undefined)} aria-label="Close">
                    <X />
                  </Button>
                }
              />
              {selected.data.kind === "evidence" && <h3 className="px-4 pt-4 font-serif text-lg leading-snug md:px-5">{selected.data.title}</h3>}
              <div className="grid flex-1 content-start gap-4 overflow-y-auto p-4 text-sm md:px-5">
                {selected.data.detail && <p className="whitespace-pre-wrap font-serif text-[0.9375rem] leading-relaxed text-foreground/90">{selected.data.detail}</p>}
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Links</p>
                  {selectedLinks.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None yet. Pull a line from this card to another.</p>
                  ) : (
                    <ul className="grid gap-1.5">
                      {selectedLinks.map((l) => (
                        <li key={l.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
                          <Link2 className="size-3.5 shrink-0 text-protected" />
                          <span className="min-w-0 flex-1">
                            <span className="font-medium">{l.label || "linked"}</span> → <span className="text-muted-foreground">{clip(titleOf(l.from === selected.id ? l.to : l.from), 48)}</span>
                            <span className="block text-muted-foreground">by {memberName(rec, l.createdBy)}</span>
                          </span>
                          {l.createdBy === me && (
                            <Button variant="ghost" size="icon" className="size-6" onClick={() => remove(l.id)} aria-label="Remove connection">
                              <Trash2 className="size-3" />
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => onOpen(selected.data.kind === "evidence" ? "evidence" : "findings", selected.id)}>
                    Open in {selected.data.kind === "evidence" ? "Evidence" : "Findings"}
                  </Button>
                  <Comments caseId={caseId} targetId={selected.id} />
                </div>
              </div>
            </aside>
          )}
        </div>
        </div>
      </LinkActions.Provider>
    </section>
  );
}
