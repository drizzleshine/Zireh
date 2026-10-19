import { chatJson, type ChatModel } from "@zireh/llm";
import { z } from "zod";

export const MAX_PIECES = 4;

const Plan = z.object({
  pieces: z.array(z.string().trim().min(8).max(600)).min(1).max(MAX_PIECES),
});

const SPLIT_PROMPT = (max: number) =>
  max === 1
    ? `Rewrite the user's request as one clear, self-contained question for an expert.
Keep every detail needed to answer. Add nothing. Keep any [BRACKETED] placeholder exactly as written.
Reply with JSON only: {"pieces":["...?"]}`
    : `Split the user's request into 2 to ${max} separate questions for an expert.
Each question must make sense alone and ask about one aspect, so that no single question
describes the whole situation. Add nothing. Keep any [BRACKETED] placeholder exactly as written.
Reply with JSON only: {"pieces":["...?","...?"]}`;

/** Rewrite a task as self-contained questions. `maxPieces` 1 means "rewrite, don't split". */
export async function splitTask(model: ChatModel, task: string, maxPieces = MAX_PIECES): Promise<string[]> {
  const plan = await chatJson(
    model,
    [
      { role: "system", content: SPLIT_PROMPT(maxPieces) },
      { role: "user", content: task },
    ],
    Plan,
    { maxTokens: 700, temperature: 0.2 },
  );
  return [...new Set(plan.pieces)].slice(0, maxPieces);
}

export interface PieceAnswer {
  readonly label: string; // "A1", "A2", …
  readonly question: string;
  readonly answer: string;
}

export interface Reassembled {
  readonly text: string;
  readonly cited: string[]; // labels the answer actually uses
  readonly invalidCitations: string[]; // labels the model made up
  readonly uncited: string[]; // pieces the final answer ignored
}

const REASSEMBLE_PROMPT = `You combine answers to sub-questions into one answer to the researcher's task.
Use only the information in the answers below. After each claim, cite the answer it came from
like [A1]. If the answers conflict or leave gaps, say so plainly. Keep placeholders like [PERSON_1].`;

/**
 * Local synthesis of piece answers. Citations are checked in code, never trusted: a label
 * that doesn't exist is reported, so the UI can flag the claim instead of showing it as sourced.
 */
export async function reassemble(
  model: ChatModel,
  task: string,
  answers: readonly PieceAnswer[],
): Promise<Reassembled> {
  if (answers.length === 1) {
    const only = answers[0]!;
    return { text: only.answer, cited: [only.label], invalidCitations: [], uncited: [] };
  }
  const material = answers.map((a) => `[${a.label}] Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
  const { content } = await model.chat(
    [
      { role: "system", content: REASSEMBLE_PROMPT },
      { role: "user", content: `Task: ${task}\n\n${material}` },
    ],
    { maxTokens: 1200, temperature: 0.2 },
  );
  return checkCitations(content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(), answers);
}

export function checkCitations(text: string, answers: readonly PieceAnswer[]): Reassembled {
  const valid = new Set(answers.map((a) => a.label));
  const used = [...new Set([...text.matchAll(/\[(A\d+)\]/g)].map((m) => m[1]!))];
  return {
    text,
    cited: used.filter((l) => valid.has(l)),
    invalidCitations: used.filter((l) => !valid.has(l)),
    uncited: [...valid].filter((l) => !used.includes(l)),
  };
}
