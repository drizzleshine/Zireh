import { chatJson, type ChatModel } from "@zireh/llm";
import { EntityKind, type Pseudonym } from "@zireh/schema";
import { z } from "zod";
import { COMMON, detectPatterns, detectQuotes, properNounCandidates, type Detection } from "./detect.ts";
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

const Classified = z.object({
  items: z.array(z.object({ text: z.string(), kind: z.string() })).max(200),
});

const CLASSIFY_PROMPT = `For each listed phrase, say what it names in the text: person, org, place, or none (not a name).
Reply with JSON only: {"items":[{"text":"...","kind":"place"}]}`;

const Hints = z.object({ hints: z.record(z.string(), z.string().max(80)) });

const HINT_PROMPT = `For each listed item, write what general kind of thing it is in 2 to 6 words, based on the text,
starting with "a" or "an". Use only what the text says: include a country or region only if the
text states it, and never guess. The description must fit thousands of others and must
not contain the item's name. Reply with JSON only: {"hints":{"<item>":"<description>"}}`;

/**
 * Reject common words and sentence fragments without assuming a name's script or casing.
 * Numeric identifiers still need a digit or month name.
 */
const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
function plausible(text: string, kind: string): boolean {
  if (kind === "person" || kind === "org" || kind === "place") {
    const words = text.trim().toLowerCase().split(/\s+/);
    return [...text.trim()].length >= 2 && !COMMON.has(text.trim().toLowerCase()) &&
      !(words.length >= 3 && words.some((w) => /^(?:is|are|was|were|has|have|had|does|did|would|could|should)$/.test(w)));
  }
  if (kind === "date") return /\d/.test(text) || MONTHS.test(text);
  if (kind === "id" || kind === "money") return /\d/.test(text);
  return true; // contact: patterns already cover the common forms
}

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
    .filter((e) => HIDDEN_KINDS.has(e.kind) && lower.includes(e.text.trim().toLowerCase()) && plausible(e.text, e.kind))
    .map((e) => ({ text: e.text.trim(), kind: e.kind }));
  // Second pass: capitalized phrases the extraction missed, classified by the model.
  const covered = (phrase: string) => fromModel.some((d) => d.text.toLowerCase().includes(phrase.toLowerCase()) || phrase.toLowerCase().includes(d.text.toLowerCase()));
  const candidates = properNounCandidates(text).filter((c) => !covered(c) && !table.some((p) => p.original.toLowerCase() === c.toLowerCase()));
  const classified: Detection[] = [];
  if (candidates.length > 0) {
    const reply = await chatJson(
      model,
      [
        { role: "system", content: CLASSIFY_PROMPT },
        { role: "user", content: `Text: ${text}\nPhrases: ${candidates.join("; ")}` },
      ],
      Classified,
      { maxTokens: 400, temperature: 0 },
    );
    for (const item of reply.items) {
      const kind = item.kind.toLowerCase();
      if ((kind === "person" || kind === "org" || kind === "place") && candidates.includes(item.text)) classified.push({ text: item.text, kind });
    }
  }
  const detections = [...detectPatterns(text), ...fromModel, ...classified];

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

/**
 * Redaction without the on-device model: every pattern, quote and capitalized phrase is hidden.
 * Stricter than the model (which keeps harmless names), and never guesses.
 */
export function redactWithoutModel(text: string, table: readonly Pseudonym[]): RedactResult {
  const detections: Detection[] = [...detectPatterns(text), ...detectQuotes(text), ...properNounCandidates(text).map((t) => ({ text: t, kind: "other" as const, hint: "a name" }))];
  const next = extendTable(table, detections);
  return { text: applyTable(text, next), table: next, added: next.slice(table.length) };
}
