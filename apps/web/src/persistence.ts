import type { CollectionName } from "@zireh/schema";
import type { Envelope } from "@zireh/sync";

export interface WorkspaceData {
  readonly caseId: string;
  readonly caseKey: string;
  readonly memberId: string;
  readonly cursor: number;
  readonly syncedAt?: string;
  readonly syncError?: string | undefined;
}
export interface StoredRecord { readonly caseId: string; readonly collection: CollectionName; readonly record: { id: string } }
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
  save(entry: StoredRecord, envelope: Envelope) {
    return this.write((store) => { store.put(entry, recordKey(entry)); store.put(envelope, outboxKey(entry.caseId, envelope)); });
  }
  queue(caseId: string, envelopes: readonly Envelope[]) {
    return this.write((store) => { for (const envelope of envelopes) store.put(envelope, outboxKey(caseId, envelope)); });
  }
  acknowledge(caseId: string, envelopes: readonly Envelope[]) {
    return this.write((store) => { for (const envelope of envelopes) store.delete(outboxKey(caseId, envelope)); });
  }
  pull(caseId: string, entries: readonly StoredRecord[], cursor: number) {
    return this.write((store) => {
      for (const entry of entries) store.put(entry, recordKey(entry));
      this.patch(store, caseId, { cursor });
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
        for (const entry of records) store.put(entry, recordKey(entry));
        store.put(true, "migrated-v1");
      };
    });
  }
}
export const database = new BrowserDatabase();
