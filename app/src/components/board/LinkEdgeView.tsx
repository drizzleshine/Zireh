import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type EdgeProps } from "@xyflow/react";
import { Trash as Trash2 } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { type CardNode, type LinkEdge, CARD_W } from "./model.ts";

/** Lets the edge label call back into the panel without threading props through React Flow. */
export const LinkActions = createContext<{ rename: (id: string, label: string) => void; remove: (id: string) => void; editing: string | undefined; setEditing: (id: string | undefined) => void }>({
  rename: () => {},
  remove: () => {},
  editing: undefined,
  setEditing: () => {},
});

/** The side of a card that faces another card, so cables leave toward where they are going. */
export function sideToward(node: CardNode, other: CardNode): Position {
  const size = (n: CardNode) => ({ w: n.measured?.width ?? CARD_W, h: n.measured?.height ?? 90 });
  const { w, h } = size(node);
  const dx = other.position.x + size(other).w / 2 - (node.position.x + w / 2);
  const dy = other.position.y + size(other).h / 2 - (node.position.y + h / 2);
  // Cards in one column: leave and enter on the right so the cable curves round the cards between,
  // through the gap before the next column.
  if (Math.abs(dx) < w * 0.5) return Position.Right;
  // Prefer side exits once cards no longer overlap horizontally; columns read left to right.
  if (Math.abs(dx) > w * 0.75 || Math.abs(dx) / w > Math.abs(dy) / h) return dx > 0 ? Position.Right : Position.Left;
  return dy > 0 ? Position.Bottom : Position.Top;
}

export function LinkEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<LinkEdge>) {
  const bezier = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  // Both ends on the right (same column): bow out sideways, staying inside the gap between columns.
  const bow = Math.min(60, Math.max(36, Math.abs(targetY - sourceY) * 0.25));
  const [path, labelX, labelY] =
    sourcePosition === Position.Right && targetPosition === Position.Right
      ? [`M ${sourceX} ${sourceY} C ${sourceX + bow} ${sourceY}, ${targetX + bow} ${targetY}, ${targetX} ${targetY}`, Math.max(sourceX, targetX) + bow * 0.75, (sourceY + targetY) / 2]
      : bezier;
  const { rename, remove, editing, setEditing } = useContext(LinkActions);
  const [draft, setDraft] = useState(data?.label ?? "");
  useEffect(() => setDraft(data?.label ?? ""), [data?.label]);
  const team = data?.team ?? false;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd ? { markerEnd } : {})}
        interactionWidth={24}
        style={team ? { stroke: "var(--protected)", strokeWidth: selected ? 3 : 2 } : { stroke: "var(--muted-foreground)", strokeWidth: 1.25, strokeDasharray: "5 5", opacity: 0.7 }}
      />
      {team && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan pointer-events-auto absolute" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {editing === id ? (
              <form
                className="flex items-center gap-1 rounded-md border bg-popover p-1 shadow-md"
                onSubmit={(e) => {
                  e.preventDefault();
                  rename(id, draft);
                  setEditing(undefined);
                }}
              >
                <Input autoFocus value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} placeholder="same phone, contradicts…" className="h-7 w-48 text-xs" onKeyDown={(e) => e.key === "Escape" && setEditing(undefined)} />
                <Button type="submit" size="sm" className="h-7 px-2 text-xs">
                  Save
                </Button>
              </form>
            ) : (
              <span className={cn("flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[0.6875rem] font-medium text-protected shadow-sm", selected && "border-protected")}>
                <button type="button" onDoubleClick={() => data?.mine && setEditing(id)} onClick={() => selected && data?.mine && setEditing(id)} title={data?.mine ? "Double-click to rename" : `${data?.by}'s cable. Only they can change it.`}>
                  {data?.label || "linked"}
                </button>
                {selected && data?.mine && (
                  <button type="button" onClick={() => remove(id)} aria-label="Remove connection" className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="size-3" />
                  </button>
                )}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
