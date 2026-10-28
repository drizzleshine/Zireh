import { scriptedModel } from "@zireh/llm";
import { describe, expect, it } from "vitest";
import { checkLeak, passes } from "../src/leakcheck.ts";

const table = [{ original: "Ada Obi", placeholder: "[PERSON_1]", kind: "person" as const }];

describe("checkLeak", () => {
  it("scores 100 without asking the model when a hidden value is present", async () => {
    const model = scriptedModel(() => {
      throw new Error("should not be called");
    });
    const r = await checkLeak(model, "Tell me about ada obi's case", table);
    expect(r.score).toBe(100);
    expect(r.leakedOriginals).toEqual(["Ada Obi"]);
    expect(passes(r, 99)).toBe(false);
  });

  it("uses the model's assessment otherwise", async () => {
    const model = scriptedModel(() => '{"score": 20, "inferences": ["asks about asylum law"]}');
    const r = await checkLeak(model, "What do I need for an asylum interview?", table);
    expect(r).toEqual({ score: 20, inferences: ["asks about asylum law"], leakedOriginals: [] });
    expect(passes(r, 30)).toBe(true);
    expect(passes(r, 10)).toBe(false);
  });
});
