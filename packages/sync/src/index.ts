import { openJson, randomId, sealJson, type Sealed } from "@zireh/crypto";
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
export async function sealRecord<C extends CollectionName>(caseKey: string, collection: C, record: RecordOf<C>, rev: Revision = { lamport: 1, deviceId: randomId() }): Promise<Envelope> {
  Revision.parse(rev);
  const id = (record as { id: string }).id;
  return { id, collection, sealed: { ...await sealJson(caseKey, { rev, record }, context(collection, id, rev)), rev } };
}

/** Decrypt and validate both the record and its authenticated revision. */
export async function openRecord(caseKey: string, envelope: Envelope): Promise<{ collection: CollectionName; record: unknown; rev: Revision } | undefined> {
  try {
    const rev = envelope.sealed.rev;
    const value = await openJson<unknown>(caseKey, envelope.sealed as Sealed, context(envelope.collection, envelope.id, rev));
    let record = value;
    if (rev) {
      const wrapped = z.object({ rev: Revision, record: z.unknown() }).safeParse(value);
      if (!wrapped.success || compareRevisions(wrapped.data.rev, rev) !== 0) return undefined;
      record = wrapped.data.record;
    }
    const parsed = Collections[envelope.collection].safeParse(record);
    if (!parsed.success || (parsed.data as { id: string }).id !== envelope.id) return undefined;
    return { collection: envelope.collection, record: parsed.data, rev: rev ?? LEGACY_REVISION };
  } catch { return undefined; }
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
