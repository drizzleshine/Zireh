import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { database, Keys } from "../src/persistence.ts";

describe("storage layout", () => {
  it("removes every key for one case and nothing for another whose id shares a prefix", async () => {
    await database.clear();
    const fill = (id: string) =>
      database.write((s) => {
        s.put({ caseId: id }, Keys.workspace(id));
        s.put({ id: "r" }, Keys.record(id, "evidence", "r"));
        s.put(1, Keys.clock(Keys.record(id, "evidence", "r")));
        s.put({ id: "h" }, Keys.history(id, "h"));
        s.put({ x: "draft" }, Keys.drafts(id));
        s.put({ "Source A": "real name" }, Keys.vault(id));
      });
    await fill("abc");
    await fill("abcd");
    await database.purgeCase("abc");
    const left = (await database.entries()).map(([key]) => key);
    expect(left.some((key) => key.includes(":abc:") || key.endsWith(":abc"))).toBe(false);
    expect(left.filter((key) => key.includes("abcd"))).toHaveLength(6);
    expect(await database.range(Keys.records("abcd"))).toEqual([{ id: "r" }]);
  });
});
