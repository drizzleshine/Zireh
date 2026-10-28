import { canonicalJson, randomId, sha256Hex } from "@zireh/crypto";
import type { ChatMessage, Receipt, Run, RunState } from "@zireh/schema";

/** Where the ledger keeps its rows. The daemon persists to disk; tests use memory. */
export interface LedgerStore {
  appendReceipt(receipt: Receipt): void;
  receipts(): Receipt[];
  putRun(run: Run): void;
  runs(): Run[];
}

export function memoryLedgerStore(): LedgerStore {
  const receipts = new Map<string, Receipt>();
  const runs = new Map<string, Run>();
  return {
    appendReceipt: (r) => void receipts.set(r.id, r),
    receipts: () => [...receipts.values()],
    putRun: (r) => void runs.set(r.id, r),
    runs: () => [...runs.values()],
  };
}

/** Legal run transitions (architecture §6.1). Anything else is a bug and throws. */
const NEXT: Readonly<Record<RunState, readonly RunState[]>> = {
  prepared: ["submitted", "failed"],
  submitted: ["streaming", "settled", "submission-unknown", "failed"],
  streaming: ["settled", "refund-pending", "failed"],
  "refund-pending": ["settled", "failed"],
  "submission-unknown": ["settled", "prepared", "failed"],
  settled: [],
  failed: [],
};

export interface Summary {
  readonly calls: number;
  readonly real: number;
  readonly decoys: number;
  readonly spent: number;
  readonly overcharges: number;
}

/** The privacy log: every payload that left the device, hashed, with its cost. */
export class Ledger {
  constructor(private readonly store: LedgerStore = memoryLedgerStore()) {}

  startRun(id: string, pieceId: string, maxCost: number): Run {
    const run: Run = { id, pieceId, state: "prepared", maxCost, updatedAt: new Date().toISOString() };
    this.store.putRun(run);
    return run;
  }

  advance(id: string, state: RunState, patch: Partial<Pick<Run, "charged" | "usage" | "error">> = {}): Run {
    const run = this.store.runs().find((r) => r.id === id);
    if (!run) throw new Error(`unknown run ${id}`);
    if (!NEXT[run.state].includes(state)) throw new Error(`illegal run transition ${run.state} → ${state}`);
    const next: Run = { ...run, ...patch, state, updatedAt: new Date().toISOString() };
    this.store.putRun(next);
    return next;
  }

  /** Record exactly what was sent. The preview is the redacted text as it appeared on the wire. */
  record(entry: {
    requestId?: string;
    state?: Receipt["state"];
    preview?: string;
    destination: Receipt["destination"];
    role: Receipt["role"];
    caseId?: string;
    runId?: string;
    payload: readonly ChatMessage[] | string;
    circuit?: string;
    charged?: number;
    expectedCharge?: number;
    overcharged?: boolean;
  }): Receipt {
    const wire = typeof entry.payload === "string" ? entry.payload : canonicalJson(entry.payload);
    const preview = entry.preview ?? (typeof entry.payload === "string" ? entry.payload : entry.payload.map((m) => m.content).at(-1) ?? "");
    const receipt: Receipt = {
      id: entry.requestId ?? randomId(),
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      state: entry.state ?? "settled",
      payloadWire: wire,
      at: new Date().toISOString(),
      destination: entry.destination,
      role: entry.role,
      ...(entry.caseId ? { caseId: entry.caseId } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}),
      payloadSha256: sha256Hex(wire),
      payloadPreview: preview,
      ...(entry.circuit ? { circuit: entry.circuit } : {}),
      ...(entry.charged !== undefined ? { charged: entry.charged } : {}),
      ...(entry.expectedCharge !== undefined ? { expectedCharge: entry.expectedCharge } : {}),
      ...(entry.overcharged !== undefined ? { overcharged: entry.overcharged } : {}),
    };
    this.store.appendReceipt(receipt);
    return receipt;
  }

  updateReceipt(id: string, patch: Partial<Pick<Receipt, "state" | "error" | "circuit" | "charged" | "expectedCharge" | "overcharged">>): void {
    const current = this.store.receipts().find((receipt) => receipt.id === id);
    if (!current) throw new Error(`unknown receipt ${id}`);
    this.store.appendReceipt({ ...current, ...patch });
  }

  receipts(): Receipt[] {
    return this.store.receipts().sort((a, b) => b.at.localeCompare(a.at));
  }

  summary(caseId?: string): Summary {
    const rs = this.store.receipts().filter((r) => r.destination !== "local" && (!caseId || r.caseId === caseId));
    return {
      calls: rs.length,
      real: rs.filter((r) => r.role === "real").length,
      decoys: rs.filter((r) => r.role === "decoy").length,
      spent: rs.reduce((n, r) => n + (r.charged ?? 0), 0),
      overcharges: rs.filter((r) => r.overcharged).length,
    };
  }
}

