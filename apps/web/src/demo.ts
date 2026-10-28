import { generateMemberKeys } from "@zireh/crypto";
import { newEvidence, newFinding, newLink, newMember, newObservation, newReply, newReview } from "@zireh/cases";
import { applyTable, extendTable } from "@zireh/redact";
import type { Pseudonym } from "@zireh/schema";
import { announceHistory, saveResearch, type Run } from "./research-history.ts";
import { createCase, myMemberId, savePseudonyms, saveAs } from "./store.ts";


/**
 * A fictional case so visitors can try everything without their own material.
 * Every person, outlet and place here is invented.
 */
export async function createDemoCase(yourName: string): Promise<string> {
  const caseId = await createCase({
    title: "Kestrel Bay customs leak (fictional demo)",
    question: "Who is waving undeclared containers through Kestrel Bay, and is our reporter Mara Venn safe after publishing?",
    privacy: "private",
    memberName: yourName,
  });
  const me = myMemberId(caseId);
  const samKeys = await generateMemberKeys();
  const sam = { ...newMember("Sam (demo teammate)"), id: samKeys.memberId, signingKey: samKeys.publicKey };
  await saveAs(caseId, "members", sam, samKeys);

  // Each item has a source, so the finding below meets the two-source rule.
  const tip = {
    ...newEvidence(caseId, me, {
      kind: "note",
      title: "Anonymous tip, 2 March",
      body: "A dock clerk at Kestrel Bay says shift supervisor Ilan Roth stamps release forms for containers from Larkspur Freight without inspection, always on night shifts.",
    }),
    source: "Source A",
  };
  const log = {
    ...newEvidence(caseId, sam.id, {
      kind: "document",
      title: "Gate log extract, nights of 4–9 March",
      body: "Larkspur Freight containers LF-2291, LF-2304 and LF-2317 released between 01:10 and 02:40. Inspector field blank. Supervisor on duty: I. Roth.",
    }),
    source: "Source B",
  };
  const threat = {
    ...newEvidence(caseId, me, {
      kind: "note",
      title: "Message received by Mara Venn, 12 March",
      body: "Two days after the Harbor Ledger story ran, Mara Venn received a text from an unknown number: 'Stop writing about the bay.'",
    }),
    source: "Source C",
  };

  // The hide list, with the descriptions the AI reads instead of each name.
  const table = extendTable([], [
    { text: "Mara Venn", kind: "person", hint: "a reporter" },
    { text: "Harbor Ledger", kind: "org", hint: "a local newspaper" },
    { text: "Ilan Roth", kind: "person", hint: "a shift supervisor" },
    { text: "Larkspur Freight", kind: "org", hint: "a freight company" },
    { text: "Kestrel Bay", kind: "place", hint: "a container port" },
  ]);
  await savePseudonyms(caseId, table);
  for (const e of [tip, log, threat]) await saveAs(caseId, "evidence", e, e.addedBy === sam.id ? samKeys : undefined);

  const obs1 = newObservation(caseId, { kind: "member", memberId: sam.id }, { text: "All three releases happened on Roth's night shifts, matching the tip.", evidenceIds: [tip.id, log.id] });
  const obs2 = newObservation(caseId, { kind: "member", memberId: me }, { text: "The threat arrived within 48 hours of publication, so it is likely a reaction to the story.", evidenceIds: [threat.id] });
  for (const o of [obs1, obs2]) await saveAs(caseId, "observations", o, o.author.kind === "member" && o.author.memberId === sam.id ? samKeys : undefined);

  const finding = newFinding(caseId, sam.id, {
    statement: "Larkspur Freight containers were released without inspection on a single supervisor's shifts.",
    observationIds: [obs1.id],
    uncertainty: "We have one week of gate logs; the pattern may be shorter or longer.",
  });
  await saveAs(caseId, "findings", finding, samKeys);
  await saveAs(caseId, "reviews", newReview(caseId, sam.id, { findingId: finding.id, decision: "support", reason: "Logs match the tip exactly." }), samKeys);
  await saveAs(caseId, "links", newLink(caseId, sam.id, { from: tip.id, to: log.id, label: "same supervisor" }), samKeys);
  const deadline = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  await saveAs(caseId, "replies", { ...newReply(caseId, me, { party: "Larkspur Freight press office", findingIds: [finding.id], deadline }), status: "contacted" });
  await saveResearch(caseId, crypto.randomUUID().replace(/-/g, ""), exampleRun(table, threat.id));
  announceHistory(caseId);
  return caseId;
}

/**
 * One finished question, so Research shows what an answer looks like before anything is sent.
 * It is marked as an example everywhere it appears; it never went to a relay and cost nothing.
 */
function exampleRun(caseTable: readonly Pseudonym[], evidenceId: string): Run {
  const table = caseTable.filter((p) => p.original === "Mara Venn" || p.original === "Harbor Ledger");
  const step = (stage: Run["steps"][number]["step"]["stage"], title: string, detail: string, atMs: number) => ({ step: { stage, title, detail }, atMs });
  const piece = (id: string, role: "real" | "decoy", question: string, ms: number) => ({ id, role, question, wire: question, status: "answered" as const, ms });
  const answer =
    "Treat the text as a real but early warning. A single anonymous message soon after publication is a common intimidation pattern; it is more worrying if it repeats or shows knowledge of the reporter's home or routine [A1]. " +
    "For Mara Venn: keep the message and the number, note when it arrived, and don't reply. Tell the Harbor Ledger editor today, vary routes for a while, and report it to a press-freedom group, which can advise on whether to involve the police [A2].";
  return {
    example: true,
    threadId: crypto.randomUUID().replace(/-/g, ""),
    askedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    evidenceIds: [evidenceId],
    task: "Is Mara Venn at risk after the Harbor Ledger story, and what should she do about the text she got?",
    level: "private",
    table,
    steps: [
      step("redact", "Hid 2 values", "Mara Venn → a reporter, Harbor Ledger → a local newspaper", 1100),
      step("split", "Split into 2 independent questions", "Neither question mentions the other, so the provider can't join them.", 2600),
      step("leakcheck", "Leak check passed", "The on-device AI played the provider and couldn't tell who this is about.", 4300),
      step("decoy", "Added 2 decoys", "Cover questions on unrelated topics, sent the same way.", 5200),
      step("reassemble", "Combined the answers on this device", "Decoy answers were dropped and the names put back.", 9400),
    ],
    pieces: [
      piece("p1", "real", "When does an anonymous threatening text to a reporter soon after a story suggest real danger?", 3900),
      piece("d1", "decoy", "How do I keep basil alive indoors through the winter?", 3100),
      piece("p2", "real", "What should a local newspaper and its reporter do after the reporter receives an anonymous threat?", 4200),
      piece("d2", "decoy", "What is a good first cycling route in hilly country?", 2800),
    ],
    blocked: [],
    done: {
      type: "done",
      outcome: { answer, redactedAnswer: applyTable(answer, table), citations: { text: applyTable(answer, table), cited: ["A1", "A2"], invalidCitations: [], uncited: [] } },
      table: [...table],
      spent: 0,
      ms: 9400,
    },
  };
}
