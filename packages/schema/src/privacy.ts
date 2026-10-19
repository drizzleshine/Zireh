import { z } from "zod";
import type { ChatMessage } from "./chat.ts";

export const PrivacyLevel = z.enum(["local", "standard", "private", "paranoid"]);
export type PrivacyLevel = z.infer<typeof PrivacyLevel>;

/** What each level turns on. Mirrors architecture §5.1; the pipeline reads only this table. */
export interface LevelPolicy {
  readonly cloud: boolean; // false = always answer with the local model
  readonly split: boolean;
  readonly decoys: number; // decoys added per real piece
  readonly leakThreshold: number; // 0–100; block or re-redact pieces scoring above this
}

export const LEVELS: Readonly<Record<PrivacyLevel, LevelPolicy>> = {
  local: { cloud: false, split: false, decoys: 0, leakThreshold: 0 },
  standard: { cloud: true, split: false, decoys: 0, leakThreshold: 60 },
  private: { cloud: true, split: true, decoys: 1, leakThreshold: 45 },
  paranoid: { cloud: true, split: true, decoys: 3, leakThreshold: 30 },
};

export const EntityKind = z.enum(["person", "org", "place", "id", "contact", "date", "money", "other"]);
export type EntityKind = z.infer<typeof EntityKind>;

/** One reversible substitution. The mapping lives only on the device (encrypted when shared). */
export const Pseudonym = z.object({
  original: z.string().min(1),
  placeholder: z.string().regex(/^\[[A-Z]+_\d+\]$/),
  kind: EntityKind,
  /** Vague description true of many others ("a large city in Nigeria"). Lets the cloud answer without the value. */
  hint: z.string().max(80).optional(),
});
export type Pseudonym = z.infer<typeof Pseudonym>;

export type Stage = "redact" | "route" | "split" | "leakcheck" | "decoy" | "order" | "send" | "reassemble";

/** One entry in the "what you asked / what the provider saw" view. */
export interface TraceStep {
  readonly stage: Stage;
  readonly title: string;
  readonly detail: string;
  readonly before?: string;
  readonly after?: string;
}

/** A single call that will leave the device. Decoys are indistinguishable on the wire. */
export interface OutboundPiece {
  readonly id: string;
  readonly role: "real" | "decoy";
  readonly question: string; // the redacted sub-question (for display and reassembly)
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly leakScore?: number;
}
