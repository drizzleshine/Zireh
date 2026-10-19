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

const ATTEMPTS = 3;

/**
 * Plausible decoys for one real piece. Small models sometimes echo the real question back,
 * so this asks for a few extra, keeps only usable ones (not too short/long, not a near-copy,
 * no invented placeholders) and tries again until it has `n`. Fewer than `n` is an error:
 * the caller sends nothing rather than fewer decoys than the level promises.
 */
export async function makeDecoys(model: ChatModel, realQuestion: string, n: number): Promise<string[]> {
  if (n === 0) return [];
  const Reply = z.object({ decoys: z.array(z.string().trim().max(800)).min(1) });
  const real = realQuestion.trim().toLowerCase();
  const usable: string[] = [];
  for (let attempt = 0; attempt < ATTEMPTS && usable.length < n; attempt++) {
    const { decoys } = await chatJson(
      model,
      [
        { role: "system", content: PROMPT(n + 2) },
        { role: "user", content: `Real question: ${realQuestion}` },
      ],
      Reply,
      { maxTokens: 300 + 200 * (n + 2), temperature: 0.9 + 0.1 * attempt },
    );
    for (const d of decoys) {
      const ok = d.toLowerCase() !== real && lengthOk(d, realQuestion) && placeholdersOk(d, realQuestion) && !tooSimilar(d, realQuestion);
      if (ok && !usable.some((u) => u.toLowerCase() === d.toLowerCase() || tooSimilar(u, d))) usable.push(d);
    }
  }
  if (usable.length < n) throw new Error(`decoy: only ${usable.length} of ${n} decoys were usable`);
  return usable.slice(0, n);
}
