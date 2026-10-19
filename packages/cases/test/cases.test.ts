import { generateCaseKey, sha256Hex } from "@zireh/crypto";
import { describe, expect, it } from "vitest";
import {
  caseToken,
  caseTokenHash,
  findingViews,
  inviteFragment,
  newCase,
  newEvidence,
  newFinding,
  newMember,
  newObservation,
  newReview,
  parseInvite,
  tally,
  timeline,
  type CaseRecords,
} from "../src/index.ts";

function sampleCase(): CaseRecords & { ada: string; bo: string } {
  const ada = newMember("Ada");
  const bo = newMember("Bo");
  const c = newCase({ title: "Port report", question: "Who is behind the threats?", privacy: "private", createdBy: ada.id });
  const ev = newEvidence(c.id, ada.id, { kind: "note", title: "Call log", body: "Three calls from an unknown number." });
  const obs = newObservation(c.id, { kind: "member", memberId: bo.id }, { text: "Calls began after publication.", evidenceIds: [ev.id] });
  const finding = newFinding(c.id, ada.id, { statement: "Threats are linked to the report.", observationIds: [obs.id, "f".repeat(32)], uncertainty: "Timing only." });
  return {
    ada: ada.id,
    bo: bo.id,
    case: c,
    members: [ada, bo],
    evidence: [ev],
    observations: [obs],
    findings: [finding],
    reviews: [],
    pseudonyms: [],
    comments: [],
    links: [],
    board: {},
    conclusions: [],
  };
}

describe("records", () => {
  it("hashes evidence and marks AI observations as drafts", () => {
    const rec = sampleCase();
    expect(rec.evidence[0]!.sha256).toBe(sha256Hex("Three calls from an unknown number."));
    const ai = newObservation(rec.case.id, { kind: "ai", runId: "a".repeat(32), requestedBy: rec.ada }, { text: "x", evidenceIds: [] });
    expect(ai.status).toBe("draft");
    expect(rec.case.salt).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("reviews", () => {
  it("counts each member's latest review only", () => {
    const rec = sampleCase();
    const f = rec.findings[0]!;
    const first = newReview(rec.case.id, rec.bo, { findingId: f.id, decision: "disagree", reason: "weak" });
    const later = { ...newReview(rec.case.id, rec.bo, { findingId: f.id, decision: "support", reason: "convinced" }), createdAt: new Date(Date.now() + 1000).toISOString() };
    expect(tally([first, later])).toMatchObject({ support: 1, disagree: 0, status: "supported" });
    expect(tally([])).toMatchObject({ status: "unreviewed" });
  });

  it("flags findings that cite missing observations", () => {
    const views = findingViews(sampleCase());
    expect(views[0]!.missingObservations).toEqual(["f".repeat(32)]);
  });

  it("builds a newest-first timeline", () => {
    const items = timeline(sampleCase());
    expect(items.map((i) => i.kind).sort()).toEqual(["evidence", "finding", "observation"]);
  });
});

describe("invites", () => {
  it("round-trips through a URL fragment and rejects malformed input", () => {
    const invite = { caseId: "a".repeat(32), caseKey: generateCaseKey() };
    expect(parseInvite(`https://app.test/#${inviteFragment(invite)}`)).toEqual(invite);
    expect(parseInvite("https://app.test/#zp1.short.key")).toBeUndefined();
  });

  it("derives a token the host can check but not reverse", () => {
    const key = generateCaseKey();
    const token = caseToken(key);
    expect(token).not.toContain(key);
    expect(caseTokenHash(token)).not.toBe(token);
    expect(caseToken(key)).toBe(token);
  });
});

describe("publication", () => {
  it("hashes the content and can hide names using the case table", async () => {
    const { buildPublication, newConclusion } = await import("../src/index.ts");
    const rec = sampleCase();
    const withTable = {
      ...rec,
      case: { ...rec.case, title: "Ada Obi and the port" },
      pseudonyms: [{ original: "Ada Obi", placeholder: "[PERSON_1]", kind: "person" as const, hint: "a journalist" }],
      conclusions: [newConclusion(rec.case.id, rec.ada, undefined, { outcome: "unresolved" as const, summary: "Ada Obi faces threats.", findingIds: [rec.findings[0]!.id], openQuestion: "Who sent them?" })],
    };
    const open = buildPublication(withTable, { hideNames: false, publishedAt: "2026-10-19T00:00:00.000Z" });
    const hidden = buildPublication(withTable, { hideNames: true, publishedAt: "2026-10-19T00:00:00.000Z" });
    expect(open.publication.title).toBe("Ada Obi and the port");
    expect(JSON.stringify(hidden.publication)).not.toContain("Ada");
    expect(hidden.publication.conclusion!.summary).toBe("a journalist faces threats.");
    expect(hidden.publication.authors).toEqual([]);
    expect(open.hash).not.toBe(hidden.hash);
    expect(buildPublication(withTable, { hideNames: false, publishedAt: "2026-10-19T00:00:00.000Z" }).hash).toBe(open.hash);
  });
});
