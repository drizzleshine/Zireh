import { chatJson, type ChatModel } from "@zireh/llm";
import type { Pseudonym } from "@zireh/schema";
import { z } from "zod";

const Assessment = z.object({
  score: z.number().min(0).max(100),
  inferences: z.array(z.string().max(300)).max(10),
});

const PROMPT = `You are an AI provider that received the message below from an anonymous user.
Try to work out who the user is or who they are asking about: name, organization, exact location,
job, or a specific real event. Placeholders like [PERSON_1] are hidden values and reveal nothing.
Score 0 if nothing specific can be inferred, 100 if a specific person or event is clearly identifiable.
Reply with JSON only: {"score": 0-100, "inferences": ["what you could infer", ...]}`;

export interface LeakReport {
  readonly score: number;
  readonly inferences: string[];
  readonly leakedOriginals: string[]; // values from the case table found verbatim
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The local model plays the provider and guesses what it could infer. A deterministic floor
 * sits under the model: any original from the pseudonym table in the text scores 100.
 */
export async function checkLeak(model: ChatModel, outbound: string, table: readonly Pseudonym[]): Promise<LeakReport> {
  const leakedOriginals = table
    .filter((p) => new RegExp(`(^|\\W)${escape(p.original)}($|\\W)`, "i").test(outbound))
    .map((p) => p.original);
  if (leakedOriginals.length > 0) {
    return { score: 100, inferences: leakedOriginals.map((o) => `Contains the hidden value "${o}"`), leakedOriginals };
  }
  const assessment = await chatJson(
    model,
    [
      { role: "system", content: PROMPT },
      { role: "user", content: outbound },
    ],
    Assessment,
    { maxTokens: 400, temperature: 0 },
  );
  return { score: Math.round(assessment.score), inferences: assessment.inferences, leakedOriginals };
}

export const passes = (report: LeakReport, threshold: number): boolean =>
  report.leakedOriginals.length === 0 && report.score <= threshold;

const Rewrite = z.object({ text: z.string().trim().min(8).max(2000) });

const GENERALIZE_PROMPT = `Rewrite the message so it asks for the same help but reveals less about who
is asking or who it concerns. Remove or generalize the details listed as inferable. Keep placeholders
like [PERSON_1] unchanged. Reply with JSON only: {"text":"..."}`;

/** One attempt to make a risky piece less identifying. The caller re-checks the result. */
export async function generalize(model: ChatModel, outbound: string, report: LeakReport): Promise<string> {
  const { text } = await chatJson(
    model,
    [
      { role: "system", content: GENERALIZE_PROMPT },
      { role: "user", content: `Message: ${outbound}\nInferable: ${report.inferences.join("; ") || "none listed"}` },
    ],
    Rewrite,
    { maxTokens: 600, temperature: 0.2 },
  );
  return text;
}
