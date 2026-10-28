import { useSyncExternalStore } from "react";
import { saveResearch, type Run } from "../../research-history.ts";
import type { PrivacyLevel } from "@zireh/schema";

/**
 * The latest run per case lives outside the component, so it survives tab switches and keeps
 * receiving events while another tab is open.
 */
export interface RunSlot {
  run?: Run;
  runId?: string;
  running: boolean;
  historyError?: string;
  abort?: AbortController;
  draft?: { task: string; level: PrivacyLevel; contextIds: string[]; reviewBeforeSend?: boolean };
  /** The open thread: an id, "new" for a fresh one, or unset to show the latest. */
  thread?: string;
}
const slots = new Map<string, RunSlot>();
const slotListeners = new Set<() => void>();
const EMPTY: RunSlot = Object.freeze({ running: false }); // stable: snapshots must not change identity
const getSlot = (caseId: string): RunSlot => slots.get(caseId) ?? EMPTY;
export function setSlot(caseId: string, update: (s: RunSlot) => RunSlot) {
  const previous = getSlot(caseId);
  const next = update(previous);
  slots.set(caseId, next);
  for (const l of slotListeners) l();
  if (next.run && next.runId && (next.run !== previous.run || next.runId !== previous.runId)) {
    void saveResearch(caseId, next.runId, next.run).catch((error: Error) => {
      slots.set(caseId, { ...getSlot(caseId), historyError: `Could not save research history: ${error.message}` });
      for (const listener of slotListeners) listener();
    });
  }
}
export function useSlot(caseId: string): RunSlot {
  return useSyncExternalStore(
    (l) => {
      slotListeners.add(l);
      return () => {
        slotListeners.delete(l);
      };
    },
    () => getSlot(caseId),
  );
}
