import { createStore, get, set } from "idb-keyval";
import type { Proof, Receipt, Run } from "@zireh/schema";
import type { LedgerStore, MoneyStore } from "@zireh/wallet";

/** Where `localStorage` lives; tests pass a stand-in. */
export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function memoryStorage(): SyncStorage {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

const MONEY_KEY = "zireh:money:v1";

/**
 * Coins and the journal of unfinished paid calls. The wallet's rules need synchronous
 * transactions, so everything lives in memory and the whole store is written in one
 * `setItem` when the outermost transaction commits: a crash leaves either the old state or the
 * new one, never half. Small enough for this (coins and a few pending calls, not answers).
 */
export function browserMoneyStore(storage: SyncStorage = localStorage): MoneyStore & { reload(): void } {
  let values = new Map<string, unknown>();
  let depth = 0;
  const read = () => {
    const raw = storage.getItem(MONEY_KEY);
    values = new Map(raw ? (Object.entries(JSON.parse(raw)) as [string, unknown][]) : []);
  };
  const persist = () => {
    if (depth === 0) storage.setItem(MONEY_KEY, JSON.stringify(Object.fromEntries(values)));
  };
  read();
  const store: MoneyStore & { reload(): void } = {
    reload: read,
    load: () => store.get<Proof[]>("proofs") ?? [],
    save: (proofs: readonly Proof[]) => store.put("proofs", proofs),
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); persist(); },
    remove: (key: string) => { values.delete(key); persist(); },
    list: <T>(prefix: string) => [...values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => structuredClone(value) as T),
    atomically<T>(work: () => T): T {
      const before = structuredClone(values);
      depth++;
      try {
        const result = work();
        if (result && typeof result === "object" && "then" in result) throw new Error("money transactions must be synchronous");
        depth--;
        persist();
        return result;
      } catch (error) {
        depth--;
        values = before;
        throw error;
      }
    },
  };
  return store;
}

/**
 * The privacy log: every receipt and research run, kept in IndexedDB (it holds the text of what
 * was sent, so it can grow past what localStorage allows). Loaded once; writes go out in order
 * in the background. Losing the last write to a crash loses a log line, never money.
 */
export async function browserLedgerStore(): Promise<LedgerStore> {
  const db = createStore("zireh-ledger", "log");
  const receipts = new Map<string, Receipt>(((await get<Receipt[]>("receipts", db)) ?? []).map((r) => [r.id, r]));
  let runs = (await get<Run[]>("runs", db)) ?? [];
  let writing = Promise.resolve();
  const flush = (key: "receipts" | "runs") => {
    writing = writing.then(() => set(key, key === "receipts" ? [...receipts.values()] : runs, db)).catch((err: unknown) => console.error("privacy log not saved", err));
  };
  return {
    appendReceipt: (r) => { receipts.set(r.id, r); flush("receipts"); },
    receipts: () => [...receipts.values()],
    putRun: (run) => {
      // Keep the snapshot small: only the last 200 runs.
      runs = [...runs.filter((r) => r.id !== run.id), run].slice(-200);
      flush("runs");
    },
    runs: () => runs,
  };
}
