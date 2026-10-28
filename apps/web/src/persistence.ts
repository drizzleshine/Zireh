import type { CollectionName } from "@zireh/schema";
import { compareRevisions, envelopeRevision, LEGACY_REVISION, type Envelope, type Revision } from "@zireh/sync";
import { randomId, type MemberKeys } from "@zireh/crypto";

export interface WorkspaceData {
  readonly caseId: string;
  readonly caseKey: string;
  readonly memberKeys?: MemberKeys;
  readonly requiresSignatures?: boolean;
  readonly memberId: string;
  readonly cursor: number;
  readonly storageRevision?: number;
  readonly syncId?: string;
  readonly syncUrl?: string;
  readonly keyEpoch?: number;
  readonly needsInvite?: boolean;
  readonly notices?: readonly { syncId: string; token: string; envelope: Envelope; host?: string }[];
  readonly replayWarnings?: number;
  readonly syncedAt?: string;
  readonly syncError?: string | undefined;
}
export interface StoredRecord { readonly caseId: string; readonly collection: CollectionName; readonly record: { id: string }; readonly envelope?: Envelope; readonly echoPending?: boolean; readonly verified?: boolean }
/**
 * Everything this browser keeps, in one IndexedDB object store ("zireh-records" → "data"), by key:
 *
 *   workspace:<case>                          keys, sync position and status for one case
 *   record:<case>:<collection>:<id>           one decrypted record plus its sealed envelope
 *   outbox:<case>:<id>:<iv>                   a sealed envelope still waiting to sync
 *   clock:record:<case>:<collection>:<id>     the last revision number used for a record
 *   history:<case>:<run>                      one research question and its answer (this device only)
 *   drafts:<case>                             text typed but not yet saved (see drafts.ts)
 *   vault:<case>                              sources' real identities (this device only, see sources.ts)
 *   wallet:pending-topup                      a top-up quote waiting for its payment (see WalletDialog.tsx)
 *   device-id, migrated-v1                    one-off values for the whole browser
 *
 * Build keys only through `Keys`, and read groups through `range`, so no caller scans everything.
 */
