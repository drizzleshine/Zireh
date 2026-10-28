import type { EntityKind, Pseudonym } from "@zireh/schema";
import type { Detection } from "./detect.ts";

const PREFIX: Readonly<Record<EntityKind, string>> = {
  person: "PERSON",
  org: "ORG",
  place: "PLACE",
  id: "ID",
  contact: "CONTACT",
  date: "DATE",
  money: "AMOUNT",
  other: "ITEM",
};

const norm = (s: string) => s.trim().toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Adds detections to a case's pseudonym table. Existing originals keep their placeholder,
 * so follow-up prompts stay identical (stable cache prefix) and answers stay restorable.
 */
export function extendTable(table: readonly Pseudonym[], detections: readonly Detection[]): Pseudonym[] {
  const next = [...table];
  const known = new Set(table.map((p) => norm(p.original)));
  const counters = new Map<string, number>();
  for (const p of table) {
    const [, prefix, n] = /^\[([A-Z]+)_(\d+)\]$/.exec(p.placeholder)!;
    counters.set(prefix!, Math.max(counters.get(prefix!) ?? 0, Number(n)));
  }
  for (const d of detections) {
    const original = d.text.trim();
    if (original.length < 2 || known.has(norm(original))) continue;
    const prefix = PREFIX[d.kind];
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    known.add(norm(original));
    next.push({ original, placeholder: `[${prefix}_${n}]`, kind: d.kind, ...(d.hint?.trim() ? { hint: d.hint.trim() } : {}) });
  }
  // A hint may not contain any hidden value (its own or another's); unsafe or missing hints
  // fall back to a generic description of the kind.
  const originals = next.map((p) => norm(p.original));
  return next.map((p) => {
    const safe = p.hint && !originals.some((o) => norm(p.hint!).includes(o));
    return safe ? p : { ...p, hint: GENERIC[p.kind] };
  });
}

const GENERIC: Readonly<Record<EntityKind, string>> = {
  person: "a person",
  org: "an organization",
  place: "a location",
  id: "an identifier",
  contact: "a contact detail",
  date: "a date",
  money: "an amount of money",
  other: "an item",
};

/** Replace every original with its placeholder. Longest originals first, case-insensitive. */
export function applyTable(text: string, table: readonly Pseudonym[]): string {
  let out = text;
  for (const p of [...table].sort((a, b) => b.original.length - a.original.length)) {
    const bounded = /^\w/.test(p.original) && /\w$/.test(p.original);
    const pattern = bounded ? `\\b${escape(p.original)}\\b` : escape(p.original);
    out = out.replace(new RegExp(pattern, "gi"), p.placeholder);
  }
  return out;
}

/** "[PLACE_1] = a large city in Nigeria" lines, for stages that rewrite questions. */
export const glossary = (table: readonly Pseudonym[]): string[] =>
  table.filter((p) => p.hint).map((p) => `${p.placeholder} = ${p.hint}`);

/**
 * Replace placeholders with their vague descriptions, for questions that go to the provider.
 * Done in code, not by the model, so it is exact. Placeholders without a hint stay as they are.
 */
export function withHints(text: string, table: readonly Pseudonym[]): string {
  let out = text;
  for (const p of table) {
    if (!p.hint) continue;
    // "the [ORG_1]" → "a newspaper", not "the a newspaper"; keep sentence-start capitals.
    const re = new RegExp(`\\b(?:the|a|an)\\s+${escape(p.placeholder)}|${escape(p.placeholder)}`, "gi");
    out = out.replace(re, (match) => (/^[A-Z]/.test(match) ? p.hint!.charAt(0).toUpperCase() + p.hint!.slice(1) : p.hint!));
  }
  return out;
}

const BY_PREFIX: Readonly<Record<string, string>> = {
  PERSON: "someone",
  ORG: "an organization",
  PLACE: "a place",
  ID: "an identifier",
  CONTACT: "a contact",
  DATE: "a date",
  AMOUNT: "an amount",
  ITEM: "something",
};

/**
 * Put the originals back into text that came back from the provider. Placeholders the
 * provider invented (not in the table) become plain words, never raw brackets.
 */
export function restore(text: string, table: readonly Pseudonym[]): string {
  let out = text;
  for (const p of table) out = out.split(p.placeholder).join(p.original);
  return out.replace(/\[([A-Z]+)_\d+\]/g, (m, prefix: string) => BY_PREFIX[prefix] ?? m);
}

/** Originals from the table that still appear in `text`: anything here must not leave. */
export function findLeaks(text: string, table: readonly Pseudonym[]): string[] {
  return table
    .filter((p) => {
      const bounded = /^\w/.test(p.original) && /\w$/.test(p.original);
      const pattern = bounded ? `\\b${escape(p.original)}\\b` : escape(p.original);
      return new RegExp(pattern, "i").test(text);
    })
    .map((p) => p.original);
}
