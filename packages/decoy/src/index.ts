import { chatJson, JsonReplyError, type ChatModel } from "@zireh/llm";
import { z } from "zod";

const PROMPT = (n: number) => `Write ${n} questions that different people might ask an AI assistant, each on a
completely different topic (health, law, money, work, science, history, travel, family).
Each should be about as long as the example and just as serious in tone, and sound natural.
Do not reuse the example's words, quotes or sentence structure. Never use bracketed placeholders.
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

const ATTEMPTS = 4;

/**
 * Plausible decoys for one real piece. Small models sometimes echo the real question back,
 * so this asks for a few extra, keeps only usable ones (not too short/long, not a near-copy,
 * no invented placeholders) and tries again until it has `n`. Fewer than `n` is an error:
 * the caller sends nothing rather than fewer decoys than the level promises.
 */
export async function makeDecoys(model: ChatModel, realQuestion: string, n: number, accept: (text: string) => boolean = () => true): Promise<string[]> {
  if (n === 0) return [];
  const Reply = z.object({ decoys: z.array(z.string().trim().max(800)).min(1) });
  const real = realQuestion.trim().toLowerCase();
  const usable: string[] = [];
  for (let attempt = 0; attempt < ATTEMPTS && usable.length < n; attempt++) {
    let decoys: string[];
    try {
      ({ decoys } = await chatJson(
        model,
        [
          { role: "system", content: PROMPT(n + 2) },
          { role: "user", content: `Example: ${realQuestion}` },
        ],
        Reply,
        { maxTokens: 300 + 200 * (n + 2), temperature: 0.9 + 0.1 * attempt },
      ));
    } catch (err) {
      if (err instanceof JsonReplyError) continue; // a malformed reply is just an unusable attempt
      throw err;
    }
    for (const d of decoys) {
      const ok = d.toLowerCase() !== real && lengthOk(d, realQuestion) && placeholdersOk(d, realQuestion) && !tooSimilar(d, realQuestion);
      if (ok && accept(d) && !usable.some((u) => u.toLowerCase() === d.toLowerCase() || tooSimilar(u, d))) usable.push(d);
    }
  }
  if (usable.length < n) throw new Error(`decoy: only ${usable.length} of ${n} decoys were usable`);
  return usable.slice(0, n);
}
