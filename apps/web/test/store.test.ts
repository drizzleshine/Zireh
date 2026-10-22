import "fake-indexeddb/auto";
import { clear, set } from "idb-keyval";
import { generateCaseKey } from "@zireh/crypto";
import { newCase, newEvidence, newMember } from "@zireh/cases";
import { sealRecord } from "@zireh/sync";
import { beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({ push: vi.fn(), pull: vi.fn() }));
vi.mock("../src/api.ts", () => ({ api: remote }));
beforeEach(async () => { await clear(); vi.resetModules(); remote.push.mockReset(); remote.pull.mockReset(); });

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
