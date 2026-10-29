import { ConnectionMode, Handle, Position, type NodeProps } from "@xyflow/react";
import { FileText, Image as ImageIcon, LinkSimple as Link2, Lightbulb, ChatCircle as MessageSquare, Scales as Scale, Note as StickyNote } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { type CardNode, CARD_W } from "./model.ts";

const ICONS = { note: StickyNote, document: FileText, link: Link2, image: ImageIcon, observation: Lightbulb, draft: Lightbulb, finding: Scale } as const;

/** Same handle on every side; ConnectionMode.Loose lets any of them start or end a cable. */
const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

export function CardNodeView({ data, selected }: NodeProps<CardNode>) {
  const Icon = ICONS[data.icon];
  return (
    <div
      className={cn(
        "group/card relative rounded-lg border bg-card px-3.5 py-3 text-left shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition-[box-shadow,border-color] duration-150",
        data.kind === "observation" && "border-protected/40 bg-protected-wash",
        data.kind === "finding" && "border-primary bg-primary text-primary-foreground",
        data.icon === "draft" && "border-dashed",
        selected && "ring-2 ring-ring ring-offset-2 ring-offset-background shadow-lg",
      )}
      style={{ width: CARD_W }}
    >
      {SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={side}
          className="!size-3 !border-2 !border-background !bg-protected opacity-0 transition-opacity group-hover/card:opacity-100 [.connecting_&]:opacity-100"
        />
      ))}
      {/* Whole-card drop target: end a new or moved cable anywhere on the card, not just on a dot. */}
      <Handle id="body" type="source" position={Position.Top} isConnectableStart={false} className="!absolute !inset-0 !size-auto !translate-none !rounded-lg !border-0 !bg-transparent !opacity-0" />
      <div className={cn("mb-1.5 flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wide", data.kind === "finding" ? "text-primary-foreground/70" : "text-muted-foreground")}>
        <Icon className="size-3.5" />
        {data.sub}
        {data.comments > 0 && (
          <span className="ml-auto inline-flex items-center gap-0.5 normal-case tracking-normal">
            <MessageSquare className="size-3" />
            {data.comments}
          </span>
        )}
      </div>
      <p className="font-serif text-[0.9375rem] leading-snug text-pretty">{data.title}</p>
    </div>
  );
}
