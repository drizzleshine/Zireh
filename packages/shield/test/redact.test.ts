import { scriptedModel } from "@zireh/llm";
import { describe, expect, it } from "vitest";
import { applyTable, extendTable, findLeaks, redactText, redactWithTable, restore, withHints } from "../src/redact/index.ts";

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

  it("restore turns invented placeholders into plain words", () => {
    const table = extendTable([], [{ text: "Ada", kind: "person" }]);
    expect(restore("[PERSON_1] and [PERSON_7] met at [PLACE_3].", table)).toBe("Ada and someone met at a place.");
  });

  it("findLeaks reports originals that survived", () => {
    const table = extendTable([], [{ text: "Lagos", kind: "place" }]);
    expect(findLeaks("flights to lagos", table)).toEqual(["Lagos"]);
    expect(findLeaks("flights to [PLACE_1]", table)).toEqual([]);
  });
});

describe("redactText", () => {
  it("hides only what the model finds in the text, ignoring invented entities", async () => {
    const model = scriptedModel((m) =>
      m[0]!.content.includes("general kind")
        ? JSON.stringify({ hints: {} })
        : JSON.stringify({ entities: [{ text: "Dr. Okafor", kind: "person" }, { text: "okafor@stmary.ng", kind: "contact" }, { text: "Not In Text", kind: "org" }] }),
    );
    const result = await redactText(model, "Dr. Okafor (okafor@stmary.ng) asked about it.", []);
    expect(result.text).toBe("[PERSON_1] ([CONTACT_1]) asked about it.");
    expect(result.added.map((p) => p.original).sort()).toEqual(["Dr. Okafor", "okafor@stmary.ng"]);
  });

  it("never guesses from capital letters or patterns", async () => {
    const model = scriptedModel((m) => (m[0]!.content.includes("general kind") ? JSON.stringify({ hints: {} }) : JSON.stringify({ entities: [] })));
    const text = "Ada Obi (ada@lab.org) reports from Apapa.";
    expect((await redactText(model, text, [])).text).toBe(text);
    expect(redactWithTable(text, []).text).toBe(text);
    expect(redactWithTable(text, extendTable([], [{ text: "Ada Obi", kind: "person" }])).text).toBe("[PERSON_1] (ada@lab.org) reports from Apapa.");
  });

  it("asks for hints separately, keeps vague ones, drops ones containing the value, and ignores topics", async () => {
    const model = scriptedModel((m) =>
      m[0]!.content.includes("general kind")
        ? JSON.stringify({ hints: { Lagos: "a large city in Nigeria", "Daily Ledger": "the Daily Ledger newspaper" } })
        : JSON.stringify({
            entities: [
              { text: "Lagos", kind: "place" },
              { text: "Daily Ledger", kind: "org" },
              { text: "smuggling", kind: "other" },
            ],
          }),
    );
    const { table, text } = await redactText(model, "The Daily Ledger in Lagos covers smuggling.", []);
    expect(text).toBe("The [ORG_1] in [PLACE_1] covers smuggling.");
    expect(table.find((p) => p.original === "Lagos")!.hint).toBe("a large city in Nigeria");
    expect(table.find((p) => p.original === "Daily Ledger")!.hint).toBe("an organization"); // own name inside: generic
    expect(withHints(text, table)).toBe("An organization in a large city in Nigeria covers smuggling.");
  });

  it("rejects a hint that contains another hidden value", () => {
    const table = extendTable([], [
      { text: "Lagos", kind: "place", hint: "a large city in Nigeria" },
      { text: "Apapa port", kind: "place", hint: "a port in Lagos" },
    ]);
    expect(table.find((p) => p.original === "Apapa port")!.hint).toBe("a location");
  });

  it("ignores implausible identifiers from the model (no capital, no digit)", async () => {
    const model = scriptedModel((m) =>
      m[0]!.content.includes("general kind")
        ? JSON.stringify({ hints: {} })
        : m[0]!.content.includes("say what it names")
          ? JSON.stringify({ items: [] })
          : JSON.stringify({ entities: [{ text: "records were altered", kind: "id" }, { text: "Enugu", kind: "place" }] }),
    );
    const r = await redactText(model, "In Enugu, records were altered.", []);
    expect(r.table.map((p) => p.original)).toEqual(["Enugu"]);
  });

  it("throws (fail closed) when the local model can't produce entities", async () => {
    const model = scriptedModel(() => "sorry");
    await expect(redactText(model, "anything", [])).rejects.toThrow();
  });
});

describe("F02 names across casing and writing systems", () => {
  it.each(["ada obi", "张伟", "éloïse durand", "محمد علي"])("hides a correctly detected name: %s", async (name) => {
    const model = scriptedModel((m) => m[0]!.content.includes("general kind") ? '{"hints":{}}' : JSON.stringify({ entities: [{ text: name, kind: "person" }] }));
    const result = await redactText(model, `is ${name} at risk?`, []);
    expect(result.text).not.toContain(name);
    expect(result.table).toContainEqual(expect.objectContaining({ original: name }));
  });
  it("does not hide stop words or a misclassified common phrase", async () => {
    const model = scriptedModel((m) => m[0]!.content.includes("general kind") ? '{"hints":{}}' : JSON.stringify({ entities: [{ text: "we", kind: "person" }, { text: "records were altered", kind: "org" }, { text: "records were altered", kind: "id" }] }));
    expect((await redactText(model, "we found records were altered", [])).table).toEqual([]);
  });
});
