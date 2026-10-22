import { openJson, randomId, sealJson, memberIdForKey, signValue, verifyValue, type MemberKeys, type Sealed } from "@zireh/crypto";
import { Collections, type CollectionName, type FetchLike, type RecordOf } from "@zireh/schema";
import { z } from "zod";

/**
 * End-to-end encrypted record sync. The host sees only envelopes: an id, a collection name,
 * a server sequence number and ciphertext. Record contents, member names and the case key
 * never leave members' devices in the clear.
 */
export const Revision = z.object({ lamport: z.number().int().positive(), deviceId: z.string().regex(/^[0-9a-f]{32}$/) });
export type Revision = z.infer<typeof Revision>;
export const LEGACY_REVISION: Revision = { lamport: 0, deviceId: "0".repeat(32) };
export const compareRevisions = (a: Revision, b: Revision): number => a.lamport - b.lamport || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);

export interface SignatureProof { readonly memberId: string; readonly publicKey: string; readonly signature: string }
export interface Authorship { readonly origin: SignatureProof; readonly editor: SignatureProof }
export interface RecordSigner { readonly keys: MemberKeys; readonly prior?: Authorship; readonly ownerId?: string }

export const recordAuthor = (collection: CollectionName, record: unknown): string | undefined => {
  const r = record as Record<string, unknown>;
  if (collection === "members") return String(r.id);
  if (collection === "cases" || collection === "findings" || collection === "links" || collection === "conclusions") return String(r.createdBy);
  if (collection === "evidence") return String(r.addedBy);
  if (collection === "reviews" || collection === "comments") return String(r.memberId);
  if (collection === "observations") { const author = r.author as { kind: string; memberId?: string; requestedBy?: string }; return author.kind === "ai" ? author.requestedBy : author.memberId; }
  return undefined;
};
const originValue = (collection: CollectionName, record: unknown) => {
  const projected = { ...(record as Record<string, unknown>) };
  if (collection === "observations") delete projected.status;
  if (collection === "members") delete projected.removedAt;
  return { domain: "zireh/authorship/v1", collection, record: projected };
};
const editValue = (collection: CollectionName, record: unknown, rev: Revision, origin: SignatureProof) => ({ domain: "zireh/edit/v1", collection, record, rev, origin });
const proofFor = async (keys: MemberKeys, value: unknown): Promise<SignatureProof> => ({ memberId: keys.memberId, publicKey: keys.publicKey, signature: await signValue(keys, value) });
const validProof = (proof: SignatureProof, value: unknown) => proof && memberIdForKey(proof.publicKey) === proof.memberId && verifyValue(proof.publicKey, proof.signature, value);
async function signRecord(collection: CollectionName, record: unknown, rev: Revision, signer: RecordSigner): Promise<Authorship> {
  if (memberIdForKey(signer.keys.publicKey) !== signer.keys.memberId) throw new Error("Signing key does not match member identity");
  const claimed = recordAuthor(collection, record);
  let origin = signer.prior?.origin;
  if (!origin || claimed && origin.memberId !== claimed || !await validProof(origin, originValue(collection, record))) {
    if (claimed && claimed !== signer.keys.memberId) throw new Error("Cannot claim another member's authorship");
    origin = await proofFor(signer.keys, originValue(collection, record));
  }
  if (claimed && signer.keys.memberId !== claimed && collection !== "observations" && !(collection === "members" && signer.ownerId === signer.keys.memberId)) throw new Error("Only the author can edit this record");
  const editor = await proofFor(signer.keys, editValue(collection, record, rev, origin));
  if (!await validProof(editor, editValue(collection, record, rev, origin))) throw new Error("Private signing key does not match its public identity");
  return { origin, editor };
}
async function validAuthorship(collection: CollectionName, record: unknown, rev: Revision, auth: Authorship): Promise<boolean> {
  const claimed = recordAuthor(collection, record);
  if (!auth?.origin || !auth.editor || claimed && auth.origin.memberId !== claimed) return false;
  if (!await validProof(auth.origin, originValue(collection, record)) || !await validProof(auth.editor, editValue(collection, record, rev, auth.origin))) return false;
  if (collection === "members" && (record as { signingKey?: string }).signingKey !== auth.origin.publicKey) return false;
  return !claimed || auth.editor.memberId === claimed || collection === "observations" || collection === "members";
}

