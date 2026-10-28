import { scriptedModel } from "@zireh/llm";
import { describe, expect, it } from "vitest";
import { checkCitations, reassemble, splitTask } from "../src/split.ts";

describe("splitTask", () => {
  it("returns de-duplicated pieces", async () => {
    const model = scriptedModel(() =>
      JSON.stringify({ pieces: ["What are German asylum criteria?", "What are German asylum criteria?", "How is press freedom in [PLACE_1]?"] }),
    );
    expect(await splitTask(model, "task")).toEqual(["What are German asylum criteria?", "How is press freedom in [PLACE_1]?"]);
  });

  it("rejects more than the maximum number of pieces", async () => {
    const model = scriptedModel(() => JSON.stringify({ pieces: Array.from({ length: 9 }, (_, i) => `question number ${i}`) }));
    await expect(splitTask(model, "task")).rejects.toThrow();
  });
});

describe("reassemble", () => {
  const answers = [
    { label: "A1", question: "q1", answer: "a1" },
    { label: "A2", question: "q2", answer: "a2" },
  ];

  it("checks citations in code", async () => {
    const model = scriptedModel(() => "<think>x</think>Claim one [A1]. Claim two [A7].");
    const r = await reassemble(model, "task", answers);
    expect(r).toEqual({
      text: "Claim one [A1]. Claim two [A7].",
      cited: ["A1"],
      invalidCitations: ["A7"],
      uncited: ["A2"],
    });
  });

  it("skips the model for a single piece", async () => {
    const model = scriptedModel(() => {
      throw new Error("should not be called");
    });
    const r = await reassemble(model, "task", [answers[0]!]);
    expect(r.text).toBe("a1");
  });

  it("checkCitations handles no citations", () => {
    expect(checkCitations("plain", answers).uncited).toEqual(["A1", "A2"]);
  });
});
