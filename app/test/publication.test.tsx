import { newCase, newConclusion, newMember, type CaseRecords } from "@zireh/cases";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ records: undefined as CaseRecords | undefined }));
vi.mock("../src/store.ts", () => ({ useStore: (select: (value: unknown) => unknown) => select({ cases: { audit: state.records } }), myMemberId: () => "a".repeat(32), save: vi.fn(), savePseudonyms: vi.fn(), editPseudonym: vi.fn() }));
import { ConcludePanel } from "../src/components/ConcludePanel.tsx";

describe("F05 hidden publication approval", () => {
  it("blocks export until the current snapshot has been scanned and reviewed", () => {
    const member = newMember("Author");
    const c = newCase({ title: "Case", question: "What happened?", privacy: "private", createdBy: member.id });
    state.records = { case: c, members: [member], evidence: [], observations: [], findings: [], reviews: [], pseudonyms: [], comments: [], links: [], board: {}, conclusions: [newConclusion(c.id, member.id, undefined, { outcome: "resolved", summary: "ada obi supplied the evidence", findingIds: [], openQuestion: "" })], replies: [] };
    const html = renderToStaticMarkup(<ConcludePanel caseId="audit" onOpen={() => {}} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:<svg.*?<\/svg>)?\s*Download the page<\/button>/);
    expect(html).toContain("Scan");
  });
});
