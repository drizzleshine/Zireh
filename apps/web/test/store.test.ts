import "fake-indexeddb/auto";
import { clear, set } from "idb-keyval";
import { generateCaseKey, generateMemberKeys } from "@zireh/crypto";
import { newCase, newEvidence, newMember, newObservation } from "@zireh/cases";
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

describe("F11 authenticated record revisions", () => {
  it("keeps an accepted observation when the host replays its older draft", async () => {
    const member = newMember("Ada");
    const c = newCase({ title: "case", question: "question", privacy: "private", createdBy: member.id });
    const key = generateCaseKey();
    const draft = newObservation(c.id, { kind: "ai", runId: "a".repeat(32), requestedBy: member.id }, { text: "claim", evidenceIds: [] });
    const accepted = { ...draft, status: "accepted" as const };
    const old = await sealRecord(key, "observations", draft, { lamport: 1, deviceId: member.id });
    const latest = await sealRecord(key, "observations", accepted, { lamport: 2, deviceId: member.id });
    await set("workspaces", [{ caseId: c.id, caseKey: key, memberId: member.id, cursor: 0, outbox: [] }]);
    await set(`case:${c.id}`, { case: c, members: [member], observations: [] });
    const store = await import("../src/store.ts");
    await store.load();
    remote.pull.mockResolvedValueOnce({ records: [{ ...old, seq: 1 }, { ...latest, seq: 2 }], cursor: 2, head: 2 });
    await store.syncCase(c.id);
    expect(store.getSnapshot().cases[c.id]!.observations[0]!.status).toBe("accepted");
    await store.load();
    remote.pull.mockResolvedValueOnce({ records: [{ ...old, seq: 3 }], cursor: 3, head: 3 });
    await store.syncCase(c.id);
    expect(store.getSnapshot().cases[c.id]!.observations[0]!.status).toBe("accepted");
    expect(store.getSnapshot().workspaces[0]!.replayWarnings).toBe(1);
    remote.pull.mockResolvedValueOnce({ records: [{ ...latest, seq: 4 }], cursor: 4, head: 4 });
    await store.syncCase(c.id);
    expect(store.getSnapshot().workspaces[0]!.replayWarnings).toBe(2);
  });
});

describe("encrypted case backup restore", () => {
  it("restores the workspace key, evidence, revisions and unsent envelopes without duplicating records", async () => {
    remote.push.mockRejectedValue(new Error("offline"));
    remote.pull.mockRejectedValue(new Error("offline"));
    const store = await import("../src/store.ts");
    await store.load();
    const id = await store.createCase({ title: "confidential case", question: "private question", privacy: "private", memberName: "Ada" });
    const evidence = newEvidence(id, store.myMemberId(id), { title: "source", kind: "note", body: "confidential source" });
    await store.save(id, "evidence", evidence);
    await store.syncCase(id);
    const key = store.getSnapshot().workspaces[0]!.caseKey;
    const backup = await store.backupCase(id, "a long unique backup passphrase");
    expect(backup).not.toContain(key);
    expect(backup).not.toContain("confidential source");
    const { database } = await import("../src/persistence.ts");
    await database.clear();
    await store.load();
    expect(store.getSnapshot().workspaces).toHaveLength(0);
    expect(await store.restoreCase(backup, "a long unique backup passphrase")).toBe(id);
    await store.syncCase(id);
    expect(store.getSnapshot().workspaces[0]!.caseKey).toBe(key);
    expect(store.getSnapshot().cases[id]!.evidence).toEqual([evidence]);
    expect(store.getSnapshot().workspaces[0]!.outbox).toHaveLength(3);
    await store.restoreCase(backup, "a long unique backup passphrase");
    await store.syncCase(id);
    expect(store.getSnapshot().cases[id]!.evidence).toHaveLength(1);
    expect(store.getSnapshot().workspaces[0]!.outbox).toHaveLength(3);
  });
});

