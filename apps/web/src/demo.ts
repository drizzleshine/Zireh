import { newEvidence, newFinding, newLink, newMember, newObservation, newReview } from "@zireh/cases";
import { createCase, myMemberId, save } from "./store.ts";


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
  const sam = newMember("Sam (demo teammate)");
  await save(caseId, "members", sam);

  const tip = newEvidence(caseId, me, {
    kind: "note",
    title: "Anonymous tip, 2 March",
    body: "A dock clerk at Kestrel Bay says shift supervisor Ilan Roth stamps release forms for containers from Larkspur Freight without inspection, always on night shifts.",
  });
  const log = newEvidence(caseId, sam.id, {
    kind: "document",
    title: "Gate log extract, nights of 4–9 March",
    body: "Larkspur Freight containers LF-2291, LF-2304 and LF-2317 released between 01:10 and 02:40. Inspector field blank. Supervisor on duty: I. Roth.",
  });
  const threat = newEvidence(caseId, me, {
    kind: "note",
    title: "Message received by Mara Venn, 12 March",
    body: "Two days after the Harbor Ledger story ran, Mara Venn received a text from an unknown number: 'Stop writing about the bay.'",
  });
  for (const e of [tip, log, threat]) await save(caseId, "evidence", e);

  const obs1 = newObservation(caseId, { kind: "member", memberId: sam.id }, { text: "All three releases happened on Roth's night shifts, matching the tip.", evidenceIds: [tip.id, log.id] });
  const obs2 = newObservation(caseId, { kind: "member", memberId: me }, { text: "The threat arrived within 48 hours of publication, so it is likely a reaction to the story.", evidenceIds: [threat.id] });
  for (const o of [obs1, obs2]) await save(caseId, "observations", o);

  const finding = newFinding(caseId, sam.id, {
    statement: "Larkspur Freight containers were released without inspection on a single supervisor's shifts.",
    observationIds: [obs1.id],
    uncertainty: "We have one week of gate logs; the pattern may be shorter or longer.",
  });
  await save(caseId, "findings", finding);
  await save(caseId, "reviews", newReview(caseId, sam.id, { findingId: finding.id, decision: "support", reason: "Logs match the tip exactly." }));
  await save(caseId, "links", newLink(caseId, sam.id, { from: tip.id, to: log.id, label: "same supervisor" }));
  return caseId;
}
