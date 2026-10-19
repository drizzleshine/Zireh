import { chatJson, type ChatModel } from "@zireh/llm";
import { EntityKind, type Pseudonym } from "@zireh/schema";
import { z } from "zod";
import { detectPatterns, type Detection } from "./detect.ts";
import { applyTable, extendTable } from "./table.ts";

const Entities = z.object({
  entities: z.array(z.object({ text: z.string().min(1), kind: EntityKind.catch("other") })).max(200),
});

const ENTITY_PROMPT = `You find identifying details in text so they can be hidden.
List every person name, organization, specific place (street, building, port, city, country),
date tied to an event, ID or account number, contact detail, and exact money amount.
Copy each one exactly as written. Do not list topics, activities, job titles or common nouns.
Kinds: person, org, place, id, contact, date, money.
Reply with JSON only: {"entities":[{"text":"...","kind":"person"}]}`;

const Hints = z.object({ hints: z.record(z.string(), z.string().max(80)) });

const HINT_PROMPT = `For each listed item, write what general kind of thing it is in 2 to 6 words, based on the text,
starting with "a" or "an". For places, name the country or region but no city. The description must fit thousands of others and must
not contain the item's name. Reply with JSON only: {"hints":{"<item>":"<description>"}}`;

/** Only identifiers are hidden; "other" from the model is usually a topic, which the provider needs. */
const HIDDEN_KINDS = new Set(["person", "org", "place", "id", "contact", "date", "money"]);

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
      { role: "system", content: ENTITY_PROMPT },
      { role: "user", content: text },
    ],
    Entities,
    { maxTokens: 600, temperature: 0 },
  );
  // Keep only identifiers that really occur in the text (models sometimes paraphrase).
  const lower = text.toLowerCase();
  const fromModel: Detection[] = found.entities
    .filter((e) => HIDDEN_KINDS.has(e.kind) && lower.includes(e.text.trim().toLowerCase()))
    .map((e) => ({ text: e.text.trim(), kind: e.kind }));
  const detections = [...detectPatterns(text), ...fromModel];

  // Vague descriptions for values the table doesn't know yet: a separate, focused call.
  const known = new Set(table.map((p) => p.original.toLowerCase()));
  const fresh = [...new Set(detections.map((d) => d.text))].filter((t) => !known.has(t.toLowerCase()));
  let hints: Record<string, string> = {};
  if (fresh.length > 0) {
    const reply = await chatJson(
      model,
      [
        { role: "system", content: HINT_PROMPT },
        { role: "user", content: `Text: ${text}\nItems: ${fresh.join("; ")}` },
      ],
      Hints,
      { maxTokens: 400, temperature: 0 },
    );
    hints = reply.hints;
  }
  const nextTable = extendTable(
    table,
    detections.map((d) => (hints[d.text] ? { ...d, hint: hints[d.text]! } : d)),
  );
  return {
    text: applyTable(text, nextTable),
    table: nextTable,
    added: nextTable.slice(table.length),
  };
}
