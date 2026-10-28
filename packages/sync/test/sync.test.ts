import { generateCaseKey, randomId, randomSalt } from "@zireh/crypto";
import type { Case } from "@zireh/schema";
import { describe, expect, it } from "vitest";
import { openRecord, sealRecord } from "../src/index.ts";

const sampleCase = (): Case => ({
  id: randomId(),
  title: "Port report",
  question: "Who is behind the threats?",
  salt: randomSalt(),
  privacy: "private",
  createdAt: new Date().toISOString(),
  createdBy: randomId(),
});

describe("sealed records", () => {
  it("round-trips and hides the content from the host", async () => {
    const key = generateCaseKey();
    const c = sampleCase();
    const env = await sealRecord(key, "cases", c);
    expect(JSON.stringify(env)).not.toContain("Port report");
    expect(await openRecord(key, env)).toEqual({ collection: "cases", record: c, rev: env.sealed.rev });
  });

  it("drops records the host tampered with or relabeled", async () => {
    const key = generateCaseKey();
    const env = await sealRecord(key, "cases", sampleCase());
    expect(await openRecord(key, { ...env, collection: "findings" })).toBeUndefined();
    expect(await openRecord(key, { ...env, id: randomId() })).toBeUndefined();
    expect(await openRecord(generateCaseKey(), env)).toBeUndefined();
  });
});

describe("F15 sync wire limits", () => {
  it("rejects a single oversized encrypted record before it can be queued", async () => {
    const { assertSyncable, takeSyncBatch, MAX_SYNC_BODY_BYTES } = await import("../src/index.ts");
    const envelope = await sealRecord(generateCaseKey(), "cases", sampleCase());
    const oversized = { ...envelope, sealed: { ...envelope.sealed, ct: "x".repeat(MAX_SYNC_BODY_BYTES) } };
    expect(() => assertSyncable(oversized)).toThrow("too large to sync");
    expect(() => takeSyncBatch([oversized])).toThrow("too large to sync");
  });
});

describe("F11 revision authentication", () => {
  it("rejects a changed counter or device identity", async () => {
    const key = generateCaseKey();
    const env = await sealRecord(key, "cases", sampleCase(), { lamport: 7, deviceId: "a".repeat(32) });
    expect(await openRecord(key, { ...env, sealed: { ...env.sealed, rev: { lamport: 8, deviceId: "a".repeat(32) } } })).toBeUndefined();
    expect(await openRecord(key, { ...env, sealed: { ...env.sealed, rev: { lamport: 7, deviceId: "b".repeat(32) } } })).toBeUndefined();
  });
});

describe("case key rotation", () => {
  it("preserves the record and authenticated revision while revoking the previous key", async () => {
    const { rekeyRecord } = await import("../src/index.ts");
    const oldKey = generateCaseKey(), newKey = generateCaseKey();
    const c = sampleCase();
    const original = await sealRecord(oldKey, "cases", c);
    const rotated = await rekeyRecord(oldKey, newKey, original);
    expect(await openRecord(newKey, rotated)).toEqual(await openRecord(oldKey, original));
    expect(await openRecord(oldKey, rotated)).toBeUndefined();
  });
});

describe("per-member signed authorship", () => {
  it("rejects another member claiming or editing a review", async () => {
    const { generateMemberKeys } = await import("@zireh/crypto");
    const alice = await generateMemberKeys(), bob = await generateMemberKeys();
    const key = generateCaseKey(), id = randomId();
    const review = { id, caseId: randomId(), findingId: randomId(), memberId: alice.memberId, decision: "support" as const, reason: "checked source", createdAt: new Date().toISOString() };
    const rev = { lamport: 1, deviceId: randomId() };
    await expect(sealRecord(key, "reviews", review, rev, { keys: bob })).rejects.toThrow("another member");
    const signed = await sealRecord(key, "reviews", review, rev, { keys: alice });
    const opened = await openRecord(key, signed);
    expect(opened?.auth?.origin.memberId).toBe(alice.memberId);
    await expect(sealRecord(key, "reviews", { ...review, decision: "disagree" }, { ...rev, lamport: 2 }, { keys: bob, prior: opened!.auth! })).rejects.toThrow();
    const tampered = { ...signed, sealed: { ...signed.sealed, rev: { ...rev, lamport: 2 } } };
    expect(await openRecord(key, tampered)).toBeUndefined();
  });
  it("lets a teammate accept an AI observation while preserving its original author", async () => {
    const { generateMemberKeys } = await import("@zireh/crypto");
    const alice = await generateMemberKeys(), bob = await generateMemberKeys();
    const key = generateCaseKey(), rev = { lamport: 1, deviceId: randomId() };
    const observation = { id: randomId(), caseId: randomId(), evidenceIds: [], text: "original analysis", author: { kind: "ai" as const, runId: randomId(), requestedBy: alice.memberId }, status: "draft" as const, createdAt: new Date().toISOString() };
    const original = await openRecord(key, await sealRecord(key, "observations", observation, rev, { keys: alice }));
    const accepted = await openRecord(key, await sealRecord(key, "observations", { ...observation, status: "accepted" }, { ...rev, lamport: 2 }, { keys: bob, prior: original!.auth! }));
    expect(accepted?.auth?.origin.memberId).toBe(alice.memberId);
    expect(accepted?.auth?.editor.memberId).toBe(bob.memberId);
    await expect(sealRecord(key, "observations", { ...observation, text: "forged analysis" }, { ...rev, lamport: 3 }, { keys: bob, prior: original!.auth! })).rejects.toThrow();
  });
});
