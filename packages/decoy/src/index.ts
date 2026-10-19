import { chatJson, type ChatModel } from "@zireh/llm";
import { z } from "zod";

const PROMPT = (n: number) => `Write ${n} decoy questions for privacy cover traffic.
Each decoy must look like it was written by the same kind of person as the real question:
similar length, tone and level of detail, a believable research topic, but about a clearly
different subject with different key words. Never invent bracketed placeholders.
Reply with JSON only: {"decoys":["...", ...]}`;

const lengthOk = (decoy: string, real: string) => decoy.length >= real.length * 0.4 && decoy.length <= real.length * 2.5;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/**
 * A decoy that shares most words with the real question points straight at it
 * ("Does he work for a newspaper?" next to "Does she work for a newspaper?").
 */
export const tooSimilar = (decoy: string, real: string): boolean => {
  const a = words(decoy);
  const b = words(real);
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / Math.max(1, Math.min(a.size, b.size)) > 0.6;
};

/** A decoy may only use placeholders the real question uses; anything else gives it away. */
const placeholdersOk = (decoy: string, real: string) => {
  const allowed = new Set(real.match(/\[[A-Z_]+\d*\]/g) ?? []);
  return (decoy.match(/\[[^\]]*\]/g) ?? []).every((p) => allowed.has(p));
};

/**
 * Plausible decoys for one real piece. Decoys that are too short/long (and therefore easy to
 * tell apart) or that repeat the real question are discarded; fewer than `n` is an error.
 */
export async function makeDecoys(model: ChatModel, realQuestion: string, n: number): Promise<string[]> {
  if (n === 0) return [];
  const Reply = z.object({ decoys: z.array(z.string().trim().max(800)).min(n) });
  const { decoys } = await chatJson(
    model,
    [
      { role: "system", content: PROMPT(n) },
      { role: "user", content: `Real question: ${realQuestion}` },
    ],
    Reply,
    { maxTokens: 300 + 200 * n, temperature: 0.9 },
  );
  const real = realQuestion.trim().toLowerCase();
  const usable = [...new Set(decoys)].filter((d) => d.toLowerCase() !== real && lengthOk(d, realQuestion) && placeholdersOk(d, realQuestion) && !tooSimilar(d, realQuestion));
  if (usable.length < n) throw new Error(`decoy: only ${usable.length} of ${n} decoys were usable`);
  return usable.slice(0, n);
}
