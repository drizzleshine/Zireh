import { caseToken, inviteFragment, newCase, newMember, type CaseRecords, type Invite } from "@zireh/cases";
import { generateCaseKey } from "@zireh/crypto";
import type { Case, CollectionName, Member, PrivacyLevel, Pseudonym, RecordOf } from "@zireh/schema";
import { compareRevisions, envelopeRevision, LEGACY_REVISION, assertSyncable, takeSyncBatch, openRecord, sealRecord, type Envelope } from "@zireh/sync";
import { get } from "idb-keyval";
import { database, type StoredRecord, type WorkspaceData } from "./persistence.ts";
import { useRef, useSyncExternalStore } from "react";
import { api } from "./api.ts";

/**
 * Local-first case storage. Records live in this browser (IndexedDB) and sync to the team
 * as sealed envelopes through the daemon. The case key never leaves the device except
 * inside an invite link fragment.
 */

interface Workspace extends WorkspaceData { readonly outbox: Envelope[] }

type Records = { -readonly [K in keyof CaseRecords]: CaseRecords[K] extends readonly (infer T)[] ? T[] : CaseRecords[K] };

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
  const entries = await database.entries();
  const workspaces = entries.filter(([key]) => key.startsWith("workspace:")).map(([, value]) => {
    const saved = value as WorkspaceData;
    return { ...saved, outbox: entries.filter(([key]) => key.startsWith(`outbox:${saved.caseId}:`)).map(([, envelope]) => envelope as Envelope) };
  });
  const records = entries.filter(([key]) => key.startsWith("record:")).map(([, value]) => value as StoredRecord);
  const cases: Record<string, Records> = {};
  for (const entry of records) if (entry.collection === "cases") cases[entry.caseId] = emptyRecords(entry.record as Case);
  for (const entry of records) if (cases[entry.caseId]) cases[entry.caseId] = apply(cases[entry.caseId]!, entry.collection, entry.record, true);
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

/** Save a record locally and queue it, sealed, for the team. */
export async function save<C extends CollectionName>(caseId: string, collection: C, record: RecordOf<C>) {
  if (!state.cases[caseId]) throw new Error("unknown case");
  const w = workspace(caseId);
  const envelope = await sealRecord(w.caseKey, collection, record, await database.reserveRevision(caseId, collection, (record as { id: string }).id));
  assertSyncable(envelope);
  await change(() => database.save({ caseId, collection, record: record as { id: string } }, envelope));
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
  const member = newMember(input.memberName);
  const c = newCase({ title: input.title, question: input.question, privacy: input.privacy, createdBy: member.id });
  const w = { caseId: c.id, caseKey: generateCaseKey(), memberId: member.id, cursor: 0 };
  const envelope = await sealRecord(w.caseKey, "cases", c, await database.reserveRevision(c.id, "cases", c.id));
  await change(async () => { await database.putWorkspace(w); await database.save({ caseId: c.id, collection: "cases", record: c }, envelope); });
  await save(c.id, "members", member);
  return c.id;
}

/** Join from an invite: pull the case, then add yourself as a member. */
export async function joinCase(invite: Invite, memberName: string): Promise<string> {
  if (state.workspaces.some((w) => w.caseId === invite.caseId)) return invite.caseId;
  const member: Member = newMember(memberName);
  await change(() => database.putWorkspace({ caseId: invite.caseId, caseKey: invite.caseKey, memberId: member.id, cursor: 0 }));
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

export const inviteLink = (caseId: string): string => {
  const w = workspace(caseId);
  return `${location.origin}/#${inviteFragment({ caseId, caseKey: w.caseKey })}`;
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
    while (workspace(caseId).outbox.length) {
      let batch = takeSyncBatch(workspace(caseId).outbox);
      let cursor: number;
      for (;;) {
        try { ({ cursor } = await api.push(caseId, token, batch)); break; }
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
        pulled = await api.pull(caseId, token, workspace(caseId).cursor);
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
      const opened = (await Promise.all(pulled.records.map(async (envelope) => {
        const opened = await openRecord(w.caseKey, envelope);
        if (!opened) return undefined;
        const record = opened.record as { id: string; caseId?: string };
        if (opened.collection === "cases" ? record.id !== caseId : record.caseId !== undefined && record.caseId !== caseId) return undefined;
        return { ...opened, envelope };
      }))).filter((entry) => entry !== undefined);
      if (!state.cases[caseId] && !opened.some((entry) => entry.collection === "cases")) return;
      await change(() => database.pull(caseId, opened.map((entry) => ({ caseId, collection: entry.collection, record: entry.record as { id: string }, envelope: entry.envelope })), pulled.cursor, pulled.records.length - opened.length));
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
  const onHost = new Map<string, ReturnType<typeof envelopeRevision>>();
  let after = 0;
  try {
    for (;;) {
      const page = await api.pull(caseId, token, after);
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
  const entries = (await database.entries()).filter(([key]) => key.startsWith(`record:${caseId}:`)).map(([, value]) => value as StoredRecord);
  for (const entry of entries) {
    const key = `${entry.collection}:${entry.record.id}`;
    const local = entry.envelope ? envelopeRevision(entry.envelope) : LEGACY_REVISION;
    if (onHost.has(key) && compareRevisions(onHost.get(key)!, local) >= 0) continue;
    if (entry.envelope) {
      if (!workspace(caseId).outbox.some((queued) => queued.sealed.ct === entry.envelope!.sealed.ct)) await change(() => database.queue(caseId, [entry.envelope!]));
    } else {
      const envelope = await sealRecord(w.caseKey, entry.collection, entry.record as never, await database.reserveRevision(caseId, entry.collection, entry.record.id));
      assertSyncable(envelope);
      await change(() => database.save(entry, envelope));
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
