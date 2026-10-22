import { caseToken, inviteFragment, newCase, newMember, type CaseRecords, type Invite } from "@zireh/cases";
import { generateCaseKey } from "@zireh/crypto";
import type { Case, CollectionName, Member, PrivacyLevel, Pseudonym, RecordOf } from "@zireh/schema";
import { openRecord, sealRecord, type Envelope } from "@zireh/sync";
import { get, set } from "idb-keyval";
import { useRef, useSyncExternalStore } from "react";
import { api } from "./api.ts";

/**
 * Local-first case storage. Records live in this browser (IndexedDB) and sync to the team
 * as sealed envelopes through the daemon. The case key never leaves the device except
 * inside an invite link fragment.
 */

interface Workspace {
  readonly caseId: string;
  readonly caseKey: string;
  readonly memberId: string;
  cursor: number;
  outbox: Envelope[];
  syncedAt?: string;
  syncError?: string;
}

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

async function persist(caseId?: string) {
  await set("workspaces", state.workspaces);
  if (caseId && state.cases[caseId]) await set(`case:${caseId}`, state.cases[caseId]);
}

export async function load() {
  const workspaces = ((await get("workspaces")) as Workspace[] | undefined) ?? [];
  const cases: Record<string, Records> = {};
  for (const w of workspaces) {
    const rec = (await get(`case:${w.caseId}`)) as Records | undefined;
    if (rec) cases[w.caseId] = { ...emptyRecords(rec.case), ...rec }; // older saves lack newer collections
  }
  state = { loaded: true, workspaces, cases };
  emit();
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

function updateWorkspace(caseId: string, update: (current: Workspace) => Workspace) {
  state = { ...state, workspaces: state.workspaces.map((current) => current.caseId === caseId ? update(current) : current) };
}

function updateRecords(caseId: string, rec: Records) {
  state = { ...state, cases: { ...state.cases, [caseId]: rec } };
}

/** Save a record locally and queue it, sealed, for the team. */
export async function save<C extends CollectionName>(caseId: string, collection: C, record: RecordOf<C>) {
  const rec = state.cases[caseId];
  if (!rec) throw new Error("unknown case");
  const w = workspace(caseId);
  const envelope = await sealRecord(w.caseKey, collection, record);
  updateRecords(caseId, apply(state.cases[caseId]!, collection, record, true));
  updateWorkspace(caseId, (current) => ({ ...current, outbox: [...current.outbox, envelope] }));
  emit();
  await persist(caseId);
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
  state = { ...state, workspaces: [...state.workspaces, { caseId: c.id, caseKey: generateCaseKey(), memberId: member.id, cursor: 0, outbox: [] }] };
  updateRecords(c.id, emptyRecords(c));
  await save(c.id, "cases", c);
  await save(c.id, "members", member);
  return c.id;
}

/** Join from an invite: pull the case, then add yourself as a member. */
export async function joinCase(invite: Invite, memberName: string): Promise<string> {
  if (state.workspaces.some((w) => w.caseId === invite.caseId)) return invite.caseId;
  const member: Member = newMember(memberName);
  state = { ...state, workspaces: [...state.workspaces, { caseId: invite.caseId, caseKey: invite.caseKey, memberId: member.id, cursor: 0, outbox: [] }] };
  for (let attempt = 0; attempt < 3 && !state.cases[invite.caseId]; attempt++) await syncCase(invite.caseId);
  if (!state.cases[invite.caseId]) {
    state = { ...state, workspaces: state.workspaces.filter((w) => w.caseId !== invite.caseId) };
    emit();
    throw new Error("Couldn't open this case. The link may be wrong, or the case hasn't synced yet.");
  }
  await save(invite.caseId, "members", member);
  return invite.caseId;
}

/** Move one card on the board (shared with the team). */
export async function moveOnBoard(caseId: string, itemId: string, x: number, y: number) {
  await save(caseId, "board", { id: caseId, caseId, positions: { [itemId]: { x: Math.round(x), y: Math.round(y) } } });
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
  const task = syncOnce(caseId).finally(() => syncing.delete(caseId));
  syncing.set(caseId, task);
  return task;
}

async function syncOnce(caseId: string) {
  const w = workspace(caseId);
  const token = caseToken(w.caseKey);
  try {
    while (workspace(caseId).outbox.length) {
      const batch = workspace(caseId).outbox.slice(0, 200);
      const { cursor } = await api.push(caseId, token, batch);
      const pushed = new Set(batch.map((envelope) => envelope.sealed.ct));
      updateWorkspace(caseId, (current) => ({ ...current, outbox: current.outbox.filter((envelope) => !pushed.has(envelope.sealed.ct)) }));
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
      const opened = (await Promise.all(pulled.records.map((env) => openRecord(w.caseKey, env)))).filter((o) => o !== undefined);
      if (!state.cases[caseId]) {
        const head = opened.find((o) => o.collection === "cases");
        if (!head) return; // nothing usable yet; keep the cursor so these records are pulled again
        updateRecords(caseId, emptyRecords(head.record as Case));
      }
      let rec = state.cases[caseId]!;
      for (const o of opened) rec = apply(rec, o.collection, o.record);
      updateRecords(caseId, rec);
      updateWorkspace(caseId, (current) => ({ ...current, cursor: pulled.cursor }));
      if (pulled.records.length === 0 || pulled.cursor >= pulled.head) break;
    }
    updateWorkspace(caseId, ({ syncError: _, ...current }) => ({ ...current, syncedAt: new Date().toISOString() }));
  } catch (err) {
    updateWorkspace(caseId, (current) => ({ ...current, syncError: (err as Error).message }));
  } finally {
    emit();
    await persist(caseId);
  }

}

/** Every record this device holds for a case, as (collection, record) pairs. */
function allRecords(caseId: string): [CollectionName, { id: string }][] {
  const rec = state.cases[caseId];
  if (!rec) return [];
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
  const onHost = new Set<string>();
  let after = 0;
  try {
    for (;;) {
      const page = await api.pull(caseId, token, after);
      for (const r of page.records) onHost.add(`${r.collection}:${r.id}`);
      if (page.records.length === 0 || page.cursor >= page.head) break;
      after = page.cursor;
    }
  } catch (err) {
    if ((err as { status?: number }).status !== 404) {
      setTimeout(() => void repairHost(caseId), 30_000); // network trouble (Tor): try again shortly
      return;
    }
  }
  const queued = new Set(w.outbox.map((e) => `${e.collection}:${e.id}`));
  for (const [collection, record] of allRecords(caseId)) {
    const key = `${collection}:${record.id}`;
    if (!onHost.has(key) && !queued.has(key)) {
      const envelope = await sealRecord(w.caseKey, collection, record as never);
      updateWorkspace(caseId, (current) => ({ ...current, outbox: [...current.outbox, envelope] }));
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
