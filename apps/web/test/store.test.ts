import "fake-indexeddb/auto";
import { clear, set } from "idb-keyval";
import { generateCaseKey } from "@zireh/crypto";
import { newCase, newEvidence, newMember } from "@zireh/cases";
import { sealRecord } from "@zireh/sync";
import { beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({ push: vi.fn(), pull: vi.fn() }));
vi.mock("../src/api.ts", () => ({ api: remote }));
beforeEach(async () => { await clear(); vi.resetModules(); await (await import("../src/persistence.ts")).database.clear(); remote.push.mockReset(); remote.pull.mockReset(); });

describe("F14 immutable case snapshots", () => {
  it("gives selectors a new case and collection after applying a pulled record", async () => {
    const member = newMember("Ada");
    const c = newCase({ title: "case", question: "question", privacy: "private", createdBy: member.id });
    const key = generateCaseKey();
    await set("workspaces", [{ caseId: c.id, caseKey: key, memberId: member.id, cursor: 0, outbox: [] }]);
    await set(`case:${c.id}`, { case: c, members: [member], evidence: [] });
    const store = await import("../src/store.ts");
    await store.load();
    const before = store.getSnapshot().cases[c.id]!;
    const evidence = newEvidence(c.id, member.id, { title: "new source", kind: "note", body: "source content" });
    remote.pull.mockResolvedValue({ records: [{ ...await sealRecord(key, "evidence", evidence), seq: 1 }], cursor: 1, head: 1 });
    await store.syncCase(c.id);
    const after = store.getSnapshot().cases[c.id]!;
    expect(after).not.toBe(before);
    expect(after.evidence).not.toBe(before.evidence);
    expect(before.evidence).toEqual([]);
    expect(after.evidence).toEqual([evidence]);
  });
});

describe("F10 independent offline tabs", () => {
  it("preserves both records and outbox entries when two stale tabs save different evidence", async () => {
    const member = newMember("Ada");
    const c = newCase({ title: "case", question: "question", privacy: "private", createdBy: member.id });
    await set("workspaces", [{ caseId: c.id, caseKey: generateCaseKey(), memberId: member.id, cursor: 0, outbox: [] }]);
    await set(`case:${c.id}`, { case: c, members: [member], evidence: [] });
    remote.push.mockRejectedValue(new Error("offline"));
    remote.pull.mockRejectedValue(new Error("offline"));
    const first = await import("../src/store.ts");
    await first.load();
    vi.resetModules();
    const second = await import("../src/store.ts");
    await second.load();
    const a = newEvidence(c.id, member.id, { kind: "note", title: "first tab", body: "a" });
    const b = newEvidence(c.id, member.id, { kind: "note", title: "second tab", body: "b" });
    await Promise.all([first.save(c.id, "evidence", a), second.save(c.id, "evidence", b)]);
    await Promise.all([first.syncCase(c.id), second.syncCase(c.id)]);
    await first.load();
    expect(first.getSnapshot().cases[c.id]!.evidence.map((item) => item.id).sort()).toEqual([a.id, b.id].sort());
    expect(first.getSnapshot().workspaces[0]!.outbox.map((item) => item.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("F10 atomic record and outbox writes", () => {
  it("rolls back the record if the envelope cannot be stored", async () => {
    const member = newMember("Ada");
    const c = newCase({ title: "case", question: "question", privacy: "private", createdBy: member.id });
    const evidence = newEvidence(c.id, member.id, { kind: "note", title: "source", body: "body" });
    const envelope = await sealRecord(generateCaseKey(), "evidence", evidence);
    const uncloneable = { ...envelope, invalid: () => {} };
    const { database } = await import("../src/persistence.ts");
    await expect(database.save({ caseId: c.id, collection: "evidence", record: evidence }, uncloneable)).rejects.toThrow();
    expect(await database.entries()).toEqual([]);
  });
});

describe("F15 byte-bounded synchronization", () => {
  it("pushes two large documents in separate successful requests", async () => {
    const member = newMember("Ada");
    const c = newCase({ title: "case", question: "question", privacy: "private", createdBy: member.id });
    const key = generateCaseKey();
    const documents = ["a", "b"].map((body) => newEvidence(c.id, member.id, { kind: "document", title: body, body: body.repeat(1_600_000) }));
    const outbox = await Promise.all(documents.map((record) => sealRecord(key, "evidence", record)));
    await set("workspaces", [{ caseId: c.id, caseKey: key, memberId: member.id, cursor: 0, outbox }]);
    await set(`case:${c.id}`, { case: c, members: [member], evidence: documents });
    const sizes: number[] = [];
    remote.push.mockImplementation(async (_case, _token, records) => {
      const size = new TextEncoder().encode(JSON.stringify({ records })).byteLength;
      sizes.push(size);
      if (size > 4 * 1024 * 1024) throw Object.assign(new Error("too large"), { status: 413 });
      return { cursor: 2 };
    });
    remote.pull.mockResolvedValue({ records: [], cursor: 2, head: 2 });
    const store = await import("../src/store.ts");
    await store.load();
    await store.syncCase(c.id);
    expect(store.getSnapshot().workspaces[0]!.outbox).toHaveLength(0);
    expect(sizes).toHaveLength(2);
    expect(sizes.every((size) => size < 3.5 * 1024 * 1024)).toBe(true);
  });
});

describe("F15 adaptive rejection recovery", () => {
  it("splits a rejected batch and acknowledges only its successful pieces", async () => {
    const member = newMember("Ada");
    const c = newCase({ title: "case", question: "question", privacy: "private", createdBy: member.id });
    const key = generateCaseKey();
    const documents = ["a", "b"].map((body) => newEvidence(c.id, member.id, { kind: "note", title: body, body }));
    const outbox = await Promise.all(documents.map((record) => sealRecord(key, "evidence", record)));
    await set("workspaces", [{ caseId: c.id, caseKey: key, memberId: member.id, cursor: 0, outbox }]);
    await set(`case:${c.id}`, { case: c, members: [member], evidence: documents });
    remote.push.mockImplementation(async (_case, _token, records) => {
      if (records.length > 1) throw Object.assign(new Error("too large"), { status: 413 });
      return { cursor: 2 };
    });
    remote.pull.mockResolvedValue({ records: [], cursor: 2, head: 2 });
    const store = await import("../src/store.ts");
    await store.load();
    await store.syncCase(c.id);
    expect(remote.push).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().workspaces[0]!.outbox).toHaveLength(0);
  });
});
