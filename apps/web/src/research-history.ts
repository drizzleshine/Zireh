import type { PlannedPiece, PrivacyLevel, Pseudonym, ResearchEvent, TraceStep } from "@zireh/schema";
import { database } from "./persistence.ts";
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
}


export interface StoredResearch { id: string; caseId: string; updatedAt: string; run: Run }
export async function saveResearch(caseId: string, id: string, run: Run): Promise<void> {
  const record: StoredResearch = { id, caseId, updatedAt: new Date().toISOString(), run };
  await database.write((store) => { store.put(record, `history:${caseId}:${id}`); });
}
export async function researchHistory(caseId: string): Promise<StoredResearch[]> {
  return (await database.entries()).filter(([key]) => key.startsWith(`history:${caseId}:`)).map(([, value]) => value as StoredResearch).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
      const key = `history:${caseId}:${id}`;
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
