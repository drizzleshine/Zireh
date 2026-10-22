import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingCall } from "@zireh/inference";
import type { LedgerStore } from "@zireh/ledger";
import type { Proof, Receipt, Run } from "@zireh/schema";
import type { MoneyStore } from "@zireh/wallet";
import { DatabaseSync } from "node:sqlite";

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

/** Coins and their recovery journal share a transaction and survive process restarts. */
export function openMoneyStore(dir: string): MoneyStore {
  ensureDir(dir);
  const file = join(dir, "money.db");
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS money (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const get = db.prepare("SELECT value FROM money WHERE key = ?");
  const put = db.prepare("INSERT OR REPLACE INTO money (key, value) VALUES (?, ?)");
  const remove = db.prepare("DELETE FROM money WHERE key = ?");
  const list = db.prepare("SELECT value FROM money WHERE substr(key, 1, ?) = ? ORDER BY key");
  let serial = 0;
  const store: MoneyStore = {
    load: () => store.get<Proof[]>("proofs") ?? [],
    save: (proofs) => store.put("proofs", proofs),
    get: <T>(key: string) => {
      const row = get.get(key) as { value: string } | undefined;
      return row ? JSON.parse(row.value) as T : undefined;
    },
    put: (key, value) => { put.run(key, JSON.stringify(value)); },
    remove: (key) => { remove.run(key); },
    list: <T>(prefix: string) => (list.all(prefix.length, prefix) as { value: string }[]).map((row) => JSON.parse(row.value) as T),
    atomically(work) {
      const name = `money_${++serial}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = work();
        if (result && typeof result === "object" && "then" in result) throw new Error("money transactions must be synchronous");
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      }
    },
  };
  store.atomically(() => {
    if (store.get("legacy-imported")) return;
    const pending = readJson<PendingCall[]>(join(dir, "pending.json"), []);
    const reserved = new Set(pending.flatMap((call) => call.proofs.map((proof) => proof.secret)));
    store.save(readJson<Proof[]>(join(dir, "coins.json"), []).filter((proof) => !reserved.has(proof.secret)));
    for (const call of pending) store.put(`call:${call.requestId}`, call);
    store.put("legacy-imported", true);
  });
  return store;
}

/** Receipts are append-only JSON lines; runs are a small snapshot file. */
export function fileLedgerStore(dir: string): LedgerStore {
  const receiptsFile = join(dir, "receipts.jsonl");
  const runsFile = join(dir, "runs.json");
  return {
    appendReceipt: (r) => appendFileSync(receiptsFile, `${JSON.stringify(r)}\n`, { mode: 0o600, flush: true }),
    receipts: () =>
      existsSync(receiptsFile)
        ? [...new Map(readFileSync(receiptsFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => { const receipt = JSON.parse(line) as Receipt; return [receipt.id, receipt] as const; })).values()]
        : [],
    putRun: (run) => {
      const runs = readJson<Run[]>(runsFile, []).filter((r) => r.id !== run.id);
      // Keep the snapshot small: settled/failed runs older than the last 200 are dropped.
      writeAtomic(runsFile, JSON.stringify([...runs, run].slice(-200)));
    },
    runs: () => readJson<Run[]>(runsFile, []),
  };
}
