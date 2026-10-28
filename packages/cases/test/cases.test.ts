import { fromBase64Url, generateCaseKey, toBase64Url, utf8ToBytes, sha256Hex } from "@zireh/crypto";
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
    replies: [],
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

describe("F05 publication scan coverage", () => {
  it("covers evidence titles and every string in the exact publication snapshot", async () => {
    const { buildPublication, publicationTexts } = await import("../src/index.ts");
    const rec = sampleCase();
    const p = buildPublication({ ...rec, evidence: rec.evidence.map((e) => ({ ...e, title: "Interview with ada obi" })) }, { hideNames: false }).publication;
    const strings = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
    expect(publicationTexts(p)).toContain("Interview with ada obi");
    expect(publicationTexts(p)).toEqual(strings(p));
    const hidden = buildPublication({ ...rec, evidence: rec.evidence.map((e) => ({ ...e, title: "Interview with ada obi" })), pseudonyms: [{ original: "ada obi", placeholder: "[PERSON_1]", kind: "person", hint: "a source" }] }, { hideNames: true }).publication;
    expect(publicationTexts(hidden).join("\n")).not.toContain("ada obi");
  });
});

describe("invite sync-host location", () => {
  it("includes a validated public host and signed-case requirement in the fragment", () => {
    const invite = { caseId: "a".repeat(32), caseKey: generateCaseKey(), host: "https://sync.example.org", requiresSignatures: true };
    const fragment = inviteFragment(invite);
    expect(fragment.startsWith("zp2.")).toBe(true);
    expect(parseInvite(`http://127.0.0.1:7878/#${fragment}`)).toMatchObject({ ...invite, syncId: invite.caseId, keyEpoch: 0 });
  });
  it("refuses internal addresses, plain HTTP and URLs with extra routing material", () => {
    for (const host of ["http://169.254.169.254", "https://169.254.169.254", "http://192.168.1.1", "https://[fd00::1]", "https://printer.local", "http://public.example", `http://${"a".repeat(56)}.onion`, "http://user@localhost:8788", "http://localhost:8788/path", "http://localhost:8788/?secret=1"]) {
      expect(() => inviteFragment({ caseId: "a".repeat(32), caseKey: generateCaseKey(), host })).toThrow();
    }
  });
  it("never writes a loopback host into an invite and rejects one on parse", () => {
    for (const host of ["http://127.0.0.1:11434", "http://localhost:8788"]) {
      expect(() => inviteFragment({ caseId: "a".repeat(32), caseKey: generateCaseKey(), host })).toThrow();
    }
    const bad = `zp2.${toBase64Url(utf8ToBytes(JSON.stringify({ caseId: "a".repeat(32), caseKey: generateCaseKey(), host: "http://127.0.0.1:11434", syncId: "a".repeat(32), keyEpoch: 0 })))}`;
    expect(parseInvite(`https://app.test/#${bad}`)).toBeUndefined();
    expect(fromBase64Url(bad.slice(4)).length).toBeGreaterThan(0);
  });
});
