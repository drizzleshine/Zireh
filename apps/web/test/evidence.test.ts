import { newEvidence } from "@zireh/cases";
import { describe, expect, it } from "vitest";
import { evidenceContext, evidenceDownload } from "../src/evidence.ts";

describe("complete evidence and bounded research excerpts", () => {
  it("downloads the full source while reporting the exact truncated context", async () => {
    const evidence = newEvidence("a".repeat(32), "b".repeat(32), { kind: "document", title: "Long source", body: "x".repeat(99_990) + "FINAL LINE" });
    const context = evidenceContext([evidence], [evidence.id]);
    expect(context.entries[0]).toMatchObject({ truncated: true, total: 100_000 });
    expect(context.entries[0]!.text).toHaveLength(20_000);
    expect(await evidenceDownload(evidence).blob.text()).toBe(evidence.body);
  });
  it("reports omitted sources instead of exceeding the daemon's 20-source contract", () => {
    const sources = Array.from({ length: 21 }, () => newEvidence("a".repeat(32), "b".repeat(32), { kind: "note", title: "source", body: "text" }));
    expect(evidenceContext(sources, sources.map((source) => source.id))).toMatchObject({ omitted: 1, entries: expect.any(Array) });
    expect(evidenceContext(sources, sources.map((source) => source.id)).entries).toHaveLength(20);
  });
});
