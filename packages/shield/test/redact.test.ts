import { scriptedModel } from "@zireh/llm";
import { describe, expect, it } from "vitest";
import { applyTable, detectPatterns, properNounCandidates, extendTable, findLeaks, glossary, redactText, restore, withHints } from "../src/redact/index.ts";

describe("detectPatterns", () => {
  it("finds contacts, ids and money without overlap", () => {
    const found = detectPatterns("Mail ada@lab.org or call +234 803 555 0101; paid $4,500 to GB82WEST12345698765432.");
    expect(found.map((d) => d.kind)).toEqual(["contact", "contact", "id", "money"]);
    expect(found.map((d) => d.text)).toContain("ada@lab.org");
  });
});

describe("detectPatterns: quotes", () => {
  it("treats verbatim quotes of three or more words as identifying", () => {
    const found = detectPatterns("She got a text saying 'Stop writing about the bay' and it's \"odd\".");
    expect(found).toContainEqual({ text: "Stop writing about the bay", kind: "other" });
    expect(found.some((d) => d.text === "odd")).toBe(false);
  });
});

describe("properNounCandidates", () => {
  it("finds capitalized names but not sentence-initial common words", () => {
    expect(properNounCandidates("What laws protect journalists in Nigeria who report at Apapa port? She told Ada Obi.")).toEqual(["Nigeria", "Apapa", "Ada Obi"]);
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
  it("combines model entities with pattern detections and ignores invented entities", async () => {
    const model = scriptedModel((m) =>
      m[0]!.content.includes("general kind")
        ? JSON.stringify({ hints: {} })
        : JSON.stringify({ entities: [{ text: "Dr. Okafor", kind: "person" }, { text: "Not In Text", kind: "org" }] }),
    );
    const result = await redactText(model, "Dr. Okafor (okafor@stmary.ng) asked about it.", []);
    expect(result.text).toBe("[PERSON_1] ([CONTACT_1]) asked about it.");
    expect(result.added.map((p) => p.original).sort()).toEqual(["Dr. Okafor", "okafor@stmary.ng"]);
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
    expect(glossary(table).sort()).toEqual(["[ORG_1] = an organization", "[PLACE_1] = a large city in Nigeria"]);
  });

  it("rejects a hint that contains another hidden value", () => {
    const table = extendTable([], [
      { text: "Lagos", kind: "place", hint: "a large city in Nigeria" },
      { text: "Apapa port", kind: "place", hint: "a port in Lagos" },
    ]);
    expect(table.find((p) => p.original === "Apapa port")!.hint).toBe("a location");
  });

  it("catches names the extraction missed with a classification pass", async () => {
    const model = scriptedModel((m) => {
      const sys = m[0]!.content;
      if (sys.includes("say what it names")) return JSON.stringify({ items: [{ text: "Nigeria", kind: "place" }, { text: "Apapa", kind: "place" }] });
      if (sys.includes("general kind")) return JSON.stringify({ hints: { Nigeria: "a country in West Africa", Apapa: "a port district" } });
      return JSON.stringify({ entities: [] });
    });
    const r = await redactText(model, "What laws protect journalists in Nigeria who report at Apapa port?", []);
    expect(r.text).toBe("What laws protect journalists in [PLACE_1] who report at [PLACE_2] port?");
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