export const Keys = {
  workspace: (caseId: string) => `workspace:${caseId}`,
  record: (caseId: string, collection: CollectionName, id: string) => `record:${caseId}:${collection}:${id}`,
  records: (caseId?: string) => (caseId ? `record:${caseId}:` : "record:"),
  outbox: (caseId: string, envelope: Envelope) => `outbox:${caseId}:${envelope.id}:${envelope.sealed.iv}`,
  outboxes: (caseId?: string) => (caseId ? `outbox:${caseId}:` : "outbox:"),
  clock: (recordKey: string) => `clock:${recordKey}`,
  history: (caseId: string, runId: string) => `history:${caseId}:${runId}`,
  histories: (caseId: string) => `history:${caseId}:`,
  drafts: (caseId: string) => `drafts:${caseId}`,
  vault: (caseId: string) => `vault:${caseId}`,
  workspaces: "workspace:",
  allDrafts: "drafts:",
  vaults: "vault:",
  deviceId: "device-id",
  pendingTopup: "wallet:pending-topup",
} as const;
const workspaceKey = Keys.workspace;
const recordKey = (entry: StoredRecord) => Keys.record(entry.caseId, entry.collection, entry.record.id);
const outboxKey = Keys.outbox;
/** All keys starting with `prefix`: prefix itself up to prefix + the highest code unit. */
const under = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}\uffff`);

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
  /** One value by key, without loading anything else. */
  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction("data", "readonly").objectStore("data").get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  }
  /** Every value whose key starts with `prefix` (see Keys), in key order. */
  async range<T>(prefix: string): Promise<T[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction("data", "readonly").objectStore("data").getAll(under(prefix));
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  }
  /** Like `range`, with each value's key, for groups whose values don't carry their own id. */
  async rangeEntries<T>(prefix: string): Promise<[string, T][]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("data", "readonly");
      const store = transaction.objectStore("data");
      const keys = store.getAllKeys(under(prefix));
      const values = store.getAll(under(prefix));
      transaction.oncomplete = () => resolve(keys.result.map((key, index) => [String(key), values.result[index] as T]));
      transaction.onabort = () => reject(transaction.error);
    });
  }
  /** Remove everything this browser holds for one case, in one transaction. Nothing on the sync host changes. */
  purgeCase(caseId: string) {
    return this.write((store) => {
      for (const prefix of [Keys.records(caseId), Keys.outboxes(caseId), Keys.clock(Keys.records(caseId)), Keys.histories(caseId)]) store.delete(under(prefix));
      for (const key of [Keys.workspace(caseId), Keys.drafts(caseId), Keys.vault(caseId)]) store.delete(key);
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
  private withKey(store: IDBObjectStore, caseId: string, expectedKey: string | undefined, work: () => void) {
    if (!expectedKey) { work(); return; }
    const request = store.get(workspaceKey(caseId));
    request.onsuccess = () => { if (request.result?.caseKey !== expectedKey) store.transaction.abort(); else work(); };
  }
  save(entry: StoredRecord, envelope: Envelope, expectedKey?: string) {
    return this.write((store) => this.withKey(store, entry.caseId, expectedKey, () => {
      const current = store.get(recordKey(entry));
      current.onsuccess = () => {
        const saved = current.result as StoredRecord | undefined;
        if (saved && compareRevisions(envelopeRevision(envelope), saved.envelope ? envelopeRevision(saved.envelope) : LEGACY_REVISION) <= 0) { store.transaction.abort(); return; }
        store.put({ ...entry, envelope, echoPending: true }, recordKey(entry));
        store.put(envelope, outboxKey(entry.caseId, envelope));
        const ws = store.get(workspaceKey(entry.caseId));
        ws.onsuccess = () => { if (ws.result) store.put({ ...ws.result, storageRevision: Number(ws.result.storageRevision ?? 0) + 1 }, workspaceKey(entry.caseId)); };
      };
    }));
  }
  queue(caseId: string, envelopes: readonly Envelope[], expectedKey?: string) {
    return this.write((store) => this.withKey(store, caseId, expectedKey, () => {
      for (const envelope of envelopes) {
        store.put(envelope, outboxKey(caseId, envelope));
        const key = Keys.record(caseId, envelope.collection, envelope.id);
        const current = store.get(key);
        current.onsuccess = () => {
          const entry = current.result as StoredRecord | undefined;
          if (entry?.envelope?.sealed.ct === envelope.sealed.ct) store.put({ ...entry, echoPending: true }, key);
        };
      }
    }));
  }
  acknowledge(caseId: string, envelopes: readonly Envelope[]) {
    return this.write((store) => { for (const envelope of envelopes) store.delete(outboxKey(caseId, envelope)); });
  }
  async reserveRevision(caseId: string, collection: CollectionName, id: string): Promise<Revision> {
    let revision: Revision | undefined;
    await this.write((store) => {
      const key = Keys.record(caseId, collection, id);
      const current = store.get(key);
      current.onsuccess = () => {
        const saved = current.result as StoredRecord | undefined;
        const clock = store.get(Keys.clock(key));
        clock.onsuccess = () => {
          const device = store.get(Keys.deviceId);
          device.onsuccess = () => {
            const deviceId = String(device.result ?? randomId());
            const lamport = Math.max(Number(clock.result ?? 0), saved?.envelope ? envelopeRevision(saved.envelope).lamport : 0) + 1;
            revision = { lamport, deviceId };
            store.put(lamport, Keys.clock(key));
            store.put(deviceId, Keys.deviceId);
          };
        };
      };
    });
    if (!revision) throw new Error("Could not reserve a record revision");
    return revision;
  }
  pull(caseId: string, entries: readonly StoredRecord[], cursor: number, invalid = 0, expectedKey?: string) {
    return this.write((store) => this.withKey(store, caseId, expectedKey, () => {
      let replays = invalid;
      const next = (index: number) => {
        const entry = entries[index];
        if (!entry) {
          const ws = store.get(workspaceKey(caseId));
          ws.onsuccess = () => { if (ws.result) store.put({ ...ws.result, cursor, storageRevision: Number(ws.result.storageRevision ?? 0) + 1, replayWarnings: Number(ws.result.replayWarnings ?? 0) + replays }, workspaceKey(caseId)); };
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
    }));
  }
  rotate(expected: WorkspaceData, expectedOutbox: readonly Envelope[], workspace: WorkspaceData, records: readonly StoredRecord[], outbox: readonly Envelope[]) {
    return this.write((store) => {
      const ws = store.get(workspaceKey(workspace.caseId));
      ws.onsuccess = () => {
        if (!ws.result || ws.result.caseKey !== expected.caseKey || ws.result.syncId !== expected.syncId || ws.result.syncUrl !== expected.syncUrl || Number(ws.result.storageRevision ?? 0) !== (expected.storageRevision ?? 0)) { store.transaction.abort(); return; }
        const pending = store.openCursor(under(Keys.outboxes(workspace.caseId)));
        const found: string[] = [];
        pending.onsuccess = () => {
          const cursor = pending.result;
          if (cursor) { found.push((cursor.value as Envelope).sealed.ct); cursor.delete(); cursor.continue(); return; }
          if (found.length !== expectedOutbox.length || expectedOutbox.some((envelope) => !found.includes(envelope.sealed.ct))) { store.transaction.abort(); return; }
          store.put({ ...workspace, storageRevision: (expected.storageRevision ?? 0) + 1 }, workspaceKey(workspace.caseId));
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
        store.put({ ...(ws.result ?? workspace), storageRevision: Number(ws.result?.storageRevision ?? 0) + 1 }, workspaceKey(workspace.caseId));
        for (const entry of entries) {
          const current = store.get(recordKey(entry));
          current.onsuccess = () => {
            const saved = current.result as StoredRecord | undefined;
            if (!saved || compareRevisions(entry.envelope ? envelopeRevision(entry.envelope) : LEGACY_REVISION, saved.envelope ? envelopeRevision(saved.envelope) : LEGACY_REVISION) > 0) store.put(entry, recordKey(entry));
          };
        }
        for (const envelope of outbox) store.put(envelope, outboxKey(workspace.caseId, envelope));
        for (const entry of history) {
          const key = Keys.history(workspace.caseId, entry.id);
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
