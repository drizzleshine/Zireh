import type { Usage } from "./chat.ts";

/** Local-only bookkeeping: outbound calls and the privacy log. Never synced. */

export type RunState =
  | "prepared"
  | "submitted"
  | "streaming"
  | "settled"
  | "refund-pending"
  | "submission-unknown"
  | "failed";

export interface Run {
  readonly id: string; // also the relay idempotency key (requestId)
  readonly pieceId: string;
  readonly state: RunState;
  readonly maxCost: number;
  readonly charged?: number;
  readonly usage?: Usage;
  readonly error?: string;
  readonly updatedAt: string;
}

/** One line of the privacy log: exactly what left the device, and what it cost. */
export interface Receipt {
  readonly id: string;
  readonly at: string;
  readonly destination: "relay" | "search" | "local";
  readonly caseId?: string; // local bookkeeping only; never sent anywhere
  readonly role: "real" | "decoy";
  readonly payloadSha256: string;
  readonly payloadPreview: string; // redacted text as sent
  readonly circuit?: string; // Tor isolation tag
  readonly charged?: number;
  readonly expectedCharge?: number; // client-side token count × price
  readonly overcharged?: boolean;
}
