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

describe("F09 atomic relay spend marker", () => {
  it("rolls back spent secrets when writing the crash marker fails", () => {
    const db = openRelayDb(tempDir());
    const spent = sqliteSpentStore(db);
    const responses = sqliteResponseStore(db);
    db.exec("CREATE TRIGGER fail_marker BEFORE INSERT ON responses BEGIN SELECT RAISE(ABORT, 'injected marker failure'); END");
    expect(() => spent.markSpent(["atomic-coin"], () => responses.put("r", { status: 0, body: { redeemed: 1 } }))).toThrow("injected marker failure");
    expect(responses.get("r")).toBeUndefined();
    db.exec("DROP TRIGGER fail_marker");
    expect(spent.markSpent(["atomic-coin"])).toBe(true);
  });
});

describe("F07 financial retention", () => {
  it("retains settlement signatures and crash markers across expiry and reopening", async () => {
    const dir = tempDir();
    const store = sqliteResponseStore(openRelayDb(dir), 1);
    const settlement = { requestId: "financial", charged: 5, usage: { prompt_tokens: 0, completion_tokens: 0 }, change: [] };
    store.put("financial", { status: 200, body: { model: "m", content: "private answer", settlement } });
    store.put("marker", { status: 0, body: { redeemed: 100 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reopened = sqliteResponseStore(openRelayDb(dir), 1);
    expect(reopened.get("financial")).toMatchObject({ body: { content: "", answerExpired: true, settlement } });
    expect(reopened.get("marker")).toEqual({ status: 0, body: { redeemed: 100 } });
    reopened.acknowledge("financial");
    expect(reopened.get("financial")).toMatchObject({ body: { settlement } });
  });
});