describe("member removal and case-key rotation", () => {
  it("re-seals every record in a fresh namespace and lets only a retained member update access", async () => {
    const hosts = new Map<string, { token: string; records: import("@zireh/sync").StoredEnvelope[] }>();
    remote.push.mockImplementation(async (id, token, records) => {
      let host = hosts.get(id);
      if (!host) { host = { token, records: [] }; hosts.set(id, host); }
      if (host.token !== token) throw new Error("wrong token");
      for (const record of records) if (!host.records.some((saved) => saved.sealed.ct === record.sealed.ct)) host.records.push({ ...record, seq: host.records.length + 1 });
      return { cursor: host.records.length };
    });
    remote.pull.mockImplementation(async (id, token, after) => {
      const host = hosts.get(id);
      if (!host || host.token !== token) throw new Error("unknown namespace or token");
      return { records: host.records.filter((record) => record.seq > after), cursor: host.records.length, head: host.records.length };
    });
    const store = await import("../src/store.ts");
    await store.load();
    const id = await store.createCase({ title: "rotation", question: "question", privacy: "private", memberName: "Owner" });
    const removedKeys = await generateMemberKeys(), retainedKeys = await generateMemberKeys();
    const removed = { ...newMember("Bo"), id: removedKeys.memberId, signingKey: removedKeys.publicKey };
    const retained = { ...newMember("Cy"), id: retainedKeys.memberId, signingKey: retainedKeys.publicKey };
    await store.saveAs(id, "members", removed, removedKeys);
    await store.saveAs(id, "members", retained, retainedKeys);
    const evidence = newEvidence(id, store.myMemberId(id), { kind: "note", title: "source", body: "private source" });
    await store.save(id, "evidence", evidence);
    await store.syncCase(id);
    const before = structuredClone(store.getSnapshot().cases[id]!);
    const old = structuredClone(store.getSnapshot().workspaces[0]!);
    await store.removeMember(id, removed.id);
    const current = store.getSnapshot().workspaces[0]!;
    expect(current.caseKey).not.toBe(old.caseKey);
    expect(current.syncId).not.toBe(id);
    expect(store.getSnapshot().cases[id]!.members.find((member) => member.id === removed.id)?.removedAt).toBeDefined();
    const { openRecord } = await import("@zireh/sync");
    const sealed = hosts.get(current.syncId!)!.records.find((record) => record.id === evidence.id)!;
    expect(await openRecord(old.caseKey, sealed)).toBeUndefined();
    expect(await openRecord(current.caseKey, sealed)).toMatchObject({ record: evidence });
    const invite = { caseId: id, caseKey: current.caseKey, syncId: current.syncId!, keyEpoch: current.keyEpoch! };
    const { database } = await import("../src/persistence.ts");
    await database.clear();
    await set("workspaces", [{ ...old, memberId: retained.id, memberKeys: retainedKeys }]);
    await set(`case:${id}`, before);
    await store.load();
    await store.joinCase(invite, "Cy");
    await store.syncCase(id);
    expect(store.getSnapshot().workspaces[0]!.caseKey).toBe(invite.caseKey);
    expect(store.getSnapshot().cases[id]!.evidence).toEqual([evidence]);
    await database.clear();
    await set("workspaces", [{ ...old, memberId: removed.id, memberKeys: removedKeys }]);
    await store.load();
    await expect(store.joinCase(invite, "Bo")).rejects.toThrow("does not retain your membership");
    expect(store.getSnapshot().workspaces[0]!.caseKey).toBe(old.caseKey);
  });
});