export const Envelope = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  collection: z.enum(Object.keys(Collections) as [CollectionName, ...CollectionName[]]),
  sealed: z.object({ v: z.literal(1), iv: z.string(), ct: z.string(), rev: Revision.optional() }),
});
export type Envelope = z.infer<typeof Envelope>;

export const StoredEnvelope = Envelope.extend({ seq: z.number().int().positive() });
export type StoredEnvelope = z.infer<typeof StoredEnvelope>;

export const PullResponse = z.object({
  records: z.array(StoredEnvelope),
  cursor: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(), // the host's latest sequence number for this case
});
export type PullResponse = z.infer<typeof PullResponse>;

/** Bind each ciphertext to its collection and id, so the host can't swap records around. */
const context = (collection: CollectionName, id: string, rev?: Revision) => `${collection}:${id}${rev ? `:${rev.lamport}:${rev.deviceId}` : ""}`;
export const envelopeRevision = (envelope: Envelope): Revision => envelope.sealed.rev ?? LEGACY_REVISION;

/** New records default to revision 1. Updating callers must supply a higher persisted revision. */
export async function sealRecord<C extends CollectionName>(caseKey: string, collection: C, record: RecordOf<C>, rev: Revision = { lamport: 1, deviceId: randomId() }, signer?: RecordSigner): Promise<Envelope> {
  Revision.parse(rev);
  const id = (record as { id: string }).id;
  const auth = signer ? await signRecord(collection, record, rev, signer) : undefined;
  return { id, collection, sealed: { ...await sealJson(caseKey, { rev, record, ...(auth ? { auth } : {}) }, context(collection, id, rev)), rev } };
}

/** Decrypt and validate both the record and its authenticated revision. */
export async function openRecord(caseKey: string, envelope: Envelope): Promise<{ collection: CollectionName; record: unknown; rev: Revision; auth?: Authorship } | undefined> {
  try {
    const rev = envelope.sealed.rev;
    const value = await openJson<unknown>(caseKey, envelope.sealed as Sealed, context(envelope.collection, envelope.id, rev));
    let record = value;
    let auth: Authorship | undefined;
    if (rev) {
      const wrapped = z.object({ rev: Revision, record: z.unknown(), auth: z.unknown().optional() }).safeParse(value);
      if (!wrapped.success || compareRevisions(wrapped.data.rev, rev) !== 0) return undefined;
      record = wrapped.data.record;
      auth = wrapped.data.auth as Authorship | undefined;
    }
    const parsed = Collections[envelope.collection].safeParse(record);
    if (!parsed.success || (parsed.data as { id: string }).id !== envelope.id) return undefined;
    if (auth && !await validAuthorship(envelope.collection, parsed.data, rev ?? LEGACY_REVISION, auth)) return undefined;
    return { collection: envelope.collection, record: parsed.data, rev: rev ?? LEGACY_REVISION, ...(auth ? { auth } : {}) };
  } catch { return undefined; }
}

/** Re-encrypt an authenticated payload without changing its revision or authorship. */
export async function rekeyRecord(oldKey: string, newKey: string, envelope: Envelope): Promise<Envelope> {
  if (!await openRecord(oldKey, envelope)) throw new Error("Cannot rotate an invalid record");
  const rev = envelope.sealed.rev;
  const aad = context(envelope.collection, envelope.id, rev);
  const value = await openJson<unknown>(oldKey, envelope.sealed, aad);
  return { id: envelope.id, collection: envelope.collection, sealed: { ...await sealJson(newKey, value, aad), ...(rev ? { rev } : {}) } };
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

/** Talks to the sync host. Over the daemon, so requests leave through Tor. */
export class SyncClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike,
  ) {}

  private async call<T>(path: string, token: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-case-token": token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new SyncError(`sync host: HTTP ${res.status} ${await res.text()}`, res.status);
    return schema.parse(await res.json());
  }

  /** First push for a case registers the token hash; later pushes must present the token. */
  push(caseId: string, token: string, records: readonly Envelope[]): Promise<{ cursor: number }> {
    return this.call(`/v1/cases/${caseId}/records`, token, z.object({ cursor: z.number() }), { records });
  }

  pull(caseId: string, token: string, after: number): Promise<PullResponse> {
    return this.call(`/v1/cases/${caseId}/records?after=${after}`, token, PullResponse);
  }
}

export * from "./batches.ts";
