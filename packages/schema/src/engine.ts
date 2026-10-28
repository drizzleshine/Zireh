import type { Pseudonym, TraceStep } from "./privacy.ts";

/** Contract between the in-browser engine (wallet, privacy pipeline, on-device model) and the UI. */

export type LocalModelState = "off" | "loading" | "ready" | "failed" | "unsupported";

export interface AppStatus {
  readonly localModel: { readonly id: string; readonly ok: boolean; readonly state: LocalModelState; readonly percent?: number; readonly error?: string };
  readonly relay: { readonly ok: boolean; readonly upstreamOk?: boolean; readonly network?: string; readonly models: string[]; readonly search?: boolean; readonly error?: string };
  readonly balance: number;
  readonly pendingCalls: number;
  /** Another tab holds the wallet; this one can't spend until it closes. */
  readonly walletBusy?: boolean;
}

export interface PlannedPiece {
  readonly id: string;
  readonly role: "real" | "decoy";
  readonly question: string;
  readonly messages?: readonly import("./chat.ts").ChatMessage[];
  readonly wire: string; // the user message exactly as sent
  readonly leakScore?: number;
}

export interface Citations {
  readonly text: string;
  readonly cited: string[];
  readonly invalidCitations: string[];
  readonly uncited: string[];
}

export type ResearchEvent =
  | { readonly type: "started"; readonly runId: string }
  | { readonly type: "prepared"; readonly runId: string; readonly estimatedCost: number }
  | { readonly type: "cancelled"; readonly runId: string; readonly sent: number; readonly settled: number; readonly answers: readonly { id: string; answer: string }[]; readonly table: readonly Pseudonym[]; readonly spent: number; readonly ms: number }
  | { readonly type: "step"; readonly step: TraceStep; readonly atMs: number }
  | { readonly type: "redacted"; readonly table: readonly Pseudonym[] }
  | {
      readonly type: "plan";
      readonly table: readonly Pseudonym[];
      readonly pieces: readonly PlannedPiece[];
      readonly blocked: readonly { question: string; score: number; inferences: string[] }[];
    }
  | { readonly type: "piece"; readonly id: string; readonly status: "sent" | "answered" | "failed"; readonly circuit?: string; readonly ms?: number; readonly charged?: number; readonly error?: string }
  | {
      readonly type: "done";
      readonly outcome: { readonly answer: string; readonly redactedAnswer: string; readonly citations: Citations };
      readonly table: Pseudonym[];
      readonly spent: number;
      readonly ms: number;
    }
  | { readonly type: "error"; readonly message: string };
