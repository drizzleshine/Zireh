import { useCallback, useSyncExternalStore } from "react";
import { database, Keys } from "./persistence.ts";

/**
 * Everything typed but not yet saved, as one object: { [caseId]: { [field]: value } }.
 * Components point at a field ("evidence.intake", "comment.<id>", "conclude.summary") and read
 * and write only that, so anything showing the same field updates together. It lives in the same
 * browser database as the case itself (not localStorage), is saved shortly after typing stops,
 * and a field is removed once what it held is submitted.
 */
type Drafts = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const SAVE_AFTER_MS = 400;
const KEY = Keys.drafts;

let drafts: Drafts = {};
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const emit = () => {
  for (const l of listeners) l();
};

function persist(caseId: string) {
  clearTimeout(timers.get(caseId));
  timers.set(
    caseId,
    setTimeout(() => {
      timers.delete(caseId);
      const fields = drafts[caseId];
      void database
        .write((store) => {
          if (fields && Object.keys(fields).length) store.put(fields, KEY(caseId));
          else store.delete(KEY(caseId));
        })
        .catch(() => {
          /* still in memory; the next change tries again */
        });
    }, SAVE_AFTER_MS),
  );
}

/**
 * Set one field; `undefined` removes it. An empty string is kept on purpose: clearing a box that
 * started from saved text must stay cleared, not spring back to the saved text.
 */
export function setDraft(caseId: string, field: string, value: unknown) {
  const { [field]: _old, ...rest } = drafts[caseId] ?? {};
  drafts = { ...drafts, [caseId]: value === undefined ? rest : { ...rest, [field]: value } };
  emit();
  persist(caseId);
}

export const clearDraft = (caseId: string, field: string) => setDraft(caseId, field, undefined);

/** Drop every draft for a case, e.g. when it is removed from this browser. */
export function clearCaseDrafts(caseId: string) {
  const { [caseId]: _gone, ...rest } = drafts;
  drafts = rest;
  emit();
  persist(caseId);
}

// Load what was left last time. Anything typed before loading finished wins over the stored copy.
if (typeof indexedDB !== "undefined") {
  void database.rangeEntries<Record<string, unknown>>(Keys.allDrafts).then(
    (entries) => {
      let changed = false;
      for (const [key, value] of entries) {
        if (!value || typeof value !== "object") continue;
        const caseId = key.slice(Keys.allDrafts.length);
        drafts = { ...drafts, [caseId]: { ...value, ...drafts[caseId] } };
        changed = true;
      }
      if (changed) emit();
    },
    () => {},
  );
}

/** Read and write one draft field; `fallback` is shown while there is no draft (e.g. the saved text). */
export function useDraft<T>(caseId: string, field: string, fallback: T): [T, (value: T) => void, () => void] {
  const stored = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => drafts[caseId]?.[field],
    () => drafts[caseId]?.[field],
  );
  const set = useCallback((value: T) => setDraft(caseId, field, value), [caseId, field]);
  const clear = useCallback(() => clearDraft(caseId, field), [caseId, field]);
  return [stored === undefined ? fallback : (stored as T), set, clear];
}

/** For tests: what is held right now. */
export const draftsSnapshot = (): Drafts => drafts;
