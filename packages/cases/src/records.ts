import { randomId, randomSalt, sha256Hex } from "@zireh/crypto";
import type { Author, Case, Comment, Conclusion, Evidence, Finding, Link, Member, Observation, Outcome, PrivacyLevel, Review } from "@zireh/schema";

/** Constructors for collaboration records. They fill ids, hashes and timestamps. */

const now = () => new Date().toISOString();

export function newMember(name: string): Member {
  return { id: randomId(), name: name.trim(), joinedAt: now() };
}

export function newCase(input: { title: string; question: string; privacy: PrivacyLevel; createdBy: string }): Case {
  return {
    id: randomId(),
    title: input.title.trim(),
    question: input.question.trim(),
    privacy: input.privacy,
    salt: randomSalt(),
    createdAt: now(),
    createdBy: input.createdBy,
  };
}

export function newEvidence(caseId: string, addedBy: string, input: { kind: Evidence["kind"]; title: string; body: string }): Evidence {
  return {
    id: randomId(),
    caseId,
    kind: input.kind,
    title: input.title.trim(),
    body: input.body,
    sha256: sha256Hex(input.body),
    addedBy,
    addedAt: now(),
  };
}

export function newObservation(caseId: string, author: Author, input: { text: string; evidenceIds: string[] }): Observation {
  return {
    id: randomId(),
    caseId,
    evidenceIds: input.evidenceIds,
    text: input.text,
    author,
    status: author.kind === "ai" ? "draft" : "accepted", // AI output is a draft until a member accepts it
    createdAt: now(),
  };
}

export function newFinding(caseId: string, createdBy: string, input: { statement: string; observationIds: string[]; uncertainty: string }): Finding {
  return { id: randomId(), caseId, createdBy, createdAt: now(), ...input, statement: input.statement.trim() };
}

export function newReview(caseId: string, memberId: string, input: { findingId: string; decision: Review["decision"]; reason: string }): Review {
  return { id: randomId(), caseId, memberId, createdAt: now(), ...input };
}

export function newComment(caseId: string, memberId: string, input: { targetId: string; text: string }): Comment {
  return { id: randomId(), caseId, memberId, createdAt: now(), targetId: input.targetId, text: input.text.trim() };
}

export function newLink(caseId: string, createdBy: string, input: { from: string; to: string; label: string }): Link {
  return { id: randomId(), caseId, createdBy, createdAt: now(), ...input, label: input.label.trim() };
}

export function newConclusion(
  caseId: string,
  createdBy: string,
  previous: Conclusion | undefined,
  input: { outcome: Outcome; summary: string; findingIds: string[]; openQuestion: string },
): Conclusion {
  return { id: randomId(), caseId, createdBy, createdAt: now(), revision: (previous?.revision ?? 0) + 1, ...input, summary: input.summary.trim() };
}
