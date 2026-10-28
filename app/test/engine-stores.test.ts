import { describe, expect, it } from "vitest";
import type { Proof } from "@zireh/schema";
import { browserMoneyStore, memoryStorage } from "../src/engine/stores.ts";

const coin = (n: number): Proof => ({ amount: 1, secret: `s${n}`, C: "02".padEnd(66, "0"), keysetId: "zr00000000000000" });

describe("browser money store", () => {
  it("writes a transaction in one piece, and only when the outermost one commits", () => {
    const storage = memoryStorage();
    const writes: string[] = [];
    const watched = { getItem: storage.getItem, setItem: (k: string, v: string) => { writes.push(v); storage.setItem(k, v); } };
    const store = browserMoneyStore(watched);
    store.atomically(() => {
      store.save([coin(1)]);
      store.atomically(() => store.put("call:a", { requestId: "a" }));
      expect(writes).toHaveLength(0);
    });
    expect(writes).toHaveLength(1);
    expect(browserMoneyStore(storage).load()).toEqual([coin(1)]);
    expect(browserMoneyStore(storage).list("call:")).toEqual([{ requestId: "a" }]);
  });

  it("keeps the old coins when a transaction fails", () => {
    const storage = memoryStorage();
    const store = browserMoneyStore(storage);
    store.save([coin(1)]);
    expect(() => store.atomically(() => { store.save([]); throw new Error("relay said no"); })).toThrow("relay said no");
    expect(store.load()).toEqual([coin(1)]);
    expect(browserMoneyStore(storage).load()).toEqual([coin(1)]);
  });

  it("re-reads what another tab saved when it takes over the wallet", () => {
    const storage = memoryStorage();
    const mine = browserMoneyStore(storage);
    browserMoneyStore(storage).save([coin(2)]);
    expect(mine.load()).toEqual([]);
    mine.reload();
    expect(mine.load()).toEqual([coin(2)]);
  });
});
