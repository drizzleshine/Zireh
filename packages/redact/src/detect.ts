import type { EntityKind } from "@zireh/schema";

export interface Detection {
  readonly text: string;
  readonly kind: EntityKind;
}

/**
 * Pattern detectors for things a model may miss. Order matters: earlier patterns win
 * when matches overlap (e.g. an email is not also reported as a URL).
 */
const PATTERNS: readonly (readonly [EntityKind, RegExp])[] = [
  ["contact", /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g], // email
  ["contact", /(?:https?:\/\/|www\.)[^\s)>\]]+/g], // url
  ["contact", /(?<![\w])\+?\d[\d\s().-]{7,}\d(?![\w])/g], // phone
  ["id", /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g], // IBAN
  ["id", /\b(?:\d[ -]?){13,19}\b/g], // card-like number
  ["id", /\b\d{3}-\d{2}-\d{4}\b/g], // SSN-like
  ["money", /(?:[$€£₦]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|NGN|ZEC)\b)/g],
];

export function detectPatterns(text: string): Detection[] {
  const taken: [number, number][] = [];
  const out: Detection[] = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      out.push({ text: m[0].trim(), kind });
    }
  }
  return out;
}
