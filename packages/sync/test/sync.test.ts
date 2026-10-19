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
    expect(await openRecord(key, env)).toEqual({ collection: "cases", record: c });
  });

  it("drops records the host tampered with or relabeled", async () => {
    const key = generateCaseKey();
    const env = await sealRecord(key, "cases", sampleCase());
    expect(await openRecord(key, { ...env, collection: "findings" })).toBeUndefined();
    expect(await openRecord(key, { ...env, id: randomId() })).toBeUndefined();
    expect(await openRecord(generateCaseKey(), env)).toBeUndefined();
  });
});
