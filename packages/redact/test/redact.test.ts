import { scriptedModel } from "@zireh/llm";
import { describe, expect, it } from "vitest";
import { applyTable, detectPatterns, extendTable, findLeaks, redactText, restore } from "../src/index.ts";

describe("detectPatterns", () => {
  it("finds contacts, ids and money without overlap", () => {
    const found = detectPatterns("Mail ada@lab.org or call +234 803 555 0101; paid $4,500 to GB82WEST12345698765432.");
    expect(found.map((d) => d.kind)).toEqual(["contact", "contact", "id", "money"]);
    expect(found.map((d) => d.text)).toContain("ada@lab.org");
  });
});

describe("pseudonym table", () => {
  it("is stable: known originals keep their placeholder, new ones continue numbering", () => {
    const t1 = extendTable([], [{ text: "Ada Obi", kind: "person" }]);
    const t2 = extendTable(t1, [
      { text: "ada obi", kind: "person" },
      { text: "Musa", kind: "person" },
    ]);
    expect(t2.map((p) => p.placeholder)).toEqual(["[PERSON_1]", "[PERSON_2]"]);
  });

  it("applies longest first, on word boundaries, and restores exactly", () => {
    const table = extendTable([], [
      { text: "Ada", kind: "person" },
      { text: "Ada Obi", kind: "person" },
      { text: "Lagos", kind: "place" },
    ]);
    const redacted = applyTable("Ada Obi met Ada in Lagos. Adamant!", table);
    expect(redacted).toBe("[PERSON_2] met [PERSON_1] in [PLACE_1]. Adamant!");
    expect(restore(redacted, table)).toBe("Ada Obi met Ada in Lagos. Adamant!");
  });

  it("findLeaks reports originals that survived", () => {
    const table = extendTable([], [{ text: "Lagos", kind: "place" }]);
    expect(findLeaks("flights to lagos", table)).toEqual(["Lagos"]);
    expect(findLeaks("flights to [PLACE_1]", table)).toEqual([]);
  });
});

describe("redactText", () => {
  it("combines model entities with pattern detections and ignores invented entities", async () => {
    const model = scriptedModel(() =>
      JSON.stringify({ entities: [{ text: "Dr. Okafor", kind: "person" }, { text: "Not In Text", kind: "org" }] }),
    );
    const result = await redactText(model, "Dr. Okafor (okafor@stmary.ng) asked about it.", []);
    expect(result.text).toBe("[PERSON_1] ([CONTACT_1]) asked about it.");
    expect(result.added.map((p) => p.original).sort()).toEqual(["Dr. Okafor", "okafor@stmary.ng"]);
  });

  it("throws (fail closed) when the local model can't produce entities", async () => {
    const model = scriptedModel(() => "sorry");
    await expect(redactText(model, "anything", [])).rejects.toThrow();
  });
});
