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
    if (rec) cases[w.caseId] = rec;
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
};

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

function apply(rec: Records, collection: CollectionName, record: unknown) {
  if (collection === "cases") {
    rec.case = record as Case;
    return;
  }
  if (collection === "pseudonyms") {
    rec.pseudonyms = mergePseudonyms(rec.pseudonyms, (record as RecordOf<"pseudonyms">).entries);
    return;
  }
  const field = COLLECTION_FIELD[collection] as Exclude<keyof Records, "case" | "pseudonyms">;
  const list = rec[field] as { id: string }[];
  const item = record as { id: string };
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

/** Save a record locally and queue it, sealed, for the team. */
export async function save<C extends CollectionName>(caseId: string, collection: C, record: RecordOf<C>) {
  const rec = state.cases[caseId];
  if (!rec) throw new Error("unknown case");
  apply(rec, collection, record);
  const w = workspace(caseId);
  w.outbox.push(await sealRecord(w.caseKey, collection, record));
  emit();
  await persist(caseId);
  void syncCase(caseId);
}

export async function savePseudonyms(caseId: string, entries: Pseudonym[]) {
  const rec = state.cases[caseId];
  if (!rec) return;
  rec.pseudonyms = mergePseudonyms(rec.pseudonyms, entries);
  await save(caseId, "pseudonyms", { id: caseId, caseId, entries: rec.pseudonyms });
}

export async function createCase(input: { title: string; question: string; privacy: PrivacyLevel; memberName: string }): Promise<string> {
  const member = newMember(input.memberName);
  const c = newCase({ title: input.title, question: input.question, privacy: input.privacy, createdBy: member.id });
  state.workspaces.push({ caseId: c.id, caseKey: generateCaseKey(), memberId: member.id, cursor: 0, outbox: [] });
  state.cases[c.id] = { case: c, members: [], evidence: [], observations: [], findings: [], reviews: [], pseudonyms: [] };
  await save(c.id, "cases", c);
  await save(c.id, "members", member);
  return c.id;
}

/** Join from an invite: pull the case, then add yourself as a member. */
export async function joinCase(invite: Invite, memberName: string): Promise<string> {
  if (state.workspaces.some((w) => w.caseId === invite.caseId)) return invite.caseId;
  const member: Member = newMember(memberName);
  state.workspaces.push({ caseId: invite.caseId, caseKey: invite.caseKey, memberId: member.id, cursor: 0, outbox: [] });
  await syncCase(invite.caseId);
  if (!state.cases[invite.caseId]) {
    state.workspaces = state.workspaces.filter((w) => w.caseId !== invite.caseId);
    emit();
    throw new Error("Couldn't open this case. The link may be wrong, or the case hasn't synced yet.");
  }
  await save(invite.caseId, "members", member);
  return invite.caseId;
}

export const inviteLink = (caseId: string): string => {
  const w = workspace(caseId);
  return `${location.origin}/#${inviteFragment({ caseId, caseKey: w.caseKey })}`;
};

export const myMemberId = (caseId: string): string => workspace(caseId).memberId;

const syncing = new Set<string>();

/** Push queued envelopes, then pull and apply everything new. */
export async function syncCase(caseId: string) {
  if (syncing.has(caseId)) return;
  syncing.add(caseId);
  const w = workspace(caseId);
  const token = caseToken(w.caseKey);
  try {
    if (w.outbox.length) {
      const batch = w.outbox.slice(0, 200);
      await api.push(caseId, token, batch);
      w.outbox = w.outbox.slice(batch.length);
    }
    const pulled = await api.pull(caseId, token, w.cursor);
    for (const env of pulled.records) {
      const opened = await openRecord(w.caseKey, env);
      if (!opened) continue; // tampered or foreign: ignore
      let rec = state.cases[caseId];
      if (!rec) {
        if (opened.collection !== "cases") continue;
        rec = { case: opened.record as Case, members: [], evidence: [], observations: [], findings: [], reviews: [], pseudonyms: [] };
        state.cases[caseId] = rec;
      }
      apply(rec, opened.collection, opened.record);
    }
    w.cursor = pulled.cursor;
    w.syncedAt = new Date().toISOString();
    delete w.syncError;
  } catch (err) {
    w.syncError = (err as Error).message;
  } finally {
    syncing.delete(caseId);
    emit();
    await persist(caseId);
  }
}

export function startSyncLoop(intervalMs = 8000) {
  const tick = () => {
    for (const w of state.workspaces) void syncCase(w.caseId);
  };
  tick();
  return setInterval(tick, intervalMs);
}
