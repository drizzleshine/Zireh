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
    const { assertSyncable, takeSyncBatch } = await import("../src/index.ts");
    const envelope = await sealRecord(generateCaseKey(), "cases", sampleCase());
    const oversized = { ...envelope, sealed: { ...envelope.sealed, ct: "x".repeat(4 * 1024 * 1024) } };
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
