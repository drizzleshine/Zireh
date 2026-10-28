import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { clearCaseDrafts, clearDraft, draftsSnapshot, setDraft } from "../src/drafts.ts";

describe("drafts", () => {
  it("keeps one object of fields per case, where empty text stays empty and clearing removes", () => {
    setDraft("case-1", "evidence.intake", "half a tip");
    setDraft("case-1", "conclude.summary", "");
    setDraft("case-2", "comment.x", "hello");
    expect(draftsSnapshot()).toMatchObject({ "case-1": { "evidence.intake": "half a tip", "conclude.summary": "" }, "case-2": { "comment.x": "hello" } });
    clearDraft("case-1", "evidence.intake");
    expect(draftsSnapshot()["case-1"]).toEqual({ "conclude.summary": "" });
    clearCaseDrafts("case-2");
    expect(draftsSnapshot()["case-2"]).toBeUndefined();
  });
});
