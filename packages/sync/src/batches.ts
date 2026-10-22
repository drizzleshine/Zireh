import type { Envelope } from "./index.ts";

export const MAX_SYNC_BODY_BYTES = 4 * 1024 * 1024;
export const SYNC_BATCH_BYTES = 3.5 * 1024 * 1024;
export const syncBytes = (records: readonly Envelope[]): number => new TextEncoder().encode(JSON.stringify({ records })).byteLength;

export function assertSyncable(envelope: Envelope): void {
  if (syncBytes([envelope]) > MAX_SYNC_BODY_BYTES) throw new Error("This evidence is too large to sync after encryption. Use a smaller image or split the document before saving.");
}

/** Bound the wire bytes, including JSON overhead, and the host's record-count limit. */
export function takeSyncBatch(records: readonly Envelope[]): Envelope[] {
  const batch: Envelope[] = [];
  let bytes = syncBytes([]);
  for (const envelope of records) {
    assertSyncable(envelope);
    const next = new TextEncoder().encode(JSON.stringify(envelope)).byteLength + (batch.length ? 1 : 0);
    if (batch.length && (bytes + next > SYNC_BATCH_BYTES || batch.length >= 200)) break;
    batch.push(envelope);
    bytes += next;
  }
  return batch;
}
