import { openJson, sealJson, type Sealed } from "@zireh/crypto";
import { Collections, type CollectionName, type FetchLike, type RecordOf } from "@zireh/schema";
import { z } from "zod";

/**
 * End-to-end encrypted record sync. The host sees only envelopes: an id, a collection name,
 * a server sequence number and ciphertext. Record contents, member names and the case key
 * never leave members' devices in the clear.
 */
export const Envelope = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  collection: z.enum(Object.keys(Collections) as [CollectionName, ...CollectionName[]]),
  sealed: z.object({ v: z.literal(1), iv: z.string(), ct: z.string() }),
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
const context = (collection: CollectionName, id: string) => `${collection}:${id}`;

export async function sealRecord<C extends CollectionName>(caseKey: string, collection: C, record: RecordOf<C>): Promise<Envelope> {
  const id = (record as { id: string }).id;
  return { id, collection, sealed: await sealJson(caseKey, record, context(collection, id)) };
}

/** Decrypt and validate. A record that fails either check is dropped, never trusted. */
export async function openRecord(caseKey: string, envelope: Envelope): Promise<{ collection: CollectionName; record: unknown } | undefined> {
  try {
    const value = await openJson<unknown>(caseKey, envelope.sealed as Sealed, context(envelope.collection, envelope.id));
    const parsed = Collections[envelope.collection].safeParse(value);
    if (!parsed.success || (parsed.data as { id: string }).id !== envelope.id) return undefined;
    return { collection: envelope.collection, record: parsed.data };
  } catch {
    return undefined;
  }
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
