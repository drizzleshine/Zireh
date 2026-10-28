import type { StoredResearch } from "./research-history.ts";
import { caseToken, inviteFragment, newCase, newMember, type CaseRecords, type Invite } from "@zireh/cases";
import { MAX_BACKUP_BYTES, canonicalJson, decryptBackup, encryptBackup, fromBase64Url, generateCaseKey, generateMemberKeys, memberIdForKey, signValue, verifyValue, type MemberKeys, randomId } from "@zireh/crypto";
import { InviteSyncHost, SyncHost, Collections, type Case, type CollectionName, type Member, type PrivacyLevel, type Pseudonym, type RecordOf } from "@zireh/schema";
import { compareRevisions, envelopeRevision, LEGACY_REVISION, recordAuthor, rekeyRecord, assertSyncable, takeSyncBatch, openRecord, sealRecord, type RecordSigner, type Envelope } from "@zireh/sync";
import { delMany, get } from "idb-keyval";
import { database, Keys, type StoredRecord, type WorkspaceData } from "./persistence.ts";
import { useRef, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { clearCaseDrafts } from "./drafts.ts";
import { forgetIdentities, identitiesReady } from "./sources.ts";

/**
 * Local-first case storage. Records live in this browser (IndexedDB) and sync to the team
 * as sealed envelopes through the daemon. The case key never leaves the device except
 * inside an invite link fragment.
 */

interface Workspace extends WorkspaceData { readonly outbox: Envelope[] }

type Records = { -readonly [K in keyof CaseRecords]: CaseRecords[K] extends readonly (infer T)[] ? T[] : CaseRecords[K] } & { verifiedReviews?: string[] };

interface State {
  loaded: boolean;
  workspaces: Workspace[];
  cases: Record<string, Records>;
}

let state: State = { loaded: false, workspaces: [], cases: {} };
const listeners = new Set<() => void>();
const emit = () => {
  state = { ...state };
  for (const l of listeners) l();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/**
 * Select from the store. The selection is recomputed only when the store changes, so
 * selectors may build new arrays/objects without causing render loops.
 */
export function useStore<T>(select: (s: State) => T): T {
  const cache = useRef<{ state: State; value: T } | undefined>(undefined);
  return useSyncExternalStore(subscribe, () => {
    if (!cache.current || cache.current.state !== state) cache.current = { state, value: select(state) };
    return cache.current.value;
  });
}

let localChanges = Promise.resolve();
const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("zireh-records") : undefined;

async function refresh() {
  await identitiesReady; // "loaded" must mean source names are known, so they're always hidden
  // Only workspaces, outboxes and records: research history and drafts are loaded where they're used.
  const [saved, records] = await Promise.all([database.range<WorkspaceData>(Keys.workspaces), database.range<StoredRecord>(Keys.records())]);
  const workspaces = await Promise.all(saved.map(async (w) => ({ ...w, outbox: await database.range<Envelope>(Keys.outboxes(w.caseId)) })));
  const cases: Record<string, Records> = {};
  for (const entry of records) if (entry.collection === "cases") cases[entry.caseId] = emptyRecords(entry.record as Case);
  for (const entry of records) if (cases[entry.caseId]) {
    cases[entry.caseId] = apply(cases[entry.caseId]!, entry.collection, entry.record, true);
    if (entry.collection === "reviews" && entry.verified) cases[entry.caseId] = { ...cases[entry.caseId]!, verifiedReviews: [...(cases[entry.caseId]!.verifiedReviews ?? []), entry.record.id] };
  }
  state = { loaded: true, workspaces, cases };
  emit();
}

function change(work: () => Promise<void>, broadcast = true): Promise<void> {
  const task = localChanges.then(async () => { await work(); await refresh(); if (broadcast) channel?.postMessage("changed"); });
  localChanges = task.catch(() => {});
  return task;
}
if (channel) channel.onmessage = () => { void change(async () => {}, false); };

export async function load() {
  const workspaces = ((await get("workspaces")) as Workspace[] | undefined) ?? [];
  const records: StoredRecord[] = [];
  for (const w of workspaces) {
    const rec = (await get(`case:${w.caseId}`)) as Records | undefined;
    if (rec) for (const [collection, record] of recordPairs({ ...emptyRecords(rec.case), ...rec })) records.push({ caseId: w.caseId, collection, record });
  }
  await change(() => database.migrate(workspaces, records), false);
  // The copies in the old store are no longer read; once moved, don't leave them lying around.
  if (workspaces.length) await delMany(["workspaces", ...workspaces.map((w) => `case:${w.caseId}`)]).catch(() => {});
}

const workspace = (caseId: string) => {
  const w = state.workspaces.find((x) => x.caseId === caseId);
  if (!w) throw new Error("unknown case");
  return w;
};

const COLLECTION_FIELD: Record<CollectionName, keyof Records> = {
  members: "members",
  cases: "case",
  evidence: "evidence",
  observations: "observations",
  findings: "findings",
  reviews: "reviews",
  pseudonyms: "pseudonyms",
  comments: "comments",
  links: "links",
  board: "board",
  conclusions: "conclusions",
  replies: "replies",
};

const emptyRecords = (c: Case): Records => ({
  case: c,
  members: [],
  evidence: [],
  observations: [],
  findings: [],
  reviews: [],
  pseudonyms: [],
  comments: [],
  links: [],
  board: {},
  conclusions: [],
  replies: [],
});

/** Merge a pseudonym table from a teammate: by original value; colliding placeholders are renumbered. */
function mergePseudonyms(mine: readonly Pseudonym[], theirs: readonly Pseudonym[]): Pseudonym[] {
  const out = [...mine];
  const byOriginal = new Set(out.map((p) => p.original.toLowerCase()));
  for (const p of theirs) {
    if (byOriginal.has(p.original.toLowerCase())) continue;
    let placeholder = p.placeholder;
    if (out.some((q) => q.placeholder === placeholder)) {
      const prefix = /^\[([A-Z]+)_/.exec(placeholder)![1]!;
      const n = Math.max(0, ...out.filter((q) => q.placeholder.startsWith(`[${prefix}_`)).map((q) => Number(/_(\d+)\]/.exec(q.placeholder)![1]))) + 1;
      placeholder = `[${prefix}_${n}]`;
    }
    out.push({ ...p, placeholder });
    byOriginal.add(p.original.toLowerCase());
  }
  return out;
}

function apply(rec: Records, collection: CollectionName, record: unknown, local = false): Records {
  if (collection === "cases") return { ...rec, case: record as Case };
  if (collection === "pseudonyms") return { ...rec, pseudonyms: local ? [...(record as RecordOf<"pseudonyms">).entries] : mergePseudonyms(rec.pseudonyms, (record as RecordOf<"pseudonyms">).entries) };
  if (collection === "board") return { ...rec, board: { ...rec.board, ...(record as RecordOf<"board">).positions } };
  const field = COLLECTION_FIELD[collection] as Exclude<keyof Records, "case" | "pseudonyms" | "board">;
  const list = rec[field] as { id: string }[];
  const item = record as { id: string };
  return { ...rec, [field]: list.some((value) => value.id === item.id) ? list.map((value) => value.id === item.id ? item : value) : [...list, item] };
}

function authorizedRecord(entry: NonNullable<Awaited<ReturnType<typeof openRecord>>>, ownerId: string | undefined, required: boolean, members: readonly Member[]): boolean {
  if (required && !entry.auth) return false;
  const record = entry.record as { id: string; signingKey?: string; createdBy?: string };
  const claimed = recordAuthor(entry.collection, entry.record);
  if ((members.some((member) => member.id === claimed && member.signingKey) || entry.collection === "members" && record.signingKey) && !entry.auth) return false;
  if (required && entry.collection === "cases" && ownerId && record.createdBy !== ownerId) return false;
  if (entry.collection === "members" && entry.auth && entry.auth.editor.memberId !== record.id && entry.auth.editor.memberId !== ownerId) return false;
  return true;
}

async function signerFor(caseId: string, collection: CollectionName, id: string, keys = workspace(caseId).memberKeys): Promise<RecordSigner | undefined> {
  if (!keys) return undefined;
  const entry = await database.get<StoredRecord>(Keys.record(caseId, collection, id));
  const prior = entry?.envelope ? (await openRecord(workspace(caseId).caseKey, entry.envelope))?.auth : undefined;
  return { keys, ownerId: state.cases[caseId]?.case.createdBy ?? keys.memberId, ...(prior ? { prior } : {}) };
}

/** Save a record locally and queue it, sealed, for the team. */
export async function save<C extends CollectionName>(caseId: string, collection: C, record: RecordOf<C>) {
  return saveAs(caseId, collection, record);
}

/** Import an already-held member identity, e.g. the explicitly fictional demo teammate. */
export async function saveAs<C extends CollectionName>(caseId: string, collection: C, record: RecordOf<C>, keys?: MemberKeys) {
  if (!state.cases[caseId]) throw new Error("unknown case");
  const w = workspace(caseId);
  if (w.needsInvite) throw new Error("This case key was rotated. Open an updated invite before editing.");
  const signer = await signerFor(caseId, collection, (record as { id: string }).id, keys ?? w.memberKeys);
  const claimed = recordAuthor(collection, record);
  if ((w.requiresSignatures || state.cases[caseId]?.case.requiresSignatures || state.cases[caseId]?.members.some((member) => member.id === claimed && member.signingKey)) && !signer) throw new Error("Restore your signing identity from an encrypted backup before editing this case");
  const envelope = await sealRecord(w.caseKey, collection, record, await database.reserveRevision(caseId, collection, (record as { id: string }).id), signer);
  assertSyncable(envelope);
  await change(() => database.save({ caseId, collection, record: record as { id: string }, verified: !!signer }, envelope, w.caseKey));
  void syncCase(caseId);
}

export async function savePseudonyms(caseId: string, entries: Pseudonym[]) {
  const rec = state.cases[caseId];
  if (!rec) return;
  await save(caseId, "pseudonyms", { id: caseId, caseId, entries: mergePseudonyms(rec.pseudonyms, entries) });
}

/** Change how a hidden value is described, or stop hiding it (hint = null). */
export async function editPseudonym(caseId: string, original: string, hint: string | null) {
  const rec = state.cases[caseId];
  if (!rec) return;
  const entries = hint === null ? rec.pseudonyms.filter((p) => p.original !== original) : rec.pseudonyms.map((p) => (p.original === original ? { ...p, hint } : p));
  await save(caseId, "pseudonyms", { id: caseId, caseId, entries });
}

export async function createCase(input: { title: string; question: string; privacy: PrivacyLevel; memberName: string }): Promise<string> {
  const keys = await generateMemberKeys();
  const member = { ...newMember(input.memberName), id: keys.memberId, signingKey: keys.publicKey };
  const c = { ...newCase({ title: input.title, question: input.question, privacy: input.privacy, createdBy: member.id }), requiresSignatures: true };
  let syncUrl: string | undefined;
  try { syncUrl = SyncHost.parse((await api.syncConfig()).host); } catch { /* Local-first creation also works while the daemon is offline. */ }
  const w = { caseId: c.id, ...(syncUrl ? { syncUrl } : {}), caseKey: generateCaseKey(), memberId: member.id, memberKeys: keys, requiresSignatures: true, cursor: 0 };
  const envelope = await sealRecord(w.caseKey, "cases", c, await database.reserveRevision(c.id, "cases", c.id), { keys });
  await change(async () => { await database.putWorkspace(w); await database.save({ caseId: c.id, collection: "cases", record: c, verified: true }, envelope); });
  await save(c.id, "members", member);
  return c.id;
}

/** Join from an invite: pull the case, then add yourself as a member. */
export async function joinCase(invite: Invite, memberName: string): Promise<string> {
  if (invite.host !== undefined) InviteSyncHost.parse(invite.host);
  const existing = state.workspaces.find((workspace) => workspace.caseId === invite.caseId);
  if (existing) {
    if (existing.caseKey === invite.caseKey) {
      if (invite.host && existing.syncUrl !== invite.host) { await change(() => database.patchWorkspace(invite.caseId, { syncUrl: invite.host!, cursor: 0 })); void syncCase(invite.caseId); }
      return invite.caseId;
    }
    await acceptRotatedInvite(invite);
    return invite.caseId;
  }
  const keys = await generateMemberKeys();
  const member: Member = { ...newMember(memberName), id: keys.memberId, signingKey: keys.publicKey };
  await change(() => database.putWorkspace({ caseId: invite.caseId, caseKey: invite.caseKey, memberId: member.id, memberKeys: keys, requiresSignatures: invite.requiresSignatures ?? false, cursor: 0, ...(invite.host ? { syncUrl: invite.host } : {}), ...(invite.syncId ? { syncId: invite.syncId, keyEpoch: invite.keyEpoch } : {}) }));
  for (let attempt = 0; attempt < 3 && !state.cases[invite.caseId]; attempt++) await syncCase(invite.caseId);
  if (!state.cases[invite.caseId]) {
    await change(() => database.removeWorkspace(invite.caseId));
    throw new Error("Couldn't open this case. The link may be wrong, or the case hasn't synced yet.");
  }
  await save(invite.caseId, "members", member);
  return invite.caseId;
}

/** Move one card on the board (shared with the team). */
export async function moveOnBoard(caseId: string, itemId: string, x: number, y: number) {
  await save(caseId, "board", { id: itemId, caseId, positions: { [itemId]: { x: Math.round(x), y: Math.round(y) } } });
}

export const inviteLink = async (caseId: string): Promise<string> => {
  const w = workspace(caseId);
  if (w.needsInvite) throw new Error("Ask the creator for an updated invite");
  const raw = w.syncUrl ?? (await api.syncConfig()).host;
  if (!w.syncUrl) await change(() => database.patchWorkspace(caseId, { syncUrl: SyncHost.parse(raw) }));
  const onion = InviteSyncHost.safeParse(raw);
  const host = onion.success ? onion.data : undefined;
  return `${location.origin}/#${inviteFragment({ caseId, caseKey: w.caseKey, ...(host ? { host } : {}), ...(w.requiresSignatures ? { requiresSignatures: true } : {}), ...(w.syncId ? { syncId: w.syncId, keyEpoch: w.keyEpoch ?? 1 } : {}) })}`;
};

export const myMemberId = (caseId: string): string => workspace(caseId).memberId;

/** One sync per case at a time; concurrent callers share the in-flight one. */
const syncing = new Map<string, Promise<void>>();

/** Push queued envelopes, then pull and apply everything new. */
export function syncCase(caseId: string): Promise<void> {
  const running = syncing.get(caseId);
  if (running) return running;
  const run = async () => { await change(async () => {}, false); await syncOnce(caseId); };
  const task = (globalThis.navigator?.locks ? navigator.locks.request(`zireh-sync:${caseId}`, run) : run()).finally(() => syncing.delete(caseId));
  syncing.set(caseId, task);
  return task;
}

async function syncOnce(caseId: string) {
  const w = workspace(caseId);
  const token = caseToken(w.caseKey);
  try {
    for (const notice of w.notices ?? []) {
      await api.push(notice.syncId, notice.token, [notice.envelope], notice.host ?? w.syncUrl);
      await change(() => database.acknowledgeNotice(caseId, notice.envelope.sealed.ct));
    }
    if (w.needsInvite) return;
    while (workspace(caseId).outbox.length) {
      let batch = takeSyncBatch(workspace(caseId).outbox);
      let cursor: number;
      for (;;) {
        try { ({ cursor } = await api.push(w.syncId ?? caseId, token, batch, w.syncUrl)); break; }
        catch (error) {
          if ((error as { status?: number }).status !== 413 || batch.length < 2) throw error;
          batch = batch.slice(0, Math.ceil(batch.length / 2));
        }
      }
      await change(() => database.acknowledge(caseId, batch));
      // The host has fewer records than we've already seen: it was reset or replaced.
      if (cursor < w.cursor) queueMicrotask(() => void repairHost(caseId));
    }
    // Pull every page up to the host's head (pages hold at most 500 records).
    for (let page = 0; page < 20; page++) {
      let pulled;
      try {
        pulled = await api.pull(w.syncId ?? caseId, token, workspace(caseId).cursor, w.syncUrl);
      } catch (err) {
        if ((err as { status?: number }).status === 404 && state.cases[caseId]) {
          queueMicrotask(() => void repairHost(caseId)); // host doesn't know this case at all
          return;
        }
        throw err;
      }
      if (pulled.head < w.cursor) queueMicrotask(() => void repairHost(caseId)); // host fell behind us
      // Open the whole batch first: the case record may come after records that belong to it
      // (e.g. after a host repair), and nothing may be skipped once the cursor moves past it.
      let opened = (await Promise.all(pulled.records.map(async (envelope) => {
        const opened = await openRecord(w.caseKey, envelope);
        if (!opened) return undefined;
        const record = opened.record as { id: string; caseId?: string };
        if (opened.collection === "cases" ? record.id !== caseId : record.caseId !== undefined && record.caseId !== caseId) return undefined;
        return { ...opened, envelope };
      }))).filter((entry) => entry !== undefined);
      const ownerId = state.cases[caseId]?.case.createdBy ?? (opened.find((entry) => entry.collection === "cases")?.record as Case | undefined)?.createdBy;
      const requiresSignatures = w.requiresSignatures || state.cases[caseId]?.case.requiresSignatures || opened.some((entry) => entry.collection === "cases" && (entry.record as Case).requiresSignatures);
      const members = [...(state.cases[caseId]?.members ?? []), ...opened.filter((entry) => entry.collection === "members" && entry.auth).map((entry) => entry.record as Member)];
      opened = opened.filter((entry) => authorizedRecord(entry, ownerId, !!requiresSignatures, members));
      if (requiresSignatures && !w.requiresSignatures) await change(() => database.patchWorkspace(caseId, { requiresSignatures: true }));
      if (!state.cases[caseId] && !opened.some((entry) => entry.collection === "cases")) return;
      await change(() => database.pull(caseId, opened.map((entry) => ({ caseId, collection: entry.collection, record: entry.record as { id: string }, envelope: entry.envelope, verified: !!entry.auth })), pulled.cursor, pulled.records.length - opened.length, w.caseKey));
      if ((state.cases[caseId]?.case.keyEpoch ?? 0) > (w.keyEpoch ?? 0) && state.cases[caseId]?.case.nextSyncId) {
        await change(() => database.patchWorkspace(caseId, { needsInvite: true }));
        break;
      }
      if (pulled.records.length === 0 || pulled.cursor >= pulled.head) break;
    }
    await change(() => database.patchWorkspace(caseId, { syncedAt: new Date().toISOString(), syncError: undefined }));
  } catch (err) {
    await change(() => database.patchWorkspace(caseId, { syncError: (err as Error).message }));
  }
}

/** Every record this device holds for a case, as (collection, record) pairs. */
function recordPairs(rec: Records): [CollectionName, { id: string }][] {
  const caseId = rec.case.id;
  const out: [CollectionName, { id: string }][] = [["cases", rec.case]];
  const lists: [CollectionName, readonly { id: string }[]][] = [
    ["members", rec.members],
    ["evidence", rec.evidence],
    ["observations", rec.observations],
    ["findings", rec.findings],
    ["reviews", rec.reviews],
    ["comments", rec.comments],
    ["links", rec.links],
    ["conclusions", rec.conclusions],
    ["replies", rec.replies],
  ];
  for (const [collection, items] of lists) for (const item of items) out.push([collection, item]);
  if (rec.pseudonyms.length) out.push(["pseudonyms", { id: caseId, caseId, entries: rec.pseudonyms } as { id: string }]);
  if (Object.keys(rec.board).length) out.push(["board", { id: caseId, caseId, positions: rec.board } as { id: string }]);
  return out;
}

/**
 * Anti-entropy: list the ids the sync host holds for this case and re-upload (sealed) any
 * record it is missing. Repairs a host that was reset, replaced, or missed a push.
 */
async function repairHost(caseId: string) {
  const w = workspace(caseId);
  const token = caseToken(w.caseKey);
  if (w.needsInvite) return;
  const onHost = new Map<string, ReturnType<typeof envelopeRevision>>();
  let after = 0;
  try {
    for (;;) {
      const page = await api.pull(w.syncId ?? caseId, token, after, w.syncUrl);
      for (const envelope of page.records) {
        if (!await openRecord(w.caseKey, envelope)) continue;
        const key = `${envelope.collection}:${envelope.id}`;
        const rev = envelopeRevision(envelope);
        if (!onHost.has(key) || compareRevisions(rev, onHost.get(key)!) > 0) onHost.set(key, rev);
      }
      if (page.records.length === 0 || page.cursor >= page.head) break;
      after = page.cursor;
    }
  } catch (err) {
    if ((err as { status?: number }).status !== 404) {
      setTimeout(() => void repairHost(caseId), 30_000);
      return;
    }
  }
  const entries = await database.range<StoredRecord>(Keys.records(caseId));
  for (const entry of entries) {
    const key = `${entry.collection}:${entry.record.id}`;
    const local = entry.envelope ? envelopeRevision(entry.envelope) : LEGACY_REVISION;
    if (onHost.has(key) && compareRevisions(onHost.get(key)!, local) >= 0) continue;
    if (entry.envelope) {
      if (!workspace(caseId).outbox.some((queued) => queued.sealed.ct === entry.envelope!.sealed.ct)) await change(() => database.queue(caseId, [entry.envelope!], w.caseKey));
    } else {
      const envelope = await sealRecord(w.caseKey, entry.collection, entry.record as never, await database.reserveRevision(caseId, entry.collection, entry.record.id));
      assertSyncable(envelope);
      await change(() => database.save(entry, envelope, w.caseKey));
    }
  }
  if (workspace(caseId).outbox.length) await syncCase(caseId);
}

export function startSyncLoop(intervalMs = 8000) {
  const tick = () => {
    for (const w of state.workspaces) void syncCase(w.caseId);
  };
  const repairAll = () => {
    for (const w of state.workspaces) void repairHost(w.caseId);
  };
  repairAll();
  setInterval(repairAll, 5 * 60_000);
  tick();
  return setInterval(tick, intervalMs);
}

/** Stable snapshot for non-React consumers, including local backup and store regression tests. */
export const getSnapshot = () => state;


/**
 * Forget a case on this device: records, keys, outbox, research history, drafts and source
 * identities. Teammates and the sync host keep their copies; an invite or a backup brings it back.
 */
export async function removeCaseFromBrowser(caseId: string) {
  await change(() => database.purgeCase(caseId));
  clearCaseDrafts(caseId);
  forgetIdentities(caseId);
}

/** Case keys and complete records leave the browser only inside this passphrase-encrypted file. */
export async function backupCase(caseId: string, passphrase: string): Promise<string> {
  await localChanges;
  const w = workspace(caseId);
  const [records, history] = await Promise.all([database.range<StoredRecord>(Keys.records(caseId)), database.range<StoredResearch>(Keys.histories(caseId))]);
  return JSON.stringify(await encryptBackup({ v: 1, workspace: w, records, history }, passphrase));
}

export async function restoreCase(text: string, passphrase: string): Promise<string> {
  if (text.length > MAX_BACKUP_BYTES) throw new Error("Backup file exceeds 64 MiB");
  const value = await decryptBackup(JSON.parse(text) as unknown, passphrase) as { v?: unknown; workspace?: Workspace; records?: StoredRecord[]; history?: StoredResearch[] };
  const w = value?.workspace;
  if (value?.v !== 1 || !w || !/^[0-9a-f]{32}$/.test(w.caseId) || !/^[0-9a-f]{32}$/.test(w.memberId) || typeof w.caseKey !== "string" || fromBase64Url(w.caseKey).length !== 32 || !Number.isSafeInteger(w.cursor) || w.cursor < 0 || !Array.isArray(w.outbox) || !Array.isArray(value.records)) throw new Error("Invalid case backup");
  if (w.syncUrl) SyncHost.parse(w.syncUrl);
  for (const notice of w.notices ?? []) if (notice.host) SyncHost.parse(notice.host);
  if (w.memberKeys && (w.memberKeys.memberId !== w.memberId || memberIdForKey(w.memberKeys.publicKey) !== w.memberId || !await verifyValue(w.memberKeys.publicKey, await signValue(w.memberKeys, { caseId: w.caseId }), { caseId: w.caseId }))) throw new Error("Backup signing identity is invalid");
  const existing = state.workspaces.find((saved) => saved.caseId === w.caseId);
  if (existing && existing.caseKey !== w.caseKey) throw new Error("This case already exists with a different key; import into a separate browser profile");
  const seen = new Set<string>();
  const records: StoredRecord[] = [];
  for (const entry of value.records) {
    if (entry.caseId !== w.caseId || !Object.hasOwn(Collections, entry.collection)) throw new Error("Invalid case record in backup");
    const record = Collections[entry.collection].parse(entry.record) as { id: string; caseId?: string };
    if (entry.collection === "cases" ? record.id !== w.caseId : record.caseId !== undefined && record.caseId !== w.caseId) throw new Error("Backup contains another case's records");
    const key = `${entry.collection}:${record.id}`;
    if (seen.has(key)) throw new Error("Backup contains duplicate record ids");
    seen.add(key);
    let verified = false;
    if (entry.envelope) {
      const opened = await openRecord(w.caseKey, entry.envelope);
      if (!opened || w.requiresSignatures && !opened.auth || canonicalJson(opened.record) !== canonicalJson(record)) throw new Error("Backup revision does not match its signed record");
      verified = !!opened.auth;
    } else if (w.requiresSignatures) throw new Error("Signed backup is missing a record envelope");
    records.push({ ...entry, record, verified });
  }
  if (!records.some((entry) => entry.collection === "cases") || !records.some((entry) => entry.collection === "members" && entry.record.id === w.memberId)) throw new Error("Backup is missing the case or your membership");
  for (const envelope of w.outbox) if (!await openRecord(w.caseKey, envelope)) throw new Error("Invalid pending envelope in backup");
  const history = value.history ?? [];
  if (!Array.isArray(history) || history.some((entry) => !entry || entry.caseId !== w.caseId || !/^[0-9a-f]{32}$/.test(entry.id) || !entry.run || typeof entry.run.task !== "string" || !Array.isArray(entry.run.pieces) || !Array.isArray(entry.run.table) || !Array.isArray(entry.run.steps) || !Array.isArray(entry.run.blocked) || typeof entry.updatedAt !== "string")) throw new Error("Invalid research history in backup");
  const { outbox, ...metadata } = w;
  await change(() => database.restore(metadata, records, outbox, history));
  void syncCase(w.caseId);
  return w.caseId;
}


/** A fresh namespace prevents the previous case-token holder from reading or writing future data. */
export async function removeMember(caseId: string, memberId: string): Promise<void> {
  await syncCase(caseId);
  const w = workspace(caseId);
  const rec = state.cases[caseId]!;
  if (w.memberId !== rec.case.createdBy) throw new Error("Only the case creator can remove a member");
  if (memberId === w.memberId) throw new Error("The case creator cannot remove themselves");
  if (!rec.members.some((member) => member.id === memberId && !member.removedAt)) throw new Error("Unknown active member");
  if (w.outbox.length || w.syncError || w.needsInvite) throw new Error("Sync this case successfully before rotating its key");
  const key = generateCaseKey(), syncId = randomId(), epoch = (w.keyEpoch ?? 0) + 1;
  const entries = await database.range<StoredRecord>(Keys.records(caseId));
  const noticeRecord = { ...rec.case, keyEpoch: epoch, nextSyncId: syncId };
  const notice = await sealRecord(w.caseKey, "cases", noticeRecord, await database.reserveRevision(caseId, "cases", caseId), await signerFor(caseId, "cases", caseId));
  const records: StoredRecord[] = [];
  for (const entry of entries) {
    let record = entry.record;
    let envelope: Envelope;
    if (entry.collection === "members" && record.id === memberId) record = { ...record, removedAt: new Date().toISOString() } as Member;
    if (entry.collection === "cases") { const { nextSyncId: _, ...head } = record as Case; record = { ...head, keyEpoch: epoch } as Case; }
    if (record !== entry.record || !entry.envelope) envelope = await sealRecord(key, entry.collection, record as never, await database.reserveRevision(caseId, entry.collection, record.id), await signerFor(caseId, entry.collection, record.id));
    else envelope = await rekeyRecord(w.caseKey, key, entry.envelope);
    assertSyncable(envelope);
    records.push({ caseId, collection: entry.collection, record, envelope, echoPending: true, verified: !!(await openRecord(key, envelope))?.auth });
  }
  const { outbox: _, ...metadata } = w;
  const next: WorkspaceData = { ...metadata, caseKey: key, syncId, keyEpoch: epoch, cursor: 0, needsInvite: false, notices: [...(w.notices ?? []), { syncId: w.syncId ?? caseId, token: caseToken(w.caseKey), envelope: notice, ...(w.syncUrl ? { host: w.syncUrl } : {}) }] };
  await change(() => database.rotate(w, w.outbox, next, records, records.map((entry) => entry.envelope!)));
  await syncCase(caseId);
}

async function acceptRotatedInvite(invite: Invite): Promise<void> {
  const w = workspace(invite.caseId);
  if (!invite.syncId || !invite.keyEpoch || invite.keyEpoch <= (w.keyEpoch ?? 0)) throw new Error("This invite is older than your current case key");
  const incoming = new Map<string, StoredRecord>();
  let cursor = 0;
  for (;;) {
    const page = await api.pull(invite.syncId, caseToken(invite.caseKey), cursor, invite.host ?? w.syncUrl);
    for (const envelope of page.records) {
      const opened = await openRecord(invite.caseKey, envelope);
      if (!opened || (w.requiresSignatures || invite.requiresSignatures) && !opened.auth) throw new Error("Invalid record in rotated case");
      const record = opened.record as { id: string; caseId?: string };
      if (opened.collection === "cases" ? record.id !== invite.caseId : record.caseId !== undefined && record.caseId !== invite.caseId) throw new Error("Rotated invite contains another case");
      const key = `${opened.collection}:${record.id}`;
      const prior = incoming.get(key)?.envelope;
      if (!prior || compareRevisions(envelopeRevision(envelope), envelopeRevision(prior)) > 0) incoming.set(key, { caseId: invite.caseId, collection: opened.collection, record, envelope, echoPending: false, verified: !!opened.auth });
    }
    cursor = page.cursor;
    if (!page.records.length || cursor >= page.head) break;
  }
  const head = incoming.get(`cases:${invite.caseId}`)?.record as Case | undefined;
  const me = incoming.get(`members:${w.memberId}`)?.record as Member | undefined;
  if (!head || head.createdBy !== state.cases[invite.caseId]!.case.createdBy || head.keyEpoch !== invite.keyEpoch || !me || me.removedAt) throw new Error("This invite does not retain your membership in the current case");
  for (const entry of incoming.values()) {
    const opened = await openRecord(invite.caseKey, entry.envelope!);
    if (!opened || !authorizedRecord(opened, head.createdBy, !!(w.requiresSignatures || invite.requiresSignatures), [...incoming.values()].filter((entry) => entry.collection === "members").map((entry) => entry.record as Member))) throw new Error("Invalid authorship in rotated case");
  }
  const outbox: Envelope[] = [];
  const local = await database.range<StoredRecord>(Keys.records(invite.caseId));
  for (const entry of local) {
    if (entry.collection === "cases" || entry.collection === "members") continue;
    const key = `${entry.collection}:${entry.record.id}`;
    const remote = incoming.get(key);
    if (remote?.envelope && compareRevisions(envelopeRevision(remote.envelope), entry.envelope ? envelopeRevision(entry.envelope) : LEGACY_REVISION) >= 0) continue;
    const envelope = entry.envelope ? await rekeyRecord(w.caseKey, invite.caseKey, entry.envelope) : await sealRecord(invite.caseKey, entry.collection, entry.record as never, await database.reserveRevision(invite.caseId, entry.collection, entry.record.id));
    incoming.set(key, { ...entry, envelope, echoPending: true });
    outbox.push(envelope);
  }
  const { outbox: _, ...metadata } = w;
  await change(() => database.rotate(w, w.outbox, { ...metadata, caseKey: invite.caseKey, ...(invite.host ? { syncUrl: invite.host } : {}), syncId: invite.syncId!, keyEpoch: invite.keyEpoch!, cursor, needsInvite: false }, [...incoming.values()], outbox));
  void syncCase(invite.caseId);
}
