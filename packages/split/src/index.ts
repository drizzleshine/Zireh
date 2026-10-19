import { chatJson, type ChatModel } from "@zireh/llm";
import { z } from "zod";

export const MAX_PIECES = 4;

const Plan = z.object({
  pieces: z.array(z.string().trim().min(8).max(600)).min(1).max(MAX_PIECES),
});

const SPLIT_PROMPT = `You protect a researcher's privacy. Their task will be sent to an outside AI.
Rewrite it as 1 to ${MAX_PIECES} separate general questions that together give everything needed,
where no single question reveals the full situation or who it is about.
Each question must make sense alone, keep placeholders like [PERSON_1] unchanged, and add no new facts.
If the task cannot be split without losing meaning, return it as a single question.
Reply with JSON only: {"pieces":["...","..."]}`;

/** Break a redacted task into independent pieces. One piece means "not splittable". */
export async function splitTask(model: ChatModel, redactedTask: string): Promise<string[]> {
  const plan = await chatJson(
    model,
    [
      { role: "system", content: SPLIT_PROMPT },
      { role: "user", content: redactedTask },
    ],
    Plan,
    { maxTokens: 700, temperature: 0.2 },
  );
  return [...new Set(plan.pieces)];
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
