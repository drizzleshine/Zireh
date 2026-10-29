import { commentsOn, type CaseRecords } from "@zireh/cases";
import { type Edge, type Node } from "@xyflow/react";
import type { Evidence } from "@zireh/schema";
import { filesOf, textOf, viewOf } from "../../evidence.ts";

export type Kind = "evidence" | "observation" | "finding";

export interface CardData extends Record<string, unknown> {
  kind: Kind;
  title: string;
  sub: string;
  detail: string;
  icon: "note" | "document" | "link" | "image" | "observation" | "draft" | "finding";
  comments: number;
}
export type CardNode = Node<CardData, "card">;
export interface LinkData extends Record<string, unknown> {
  label: string;
  team: boolean;
  /** Signed records can only be edited by their author; teammates' cables are read-only here. */
  mine: boolean;
  by: string;
}
export type LinkEdge = Edge<LinkData, "link">;

// Board units are pixels, so they follow the interface scale set on <html> (110%) by hand.
export const CARD_W = 264;
export const COLUMN_X: Record<Kind, number> = { evidence: 0, observation: 374, finding: 748 };
export const ROW_H = 165;

function evidenceCard(e: Evidence): Pick<CardData, "sub" | "detail" | "icon"> {
  const files = filesOf(e);
  const text = textOf(e);
  const icon = files.length ? (viewOf(files[0]!) === "image" ? "image" : "document") : /^\s*https?:\/\//.test(text) ? "link" : "note";
  const what = files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "Text";
  return { sub: `${what} · ${e.source ?? "no source"}`, detail: clip(text, 600), icon };
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function cardsOf(rec: CaseRecords): { id: string; data: CardData }[] {
  return [
    ...rec.evidence.map((e) => ({
      id: e.id,
      data: { kind: "evidence" as const, title: e.title, ...evidenceCard(e), comments: commentsOn(rec, e.id).length },
    })),
    ...rec.observations
      .filter((o) => o.status !== "rejected")
      .map((o) => {
        const text = o.text.replace(/^Q: .*\n\n/, "").replace(/\s*\[A\d+\]/g, "");
        return {
          id: o.id,
          data: { kind: "observation" as const, title: clip(text, 110), sub: o.status === "draft" ? "Draft observation" : "Observation", detail: text, icon: o.status === "draft" ? ("draft" as const) : ("observation" as const), comments: commentsOn(rec, o.id).length },
        };
      }),
    ...rec.findings.map((f) => ({
      id: f.id,
      data: { kind: "finding" as const, title: clip(f.statement, 110), sub: "Finding", detail: `${f.statement}\n\nUncertainty: ${f.uncertainty}`, icon: "finding" as const, comments: commentsOn(rec, f.id).length },
    })),
  ];
}
