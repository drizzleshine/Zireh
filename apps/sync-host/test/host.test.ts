import { caseToken, newCase, newMember } from "@zireh/cases";
import { generateCaseKey } from "@zireh/crypto";
import { openRecord, sealRecord, SyncClient } from "@zireh/sync";
import { describe, expect, it } from "vitest";
import { createSyncHost, openHostDb } from "../src/host.ts";

function client() {
  const host = createSyncHost(openHostDb(":memory:"));
  return new SyncClient("http://sync.test", (url, init) => host(new Request(url, init)));
}

describe("sync host", () => {
  it("stores and returns sealed records for members holding the token", async () => {
    const sync = client();
    const key = generateCaseKey();
    const token = caseToken(key);
    const ada = newMember("Ada");
    const c = newCase({ title: "T", question: "Q?", privacy: "private", createdBy: ada.id });

    await sync.push(c.id, token, [await sealRecord(key, "cases", c), await sealRecord(key, "members", ada)]);
    const pulled = await sync.pull(c.id, token, 0);
    expect(pulled.records).toHaveLength(2);
    expect(pulled.cursor).toBe(2);
    expect(pulled.head).toBe(2);
    const opened = await Promise.all(pulled.records.map((r) => openRecord(key, r)));
    expect(opened.map((o) => o?.collection)).toEqual(["cases", "members"]);

    expect((await sync.pull(c.id, token, pulled.cursor)).records).toEqual([]);
  });

  it("rejects a wrong token and unknown cases", async () => {
    const sync = client();
    const key = generateCaseKey();
    const ada = newMember("Ada");
    const c = newCase({ title: "T", question: "Q?", privacy: "private", createdBy: ada.id });
    await sync.push(c.id, caseToken(key), [await sealRecord(key, "members", ada)]);
    await expect(sync.pull(c.id, caseToken(generateCaseKey()), 0)).rejects.toMatchObject({ status: 403 });
    await expect(sync.push(c.id, caseToken(generateCaseKey()), [await sealRecord(key, "members", ada)])).rejects.toMatchObject({ status: 403 });
    await expect(sync.pull("b".repeat(32), caseToken(key), 0)).rejects.toMatchObject({ status: 404 });
  });
});

describe("F11 exact envelope retries", () => {
  it("does not append a duplicate when a push is retried after its reply was lost", async () => {
    const sync = client();
    const key = generateCaseKey();
    const ada = newMember("Ada");
    const c = newCase({ title: "T", question: "Q?", privacy: "private", createdBy: ada.id });
    const envelope = await sealRecord(key, "cases", c);
    expect(await sync.push(c.id, caseToken(key), [envelope])).toEqual({ cursor: 1 });
    expect(await sync.push(c.id, caseToken(key), [envelope])).toEqual({ cursor: 1 });
    expect((await sync.pull(c.id, caseToken(key), 0)).records).toHaveLength(1);
  });
});
