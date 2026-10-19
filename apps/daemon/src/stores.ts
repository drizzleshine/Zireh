import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingCall, PendingStore } from "@zireh/inference";
import type { LedgerStore } from "@zireh/ledger";
import type { Proof, Receipt, Run } from "@zireh/schema";
import type { ProofStore } from "@zireh/wallet";

/** Owner-only files under the daemon's data dir. Writes are atomic (write temp, then rename). */
function writeAtomic(file: string, data: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

export function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Coins are bearer money: losing this file loses the balance. */
export function fileProofStore(dir: string): ProofStore {
  const file = join(dir, "coins.json");
  return {
    load: () => readJson<Proof[]>(file, []),
    save: (proofs) => writeAtomic(file, JSON.stringify(proofs)),
  };
}

export function filePendingStore(dir: string): PendingStore {
  const file = join(dir, "pending.json");
  const all = () => readJson<PendingCall[]>(file, []);
  return {
    save: (call) => writeAtomic(file, JSON.stringify([...all().filter((c) => c.requestId !== call.requestId), call])),
    remove: (id) => writeAtomic(file, JSON.stringify(all().filter((c) => c.requestId !== id))),
    list: all,
  };
}

/** Receipts are append-only JSON lines; runs are a small snapshot file. */
export function fileLedgerStore(dir: string): LedgerStore {
  const receiptsFile = join(dir, "receipts.jsonl");
  const runsFile = join(dir, "runs.json");
  return {
    appendReceipt: (r) => appendFileSync(receiptsFile, `${JSON.stringify(r)}\n`, { mode: 0o600 }),
    receipts: () =>
      existsSync(receiptsFile)
        ? readFileSync(receiptsFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Receipt)
        : [],
    putRun: (run) => {
      const runs = readJson<Run[]>(runsFile, []).filter((r) => r.id !== run.id);
      // Keep the snapshot small: settled/failed runs older than the last 200 are dropped.
      writeAtomic(runsFile, JSON.stringify([...runs, run].slice(-200)));
    },
    runs: () => readJson<Run[]>(runsFile, []),
  };
}
