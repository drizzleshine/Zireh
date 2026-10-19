import { memberName, newLink, type CaseRecords } from "@zireh/cases";
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { moveOnBoard, myMemberId, save, useStore } from "../store.ts";
import { Comments } from "./Comments.tsx";

type Kind = "evidence" | "observation" | "finding";
interface Card {
  id: string;
  kind: Kind;
  title: string;
  sub: string;
}

const CARD_W = 220;
const CARD_H = 92;
const COLUMN_X: Record<Kind, number> = { evidence: 24, observation: 324, finding: 624 };

function cardsOf(rec: CaseRecords): Card[] {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return [
    ...rec.evidence.map((e) => ({ id: e.id, kind: "evidence" as const, title: e.title, sub: e.kind === "image" ? "Image" : clip(e.body, 70) })),
    ...rec.observations.filter((o) => o.status !== "rejected").map((o) => ({ id: o.id, kind: "observation" as const, title: clip(o.text.replace(/^Q: .*\n\n/, ""), 90), sub: o.status === "draft" ? "Draft observation" : "Observation" })),
    ...rec.findings.map((f) => ({ id: f.id, kind: "finding" as const, title: clip(f.statement, 90), sub: "Finding" })),
  ];
}

/**
 * The case board: every clue, observation and finding as a card the team can arrange and
 * connect. Citations (observation → evidence, finding → observation) are drawn automatically;
 * team-made links carry a label.
 */
export function BoardPanel({ caseId }: { caseId: string }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const cards = useMemo(() => cardsOf(rec), [rec]);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; x: number; y: number } | undefined>();
  const [connectFrom, setConnectFrom] = useState<string | undefined>();
  const [pending, setPending] = useState<{ from: string; to: string } | undefined>();
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<string | undefined>();
  const surface = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  const pos = (c: Card, i: number) => {
    if (drag?.id === c.id) return { x: drag.x, y: drag.y };
    const saved = rec.board[c.id];
    if (saved) return saved;
    const sameKind = cards.filter((x) => x.kind === c.kind);
    return { x: COLUMN_X[c.kind], y: 24 + sameKind.indexOf(c) * (CARD_H + 20) + (i % 2) * 0 };
  };
  const centers = new Map(cards.map((c, i) => [c.id, ((p) => ({ x: p.x + CARD_W / 2, y: p.y + CARD_H / 2 }))(pos(c, i))]));

  const citations = [
    ...rec.observations.flatMap((o) => o.evidenceIds.map((e) => ({ from: e, to: o.id }))),
    ...rec.findings.flatMap((f) => f.observationIds.map((o) => ({ from: o, to: f.id }))),
  ].filter((l) => centers.has(l.from) && centers.has(l.to));

  const height = Math.max(520, ...cards.map((c, i) => pos(c, i).y + CARD_H + 40));

  function onPointerDown(e: ReactPointerEvent, c: Card, i: number) {
    if (connectFrom !== undefined) return;
    const p = pos(c, i);
    const box = surface.current!.getBoundingClientRect();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    moved.current = false;
    setDrag({ id: c.id, dx: e.clientX - box.left - p.x, dy: e.clientY - box.top - p.y, x: p.x, y: p.y });
  }
  function onPointerMove(e: ReactPointerEvent) {
    if (!drag) return;
    const box = surface.current!.getBoundingClientRect();
    moved.current = true;
    setDrag({ ...drag, x: Math.max(0, e.clientX - box.left - drag.dx), y: Math.max(0, e.clientY - box.top - drag.dy) });
  }
  function onPointerUp() {
    if (!drag) return;
    if (moved.current) void moveOnBoard(caseId, drag.id, drag.x, drag.y);
    setDrag(undefined);
  }
  function onCardClick(c: Card) {
    if (moved.current) {
      moved.current = false;
      return;
    }
    if (connectFrom === undefined) return setSelected(c.id === selected ? undefined : c.id);
    if (connectFrom === "") return setConnectFrom(c.id);
    if (connectFrom !== c.id) setPending({ from: connectFrom, to: c.id });
    setConnectFrom(undefined);
  }

  const selectedCard = cards.find((c) => c.id === selected);

  if (cards.length === 0)
    return (
      <section className="panel">
        <div className="empty">
          <strong>The board is empty</strong>
          Add evidence and observations; they appear here as cards you can arrange and connect.
        </div>
      </section>
    );

  return (
    <section className="panel" aria-label="Case board">
      <div className="board-bar">
        <button className={`btn small ${connectFrom !== undefined ? "primary" : ""}`} onClick={() => setConnectFrom(connectFrom === undefined ? "" : undefined)}>
          {connectFrom === undefined ? "Connect two cards" : connectFrom === "" ? "Pick the first card…" : "Now pick the second card…"}
        </button>
        <span className="legend">
          <span className="key evidence" /> Evidence <span className="key observation" /> Observation <span className="key finding" /> Finding
          <span className="key-line" /> cites
        </span>
      </div>
      {pending && (
        <form
          className="composer board-link-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await save(caseId, "links", newLink(caseId, myMemberId(caseId), { ...pending, label }));
            setPending(undefined);
            setLabel("");
          }}
        >
          <label htmlFor="link-label" style={{ fontWeight: 600 }}>
            How are these connected?
          </label>
          <input id="link-label" className="input" autoFocus maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="same phone number, contradicts, happened before…" />
          <div className="composer-foot">
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => setPending(undefined)}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Connect
            </button>
          </div>
        </form>
      )}
      <div className="board" ref={surface} style={{ height }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <svg className="board-lines" width="100%" height={height} aria-hidden="true">
          {citations.map((l, i) => {
            const a = centers.get(l.from)!;
            const b = centers.get(l.to)!;
            return <line key={`c${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="cite-line" />;
          })}
          {rec.links
            .filter((l) => centers.has(l.from) && centers.has(l.to))
            .map((l) => {
              const a = centers.get(l.from)!;
              const b = centers.get(l.to)!;
              return (
                <g key={l.id}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="team-line" />
                  {l.label && (
                    <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} className="line-label" textAnchor="middle">
                      {l.label}
                    </text>
                  )}
                </g>
              );
            })}
        </svg>
        {cards.map((c, i) => {
          const p = pos(c, i);
          return (
            <button
              key={c.id}
              className={`card ${c.kind} ${selected === c.id ? "selected" : ""} ${connectFrom === c.id ? "selected" : ""}`}
              style={{ left: p.x, top: p.y, width: CARD_W, height: CARD_H }}
              onPointerDown={(e) => onPointerDown(e, c, i)}
              onClick={() => onCardClick(c)}
              aria-pressed={selected === c.id}
            >
              <span className="card-sub">{c.sub}</span>
              <span className="card-title">{c.title}</span>
            </button>
          );
        })}
      </div>
      {selectedCard && (
        <aside className="item" aria-label="Selected card">
          <h3>{selectedCard.title}</h3>
          <div className="meta">
            <span>{selectedCard.sub}</span>
            {rec.links
              .filter((l) => l.from === selectedCard.id || l.to === selectedCard.id)
              .map((l) => (
                <span key={l.id}>
                  {l.label || "linked"} · {memberName(rec, l.createdBy)}
                </span>
              ))}
          </div>
          <Comments caseId={caseId} targetId={selectedCard.id} />
        </aside>
      )}
    </section>
  );
}
