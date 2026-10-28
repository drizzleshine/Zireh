import type { Outcome } from "@zireh/schema";

export const OUTCOMES: { id: Outcome; label: string; plain: string; ask: string; open: string }[] = [
  { id: "resolved", label: "Proven", plain: "The evidence shows it.", ask: "What does the evidence show?", open: "Anything still unknown? (optional)" },
  { id: "unresolved", label: "Not proven yet", plain: "We know some of it.", ask: "What do you know so far?", open: "What would settle it?" },
  { id: "disputed", label: "Disputed", plain: "People read it differently.", ask: "What are the different readings?", open: "What would settle it?" },
];
