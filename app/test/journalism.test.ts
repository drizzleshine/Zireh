import { describe, expect, it } from "vitest";
import { chronology } from "../src/chronology.ts";
import { verbatimRuns } from "../src/sources.ts";
import type { Evidence } from "@zireh/schema";
import type { CaseRecords } from "@zireh/cases";

const ev = (id: string, title: string, body: string, source?: string): Evidence => ({
  id: id.padEnd(32, "0"), caseId: "c".repeat(32), kind: "note", title, body, sha256: "0".repeat(64), addedBy: "a".repeat(32), addedAt: "2026-03-20T10:00:00.000Z", ...(source ? { source } : {}),
});

describe("chronology", () => {
  it("orders dates from titles and bodies and assumes the year the evidence was added", () => {
    const { events, undated } = chronology([
      ev("1", "Gate log", "Containers released on 4 March. Inspector field blank."),
      ev("2", "Tip, 2 March", "A dock clerk says the supervisor stamps forms."),
      ev("3", "Undated note", "Nothing here."),
    ]);
    expect(events.map((e) => e.date)).toEqual(["2026-03-02", "2026-03-04"]);
    expect(events[0]!.text).toBe("A dock clerk says the supervisor stamps forms.");
    expect(events[1]!.text).toBe("Containers released on 4 March.");
    expect(events.every((e) => e.guessedYear)).toBe(true);
    expect(undated.map((e) => e.title)).toEqual(["Undated note"]);
  });

  it("puts a yearless date in the previous year when it would otherwise be in the future", () => {
    const { events } = chronology([ev("1", "Old memo", "Signed on 14 December by the board.")]);
    expect(events[0]!.date).toBe("2025-12-14");
  });

  it("keeps a written range as a range instead of its first day", () => {
    const { events } = chronology([ev("1", "Gate log extract, nights of 4–9 March", "Released at night.")]);
    expect(events[0]).toMatchObject({ date: "2026-03-04", end: "2026-03-09" });
  });
});

describe("canary-trap check", () => {
  const rec = { evidence: [ev("1", "Leaked memo", "The committee will defer the audit of Pier 9 until the minister returns from Geneva next week.", "Source A"), ev("2", "Court filing", "The committee will defer the audit of Pier 9 until the minister returns.", "Public record")] } as unknown as CaseRecords;

  it("flags long word-for-word runs from non-public evidence, keeping original casing", () => {
    const runs = verbatimRuns("Sources say the committee will defer the audit of Pier 9 until the minister returns from Geneva.", rec);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.evidenceTitle).toBe("Leaked memo");
    expect(runs[0]!.snippet.startsWith("the committee will defer the audit of Pier")).toBe(true);
  });

  it("ignores paraphrase and public records", () => {
    expect(verbatimRuns("An audit at the pier was postponed while a minister travelled.", rec)).toEqual([]);
  });
});
