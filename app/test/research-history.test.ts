import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { database } from "../src/persistence.ts";
const remote = vi.hoisted(() => ({ researchResults: vi.fn() }));
vi.mock("../src/api.ts", () => ({ api: remote }));
import { reconcileResearch, researchHistory, saveResearch, type Run } from "../src/research-history.ts";
const caseId = "a".repeat(32), runId = "b".repeat(32);
const run: Run = { task: "original question", level: "private", pieces: [], steps: [], table: [], blocked: [] };
const piece = { runId, requestId: "c".repeat(32), pieceId: "d".repeat(32), question: "general question", content: "recovered answer", charged: 12, answerExpired: false, runSpent: 24 };
beforeEach(async () => { await database.clear(); remote.researchResults.mockReset(); });

describe("persistent research history", () => {
  it("retains a run and reconciles recovered answers once", async () => {
    await saveResearch(caseId, runId, run);
    remote.researchResults.mockResolvedValue({ results: [piece] });
    await reconcileResearch(caseId);
    const loaded = await researchHistory(caseId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.run).toMatchObject({ task: "original question", recoveredAnswers: [{ content: "recovered answer" }], recoveredSpent: 24 });
    await reconcileResearch(caseId);
    expect(await researchHistory(caseId)).toEqual(loaded);
  });
  it("never overwrites a final answer received while recovery is being fetched", async () => {
    await saveResearch(caseId, runId, run);
    let deliver!: (value: { results: typeof piece[] }) => void;
    remote.researchResults.mockImplementation(() => new Promise((resolve) => { deliver = resolve; }));
    const pending = reconcileResearch(caseId);
    while (!deliver) await new Promise((resolve) => setTimeout(resolve, 0));
    const done = { type: "done" as const, outcome: { answer: "final synthesis", redactedAnswer: "final synthesis", citations: { text: "", cited: [], invalidCitations: [], uncited: [] } }, table: [], spent: 24, ms: 1 };
    await saveResearch(caseId, runId, { ...run, done });
    deliver({ results: [piece] });
    await pending;
    expect((await researchHistory(caseId))[0]!.run.done?.outcome.answer).toBe("final synthesis");
  });
});
