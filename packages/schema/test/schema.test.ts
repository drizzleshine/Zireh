import { describe, expect, it } from "vitest";
import { Amount, BlindedMessage, ChatPaidRequest, LEVELS, Pseudonym, PrivacyLevel } from "../src/index.ts";

describe("privacy levels", () => {
  it("has a policy for every level, and protection only increases with level", () => {
    const order = PrivacyLevel.options;
    expect(Object.keys(LEVELS).sort()).toEqual([...order].sort());
    const cloud = order.filter((l) => LEVELS[l].cloud);
    for (let i = 1; i < cloud.length; i++) {
      const prev = LEVELS[cloud[i - 1]!];
      const next = LEVELS[cloud[i]!];
      expect(next.decoys).toBeGreaterThanOrEqual(prev.decoys);
      expect(next.leakThreshold).toBeLessThanOrEqual(prev.leakThreshold);
    }
  });
});

describe("money", () => {
  it("accepts only power-of-two amounts", () => {
    expect(Amount.safeParse(64).success).toBe(true);
    expect(Amount.safeParse(48).success).toBe(false);
    expect(Amount.safeParse(0).success).toBe(false);
  });

  it("allows blank (amount 0) change outputs", () => {
    const B_ = `02${"a".repeat(64)}`;
    expect(BlindedMessage.safeParse({ amount: 0, B_, keysetId: "k" }).success).toBe(true);
  });

  it("rejects a paid chat request without proofs", () => {
    const parsed = ChatPaidRequest.safeParse({
      requestId: "0".repeat(32),
      request: { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 10 },
      proofs: [],
      changeOutputs: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("pseudonyms", () => {
  it("requires bracketed uppercase placeholders", () => {
    expect(Pseudonym.safeParse({ original: "Ada", placeholder: "[PERSON_1]", kind: "person" }).success).toBe(true);
    expect(Pseudonym.safeParse({ original: "Ada", placeholder: "PERSON_1", kind: "person" }).success).toBe(false);
  });
});
