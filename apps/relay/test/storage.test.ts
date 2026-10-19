import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateMintKeys, openRelayDb, sqliteResponseStore, sqliteSpentStore } from "../src/storage.ts";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "zireh-relay-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("relay storage", () => {
  it("spent store is all-or-nothing and survives reopening", () => {
    const dir = tempDir();
    const spent = sqliteSpentStore(openRelayDb(dir));
    expect(spent.markSpent(["a", "b"])).toBe(true);
    expect(spent.markSpent(["c", "a"])).toBe(false);
    expect(spent.markSpent(["c"])).toBe(true); // c was not burned by the failed attempt
    expect(sqliteSpentStore(openRelayDb(dir)).markSpent(["b"])).toBe(false);
    expect(spent.markSpent(["d", "d"])).toBe(false);
  });

  it("mint keys persist with owner-only permissions", () => {
    const dir = tempDir();
    const keys = loadOrCreateMintKeys(dir);
    expect(loadOrCreateMintKeys(dir).id).toBe(keys.id);
    expect(statSync(join(dir, "mint-keys.json")).mode & 0o777).toBe(0o600);
  });

  it("response store expires entries", async () => {
    const store = sqliteResponseStore(openRelayDb(tempDir()), 30);
    store.put("r1", { status: 200, body: { ok: true } });
    expect(store.get("r1")).toEqual({ status: 200, body: { ok: true } });
    await new Promise((r) => setTimeout(r, 50));
    expect(store.get("r1")).toBeUndefined();
  });
});
