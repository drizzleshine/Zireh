import type { PlannedPiece, PrivacyLevel, Pseudonym, ResearchEvent, TraceStep } from "@zireh/schema";
import { database, Keys } from "./persistence.ts";
import { api } from "./api.ts";

export interface RecoveredAnswer { requestId: string; pieceId: string; content: string; charged: number; answerExpired: boolean }
export interface PieceState extends PlannedPiece {
  status: "planned" | "sent" | "answered" | "failed";
  circuit?: string;
  ms?: number;
  charged?: number;
  error?: string;
}

export interface Run {
  /** The thread this question belongs to. Older records have none: each is its own thread. */
  threadId?: string;
  askedAt?: string;
  evidenceIds?: string[];
  recoveredAnswers?: RecoveredAnswer[];
  recoveredSpent?: number;
  sourceTable?: string;
  prepared?: { estimatedCost: number };
  approved?: boolean;
  task: string;
  level: PrivacyLevel;
  steps: { step: TraceStep; atMs: number }[];
  table: readonly Pseudonym[];
  pieces: PieceState[];
  blocked: { question: string; score: number; inferences: string[] }[];
  done?: Extract<ResearchEvent, { type: "done" }>;
  error?: string;
  saved?: boolean;
  cancelled?: Extract<ResearchEvent, { type: "cancelled" }>;
  cancelling?: boolean;
  /** Written for the demo case: shown as an example, never sent anywhere. */
  example?: boolean;
}


export interface StoredResearch { id: string; caseId: string; updatedAt: string; run: Run }

export interface Thread {
  readonly id: string;
  readonly turns: StoredResearch[]; // oldest first
  readonly updatedAt: string;
  readonly spent: number;
}

const askedAt = (r: StoredResearch) => r.run.askedAt ?? r.updatedAt;

/** Groups saved questions into threads, newest thread first. Old records become one-question threads. */
export function threadsOf(records: readonly StoredResearch[]): Thread[] {
  const groups = new Map<string, StoredResearch[]>();
  for (const r of records) {
    const id = r.run.threadId ?? r.id;
    groups.set(id, [...(groups.get(id) ?? []), r]);
  }
  return [...groups]
    .map(([id, turns]) => {
      const sorted = [...turns].sort((a, b) => askedAt(a).localeCompare(askedAt(b)));
      return {
        id,
        turns: sorted,
        updatedAt: sorted.reduce((latest, t) => (t.updatedAt > latest ? t.updatedAt : latest), ""),
        spent: sorted.reduce((n, t) => n + (t.run.done?.spent ?? t.run.cancelled?.spent ?? t.run.recoveredSpent ?? 0), 0),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The answer a turn produced, if any: complete, or the parts recovered after an interruption. */
export function answerOf(run: Run, restoreText: (text: string) => string): string | undefined {
  if (run.done) return run.done.outcome.answer;
  const recovered = run.recoveredAnswers?.filter((a) => !a.answerExpired).map((a) => restoreText(a.content));
  return recovered?.length ? recovered.join("\n\n") : undefined;
}
export async function saveResearch(caseId: string, id: string, run: Run): Promise<void> {
  const record: StoredResearch = { id, caseId, updatedAt: new Date().toISOString(), run };
  await database.write((store) => { store.put(record, Keys.history(caseId, id)); });
}
/** Tells open Research panels to reload, for history written outside them (the demo's example). */
const historyListeners = new Set<(caseId: string) => void>();
export function onHistoryAdded(listener: (caseId: string) => void): () => void {
  historyListeners.add(listener);
  return () => void historyListeners.delete(listener);
}
export function announceHistory(caseId: string) {
  for (const listener of historyListeners) listener(caseId);
}
export async function researchHistory(caseId: string): Promise<StoredResearch[]> {
  return (await database.range<StoredResearch>(Keys.histories(caseId))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function reconcileResearch(caseId: string): Promise<StoredResearch[]> {
  const history = await researchHistory(caseId);
  let results: Awaited<ReturnType<typeof api.researchResults>>["results"];
  try { ({ results } = await api.researchResults(caseId)); } catch { return history; }
  const groups = new Map<string, typeof results>();
  for (const result of results) groups.set(result.runId, [...(groups.get(result.runId) ?? []), result]);
  for (const [id, pieces] of groups) {
    const existing = history.find((record) => record.id === id);
    if (existing?.run.done || existing?.run.cancelled) continue;
    const fallback: Run = { task: "Recovered research", level: "private", table: [], pieces: pieces.map((piece) => ({ id: piece.pieceId, role: "real", question: piece.question, wire: piece.question, status: "answered" })), steps: [], blocked: [] };
    const answers = pieces.map(({ requestId, pieceId, content, charged, answerExpired }) => ({ requestId, pieceId, content, charged, answerExpired }));
    await database.write((store) => {
      const key = Keys.history(caseId, id);
      const request = store.get(key);
      request.onsuccess = () => {
        const latest = request.result as StoredResearch | undefined;
        if (latest?.run.done || latest?.run.cancelled || JSON.stringify(latest?.run.recoveredAnswers) === JSON.stringify(answers)) return;
        const run = { ...(latest?.run ?? fallback), recoveredAnswers: answers, recoveredSpent: Math.max(...pieces.map((piece) => piece.runSpent)) };
        store.put({ id, caseId, updatedAt: new Date().toISOString(), run } satisfies StoredResearch, key);
      };
    });
  }
  return researchHistory(caseId);
}
