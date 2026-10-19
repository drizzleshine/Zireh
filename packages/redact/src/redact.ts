import { chatJson, type ChatModel } from "@zireh/llm";
import { EntityKind, type Pseudonym } from "@zireh/schema";
import { z } from "zod";
import { detectPatterns, type Detection } from "./detect.ts";
import { applyTable, extendTable } from "./table.ts";

const Entities = z.object({
  entities: z.array(z.object({ text: z.string().min(1), kind: EntityKind.catch("other") })).max(200),
});

const PROMPT = `You find identifying details in text so they can be hidden.
List every person name, organization, specific place (city, street, building, country when it
identifies someone), date tied to an event, ID or account number, contact detail, and money amount.
Copy each one exactly as written. Do not list generic words.
Kinds: person, org, place, id, contact, date, money, other.
Reply with JSON only: {"entities":[{"text":"...","kind":"person"}]}`;

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
  const fromModel: Detection[] = found.entities.filter((e) => lower.includes(e.text.trim().toLowerCase()));
  const nextTable = extendTable(table, [...detectPatterns(text), ...fromModel]);
  return {
    text: applyTable(text, nextTable),
    table: nextTable,
    added: nextTable.slice(table.length),
  };
}