describe("signed identity enforcement in legacy cases", () => {
  it("rejects an unsigned review claiming a member whose signing key is already known", async () => {
    const keys = await generateMemberKeys();
    const member = { ...newMember("Ada"), id: keys.memberId, signingKey: keys.publicKey };
    const c = newCase({ title: "legacy", question: "question", privacy: "private", createdBy: member.id });
    const key = generateCaseKey();
    await set("workspaces", [{ caseId: c.id, caseKey: key, memberId: member.id, cursor: 0, outbox: [] }]);
    await set(`case:${c.id}`, { case: c, members: [member], reviews: [] });
    const forged = { id: "f".repeat(32), caseId: c.id, findingId: "e".repeat(32), memberId: member.id, decision: "support" as const, reason: "forged", createdAt: new Date().toISOString() };
    const envelope = await sealRecord(key, "reviews", forged);
    remote.pull.mockResolvedValue({ records: [{ ...envelope, seq: 1 }], cursor: 1, head: 1 });
    const store = await import("../src/store.ts");
    await store.load();
    await store.syncCase(c.id);
    expect(store.getSnapshot().cases[c.id]!.reviews).toHaveLength(0);
    expect(store.getSnapshot().workspaces[0]!.replayWarnings).toBe(1);
  });
});

describe("case-specific sync location", () => {
  it("persists the invite's host and uses it for the first pull and later sync", async () => {
    const member = newMember("Owner");
    const c = newCase({ title: "remote case", question: "question", privacy: "private", createdBy: member.id });
    const key = generateCaseKey(), host = `http://${"a".repeat(56)}.onion`;
    const envelope = await sealRecord(key, "cases", c);
    remote.push.mockResolvedValue({ cursor: 2 });
    remote.pull.mockImplementation(async (_id, _token, after) => ({ records: after ? [] : [{ ...envelope, seq: 1 }], cursor: after || 1, head: after || 1 }));
    const store = await import("../src/store.ts");
    await store.load();
    await store.joinCase({ caseId: c.id, caseKey: key, host }, "New member");
    await store.syncCase(c.id);
    expect(store.getSnapshot().workspaces[0]!.syncUrl).toBe(host);
    expect(remote.pull).toHaveBeenCalledWith(c.id, expect.any(String), 0, host);
    expect(remote.push.mock.calls.every((call) => call[3] === host)).toBe(true);
  });
});

describe("rotation transaction boundaries", () => {
  it("rejects stale-key writes, pulls and repair queues without changing committed data", async () => {
    const { database } = await import("../src/persistence.ts");
    const id = "a".repeat(32), oldKey = generateCaseKey(), nextKey = generateCaseKey();
    await database.putWorkspace({ caseId: id, caseKey: oldKey, memberId: "b".repeat(32), cursor: 0 });
    await database.patchWorkspace(id, { caseKey: nextKey });
    const evidence = newEvidence(id, "b".repeat(32), { kind: "note", title: "stale", body: "stale source" });
    const envelope = await sealRecord(oldKey, "evidence", evidence);
    const entry = { caseId: id, collection: "evidence" as const, record: evidence, envelope };
    const before = await database.entries();
    await expect(database.save(entry, envelope, oldKey)).rejects.toThrow();
    await expect(database.queue(id, [envelope], oldKey)).rejects.toThrow();
    await expect(database.pull(id, [entry], 1, 0, oldKey)).rejects.toThrow();
    expect(await database.entries()).toEqual(before);
  });
  it.each(["pull", "restore"])("aborts rotation if a newer %s committed after its snapshot was read", async (operation) => {
    const { database } = await import("../src/persistence.ts");
    const id = "a".repeat(32), key = generateCaseKey();
    const snapshot = { caseId: id, caseKey: key, memberId: "b".repeat(32), cursor: 0 };
    await database.putWorkspace(snapshot);
    const evidence = newEvidence(id, snapshot.memberId, { kind: "note", title: "newly pulled", body: "must survive" });
    const envelope = await sealRecord(key, "evidence", evidence);
    const incoming = [{ caseId: id, collection: "evidence" as const, record: evidence, envelope }];
    if (operation === "pull") await database.pull(id, incoming, 1, 0, key);
    else await database.restore(snapshot, incoming, []);
    const before = await database.entries();
    await expect(database.rotate(snapshot, [], { ...snapshot, caseKey: generateCaseKey() }, [], [])).rejects.toThrow();
    expect(await database.entries()).toEqual(before);
  });
});
