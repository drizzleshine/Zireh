import type { CollectionName } from "@zireh/schema";
import { compareRevisions, envelopeRevision, LEGACY_REVISION, type Envelope, type Revision } from "@zireh/sync";
import { randomId } from "@zireh/crypto";

export interface WorkspaceData {
  readonly caseId: string;
  readonly caseKey: string;
  readonly memberId: string;
  readonly cursor: number;
  readonly syncId?: string;
  readonly keyEpoch?: number;
  readonly needsInvite?: boolean;
  readonly notices?: readonly { syncId: string; token: string; envelope: Envelope }[];
  readonly replayWarnings?: number;
  readonly syncedAt?: string;
  readonly syncError?: string | undefined;
}
export interface StoredRecord { readonly caseId: string; readonly collection: CollectionName; readonly record: { id: string }; readonly envelope?: Envelope; readonly echoPending?: boolean }
const workspaceKey = (id: string) => `workspace:${id}`;
const recordKey = (entry: StoredRecord) => `record:${entry.caseId}:${entry.collection}:${entry.record.id}`;
const outboxKey = (caseId: string, envelope: Envelope) => `outbox:${caseId}:${envelope.id}:${envelope.sealed.iv}`;

/** Individual records and their pending envelopes commit in one IndexedDB transaction. */
class BrowserDatabase {
  private opened: Promise<IDBDatabase> | undefined;
  private open(): Promise<IDBDatabase> {
    return this.opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("zireh-records", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("data");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async write(work: (store: IDBObjectStore) => void): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("data", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Local storage transaction aborted"));
      transaction.onerror = () => reject(transaction.error);
      try { work(transaction.objectStore("data")); } catch (error) { transaction.abort(); reject(error); }
    });
  }
  async entries(): Promise<[string, unknown][]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("data", "readonly");
      const store = transaction.objectStore("data");
      const keys = store.getAllKeys();
      const values = store.getAll();
      transaction.oncomplete = () => resolve(keys.result.map((key, index) => [String(key), values.result[index]]));
      transaction.onabort = () => reject(transaction.error);
    });
  }
  clear() { return this.write((store) => { store.clear(); }); }
  putWorkspace(workspace: WorkspaceData) { return this.write((store) => { store.put(workspace, workspaceKey(workspace.caseId)); }); }
  patchWorkspace(caseId: string, patch: Partial<WorkspaceData>) {
    return this.write((store) => this.patch(store, caseId, patch));
  }
  private patch(store: IDBObjectStore, caseId: string, patch: Partial<WorkspaceData>) {
    const request = store.get(workspaceKey(caseId));
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, ...patch }, workspaceKey(caseId)); };
  }
  removeWorkspace(caseId: string) { return this.write((store) => { store.delete(workspaceKey(caseId)); }); }
  save(entry: StoredRecord, envelope: Envelope, expectedKey?: string) {
    return this.write((store) => {
      const workspace = store.get(workspaceKey(entry.caseId));
      workspace.onsuccess = () => {
      if (expectedKey && workspace.result?.caseKey !== expectedKey) { store.transaction.abort(); return; }
      const current = store.get(recordKey(entry));
      current.onsuccess = () => {
        const saved = current.result as StoredRecord | undefined;
        if (saved && compareRevisions(envelopeRevision(envelope), saved.envelope ? envelopeRevision(saved.envelope) : LEGACY_REVISION) <= 0) { store.transaction.abort(); return; }
        store.put({ ...entry, envelope, echoPending: true }, recordKey(entry));
        store.put(envelope, outboxKey(entry.caseId, envelope));
      };
      };
    });
  }
  queue(caseId: string, envelopes: readonly Envelope[]) {
    return this.write((store) => {
      for (const envelope of envelopes) {
        store.put(envelope, outboxKey(caseId, envelope));
        const key = `record:${caseId}:${envelope.collection}:${envelope.id}`;
        const current = store.get(key);
        current.onsuccess = () => {
          const entry = current.result as StoredRecord | undefined;
          if (entry?.envelope?.sealed.ct === envelope.sealed.ct) store.put({ ...entry, echoPending: true }, key);
        };
      }
    });
  }
  acknowledge(caseId: string, envelopes: readonly Envelope[]) {
    return this.write((store) => { for (const envelope of envelopes) store.delete(outboxKey(caseId, envelope)); });
  }
  async reserveRevision(caseId: string, collection: CollectionName, id: string): Promise<Revision> {
    let revision: Revision | undefined;
    await this.write((store) => {
      const key = `record:${caseId}:${collection}:${id}`;
      const current = store.get(key);
      current.onsuccess = () => {
        const saved = current.result as StoredRecord | undefined;
        const clock = store.get(`clock:${key}`);
        clock.onsuccess = () => {
          const device = store.get("device-id");
          device.onsuccess = () => {
            const deviceId = String(device.result ?? randomId());
            const lamport = Math.max(Number(clock.result ?? 0), saved?.envelope ? envelopeRevision(saved.envelope).lamport : 0) + 1;
            revision = { lamport, deviceId };
            store.put(lamport, `clock:${key}`);
            store.put(deviceId, "device-id");
          };
        };
      };
    });
    if (!revision) throw new Error("Could not reserve a record revision");
    return revision;
  }
  pull(caseId: string, entries: readonly StoredRecord[], cursor: number, invalid = 0) {
    return this.write((store) => {
      let replays = invalid;
      const next = (index: number) => {
        const entry = entries[index];
        if (!entry) {
          const ws = store.get(workspaceKey(caseId));
          ws.onsuccess = () => { if (ws.result) store.put({ ...ws.result, cursor, replayWarnings: Number(ws.result.replayWarnings ?? 0) + replays }, workspaceKey(caseId)); };
          return;
        }
        const current = store.get(recordKey(entry));
        current.onsuccess = () => {
          const saved = current.result as StoredRecord | undefined;
          const incoming = entry.envelope ? envelopeRevision(entry.envelope) : LEGACY_REVISION;
          const prior = saved?.envelope ? envelopeRevision(saved.envelope) : LEGACY_REVISION;
          if (!saved || compareRevisions(incoming, prior) > 0) store.put(entry, recordKey(entry));
          else if (saved.echoPending && entry.envelope && saved.envelope?.sealed.ct === entry.envelope.sealed.ct && saved.envelope.sealed.iv === entry.envelope.sealed.iv) {
            store.put({ ...saved, echoPending: false }, recordKey(entry));
          } else replays++;
          next(index + 1);
        };
      };
      next(0);
    });
  }
  rotate(expectedKey: string, expectedOutbox: readonly Envelope[], workspace: WorkspaceData, records: readonly StoredRecord[], outbox: readonly Envelope[]) {
    return this.write((store) => {
      const ws = store.get(workspaceKey(workspace.caseId));
      ws.onsuccess = () => {
        if (!ws.result || ws.result.caseKey !== expectedKey) { store.transaction.abort(); return; }
        const prefix = `outbox:${workspace.caseId}:`;
        const pending = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        const found: string[] = [];
        pending.onsuccess = () => {
          const cursor = pending.result;
          if (cursor) { found.push((cursor.value as Envelope).sealed.ct); cursor.delete(); cursor.continue(); return; }
          if (found.length !== expectedOutbox.length || expectedOutbox.some((envelope) => !found.includes(envelope.sealed.ct))) { store.transaction.abort(); return; }
          store.put(workspace, workspaceKey(workspace.caseId));
          for (const entry of records) store.put(entry, recordKey(entry));
          for (const envelope of outbox) store.put(envelope, outboxKey(workspace.caseId, envelope));
        };
      };
    });
  }
  acknowledgeNotice(caseId: string, ciphertext: string) {
    return this.write((store) => {
      const request = store.get(workspaceKey(caseId));
      request.onsuccess = () => { if (request.result) store.put({ ...request.result, notices: (request.result.notices ?? []).filter((notice: { envelope: Envelope }) => notice.envelope.sealed.ct !== ciphertext) }, workspaceKey(caseId)); };
    });
  }
  restore(workspace: WorkspaceData, entries: readonly StoredRecord[], outbox: readonly Envelope[], history: readonly { id: string; caseId: string }[] = []) {
    return this.write((store) => {
      const ws = store.get(workspaceKey(workspace.caseId));
      ws.onsuccess = () => {
        if (ws.result && ws.result.caseKey !== workspace.caseKey) { store.transaction.abort(); return; }
        if (!ws.result) store.put(workspace, workspaceKey(workspace.caseId));
        for (const entry of entries) {
          const current = store.get(recordKey(entry));
          current.onsuccess = () => {
            const saved = current.result as StoredRecord | undefined;
            if (!saved || compareRevisions(entry.envelope ? envelopeRevision(entry.envelope) : LEGACY_REVISION, saved.envelope ? envelopeRevision(saved.envelope) : LEGACY_REVISION) > 0) store.put(entry, recordKey(entry));
          };
        }
        for (const envelope of outbox) store.put(envelope, outboxKey(workspace.caseId, envelope));
        for (const entry of history) {
          const key = `history:${workspace.caseId}:${entry.id}`;
          const existing = store.get(key);
          existing.onsuccess = () => { if (!existing.result) store.put(entry, key); };
        }
      };
    });
  }
  migrate(workspaces: readonly (WorkspaceData & { outbox: Envelope[] })[], records: readonly StoredRecord[]) {
    return this.write((store) => {
      const request = store.get("migrated-v1");
      request.onsuccess = () => {
        if (request.result) return;
        for (const { outbox, ...workspace } of workspaces) {
          store.put(workspace, workspaceKey(workspace.caseId));
          for (const envelope of outbox) store.put(envelope, outboxKey(workspace.caseId, envelope));
        }
        for (const entry of records) {
          const envelopes = workspaces.find((workspace) => workspace.caseId === entry.caseId)?.outbox ?? [];
          const envelope = envelopes.filter((envelope) => envelope.collection === entry.collection && envelope.id === entry.record.id).at(-1);
          store.put({ ...entry, ...(envelope ? { envelope, echoPending: true } : {}) }, recordKey(entry));
        }
        store.put(true, "migrated-v1");
      };
    });
  }
}
export const database = new BrowserDatabase();
