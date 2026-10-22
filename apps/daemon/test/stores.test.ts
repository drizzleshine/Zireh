import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openMoneyStore } from "../src/stores.ts";

const proof = { amount: 1, keysetId: "key", secret: "s", C: "signature" };
describe("F09 durable money journal", () => {
  it("commits coins and recovery together, rolls back failures, and imports legacy files once", () => {
    const dir = mkdtempSync(join(tmpdir(), "zireh-money-"));
    try {
      writeFileSync(join(dir, "coins.json"), JSON.stringify([proof]));
      writeFileSync(join(dir, "pending.json"), "[]");
      const store = openMoneyStore(dir);
      expect(store.load()).toEqual([proof]);
      expect(() => store.atomically(() => { store.save([]); store.put("call:test", { id: "test" }); throw new Error("crash"); })).toThrow("crash");
      const reopened = openMoneyStore(dir);
      expect(reopened.load()).toEqual([proof]);
      expect(reopened.list("call:")).toEqual([]);
      store.atomically(() => { store.save([]); store.put("call:test", { id: "test" }); });
      const committed = openMoneyStore(dir);
      expect(committed.load()).toEqual([]);
      expect(committed.list("call:")).toEqual([{ id: "test" }]);
      expect(statSync(join(dir, "money.db")).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
