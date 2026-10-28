import { type Tone } from "./verdict.ts";

export type Filter = "all" | "good" | "warn" | "bad" | "none";
export const FILTERS: { id: Filter; label: string; match: (t: Tone) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "good", label: "Ready", match: (t) => t === "good" },
  { id: "warn", label: "Needs work", match: (t) => t === "warn" },
  { id: "bad", label: "Disputed", match: (t) => t === "bad" },
  { id: "none", label: "Not reviewed", match: (t) => t === "none" },
];
