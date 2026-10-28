import type { Evidence } from "@zireh/schema";
import { FileText, Image as ImageIcon, LinkSimple as Link2, Note as StickyNote } from "@phosphor-icons/react";

export const KINDS: { id: Evidence["kind"]; label: string; icon: typeof StickyNote }[] = [
  { id: "note", label: "Note", icon: StickyNote },
  { id: "document", label: "Document", icon: FileText },
  { id: "link", label: "Link", icon: Link2 },
  { id: "image", label: "Image", icon: ImageIcon },
];
export const kindOf = (id: Evidence["kind"]) => KINDS.find((k) => k.id === id)!;
