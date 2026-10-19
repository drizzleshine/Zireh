import { z } from "zod";
import { PrivacyLevel, Pseudonym } from "./privacy.ts";

/** Collaboration domain. Plaintext shapes; the sync layer seals them before they leave. */

const Id = z.string().regex(/^[0-9a-f]{32}$/);
const Iso = z.string().datetime();

export const Member = z.object({
  id: Id, // opaque, random per case
  name: z.string().min(1).max(60),
  joinedAt: Iso,
});
export type Member = z.infer<typeof Member>;

export const Case = z.object({
  id: Id,
  title: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(2000),
  salt: z.string().regex(/^[0-9a-f]{64}$/), // per-case prompt salt (cache isolation)
  privacy: PrivacyLevel,
  createdAt: Iso,
  createdBy: Id,
});
export type Case = z.infer<typeof Case>;

export const EvidenceKind = z.enum(["note", "document", "link", "image"]);
export const Evidence = z.object({
  id: Id,
  caseId: Id,
  kind: EvidenceKind,
  title: z.string().trim().min(1).max(200),
  body: z.string().max(100_000), // text content, or a data: URL for images
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  addedBy: Id,
  addedAt: Iso,
});
export type Evidence = z.infer<typeof Evidence>;

export const Author = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), memberId: Id }),
  z.object({ kind: z.literal("ai"), runId: Id, requestedBy: Id }),
]);
export type Author = z.infer<typeof Author>;

export const Observation = z.object({
  id: Id,
  caseId: Id,
  evidenceIds: z.array(Id),
  text: z.string().min(1).max(20_000),
  author: Author,
  status: z.enum(["draft", "accepted", "rejected"]),
  createdAt: Iso,
});
export type Observation = z.infer<typeof Observation>;

export const Finding = z.object({
  id: Id,
  caseId: Id,
  statement: z.string().trim().min(1).max(5000),
  observationIds: z.array(Id).min(1),
  uncertainty: z.string().max(2000),
  createdBy: Id,
  createdAt: Iso,
});
export type Finding = z.infer<typeof Finding>;

export const ReviewDecision = z.enum(["support", "disagree", "needs-evidence"]);
export const Review = z.object({
  id: Id,
  caseId: Id,
  findingId: Id,
  memberId: Id,
  decision: ReviewDecision,
  reason: z.string().max(2000),
  createdAt: Iso,
});
export type Review = z.infer<typeof Review>;

/** The case's pseudonym table: one record per case (id = case id), shared so placeholders agree. */
export const PseudonymTable = z.object({
  id: Id,
  caseId: Id,
  entries: z.array(Pseudonym),
});
export type PseudonymTable = z.infer<typeof PseudonymTable>;

/** Every record type that syncs, keyed by its collection name. */
export const Collections = {
  members: Member,
  cases: Case,
  evidence: Evidence,
  observations: Observation,
  findings: Finding,
  reviews: Review,
  pseudonyms: PseudonymTable,
} as const;
export type CollectionName = keyof typeof Collections;
export type RecordOf<C extends CollectionName> = z.infer<(typeof Collections)[C]>;
