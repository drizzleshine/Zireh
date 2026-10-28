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

/** Ordinary questions on unrelated topics, for when no on-device model can write fresh ones. */
export const STOCK: readonly string[] = [
  "Which soils hold water best for growing maize in a dry season?",
  "How long should sourdough proof in a cold kitchen before baking?",
  "What are the rules for keeping chickens in a backyard in a city?",
  "How do I tell if a used car's timing belt needs replacing?",
  "What is the safest way to store breast milk at room temperature?",
  "How do pension contributions affect my take-home pay?",
  "What causes a persistent dry cough after a cold has cleared up?",
  "How do I get a tenancy deposit back if the landlord won't answer?",
  "Which houseplants are safe to keep around cats?",
  "How should I prepare for a job interview at a small charity?",
  "What is the difference between a will and a living trust?",
  "How do I stop condensation building up on bedroom windows?",
  "Why did the Roman Empire split into eastern and western halves?",
  "How much water should a ten-year-old drink on a hot day?",
  "What should I pack for a week of hiking in rainy mountains?",
  "How can a small shop accept card payments without a big monthly fee?",
  "What are good beginner exercises for lower back pain?",
  "How do vaccines for seasonal flu get updated every year?",
  "How do I explain fractions to a child who finds them confusing?",
  "Is it worth repairing a cracked phone screen or replacing the phone?",
  "What paperwork do I need to register a newborn's birth?",
  "How do solar panels perform on cloudy days?",
  "What is a fair way to split rent between housemates with different rooms?",
  "How can I improve my credit score after missing a payment?",
  "Which spices go well with roasted sweet potatoes?",
  "How do tides work, and why are there two a day?",
  "What should I check before signing a gym membership contract?",
  "How do I teach an older dog to walk calmly on a lead?",
  "What are the early signs of burnout at work?",
  "How long does it take to learn to read music as an adult?",
];

/** `n` stock decoys in random order that pass the same checks as model-written ones. */
export function stockDecoys(realQuestion: string, n: number, accept: (text: string) => boolean = () => true, random: () => number = Math.random): string[] {
  if (n === 0) return [];
  const pool = [...STOCK].sort(() => random() - 0.5);
  const usable: string[] = [];
  for (const d of pool) {
    if (usable.length === n) break;
    if (!tooSimilar(d, realQuestion) && accept(d) && !usable.some((u) => tooSimilar(u, d))) usable.push(d);
  }
  if (usable.length < n) throw new Error(`decoy: only ${usable.length} of ${n} stock decoys were usable`);
  return usable;
}
