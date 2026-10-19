import { chatJson, type ChatModel } from "@zireh/llm";
import { EntityKind, type Pseudonym } from "@zireh/schema";
import { z } from "zod";
import { detectPatterns, type Detection } from "./detect.ts";
import { applyTable, extendTable } from "./table.ts";

const Entities = z.object({
  entities: z
    .array(z.object({ text: z.string().min(1), kind: EntityKind.catch("other"), hint: z.string().max(80).optional().catch(undefined) }))
    .max(200),
});

const PROMPT = `You find identifying details in text so they can be hidden.
List every person name, organization, specific place (street, building, port, city), date tied
to an event, ID or account number, contact detail, and exact money amount.
Copy each one exactly as written. Do NOT list topics, crimes, activities, job titles or common nouns.
For each, add a vague "hint" that is true of thousands of others and never contains the name,
e.g. "a newspaper", "a large city in Nigeria", "a major seaport", "an investigative journalist".
Kinds: person, org, place, id, contact, date, money, other.
Reply with JSON only: {"entities":[{"text":"...","kind":"person","hint":"..."}]}`;

export interface RedactResult {
  readonly text: string; // safe to send
  readonly table: Pseudonym[]; // updated case table
  readonly added: Pseudonym[]; // new substitutions from this call
}

/**
 * Pseudonymize `text` with the case table. Pattern detectors always run; the local model
 * adds names, places and organizations. If the model fails, this throws: callers fail closed.
 */
export async function redactText(
  model: ChatModel,
  text: string,
  table: readonly Pseudonym[],
): Promise<RedactResult> {
  const found = await chatJson(
    model,
    [
      { role: "system", content: PROMPT },
      { role: "user", content: text },
    ],
    Entities,
    { maxTokens: 800, temperature: 0 },
  );
  // Keep only entities that really occur in the text (models sometimes paraphrase).
  const lower = text.toLowerCase();
  const fromModel: Detection[] = found.entities
    .filter((e) => lower.includes(e.text.trim().toLowerCase()))
    .map((e) => ({ text: e.text, kind: e.kind, ...(e.hint ? { hint: e.hint } : {}) }));
  const nextTable = extendTable(table, [...detectPatterns(text), ...fromModel]);
  return {
    text: applyTable(text, nextTable),
    table: nextTable,
    added: nextTable.slice(table.length),
  };
}
