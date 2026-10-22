import type { Proof } from "@zireh/schema";

/** One synchronous transaction owns both coins and recovery journal entries. */
export interface MoneyStore {
  load(): Proof[];
  save(proofs: readonly Proof[]): void;
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  remove(key: string): void;
  list<T>(prefix: string): T[];
  atomically<T>(work: () => T): T;
}

export function memoryMoneyStore(initial: readonly Proof[] = []): MoneyStore {
  let values = new Map<string, unknown>([["proofs", [...initial]]]);
  const store: MoneyStore = {
    load: () => store.get<Proof[]>("proofs") ?? [],
    save: (proofs) => store.put("proofs", proofs),
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: (key, value) => { values.set(key, structuredClone(value)); },
    remove: (key) => { values.delete(key); },
    list: <T>(prefix: string) => [...values].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value) as T),
    atomically(work) {
      const before = structuredClone(values);
      try { return work(); }
      catch (error) { values = before; throw error; }
    },
  };
  return store;
}
