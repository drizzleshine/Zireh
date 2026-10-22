import type { EntityKind } from "@zireh/schema";

export interface Detection {
  readonly text: string;
  readonly kind: EntityKind;
  readonly hint?: string;
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

/**
 * Verbatim quotes of three or more words. A unique message ("Stop writing about the bay") is a
 * fingerprint: whoever wrote or received it can recognize it, so it is hidden like a name.
 */
const QUOTE = /(?<=^|[\s(:])(["“'‘])([^"“”'‘’\n]{8,240}?)(["”'’])(?=[\s.,;:!?)]|$)/g;

export function detectQuotes(text: string): Detection[] {
  return [...text.matchAll(QUOTE)]
    .map((m) => m[2]!.trim())
    .filter((q) => q.split(/\s+/).length >= 3)
    .map((q) => ({ text: q, kind: "other" as const }));
}

export function detectPatterns(text: string): Detection[] {
  const taken: [number, number][] = [];
  const out: Detection[] = [...detectQuotes(text)];
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

/** Capitalized words that start sentences or questions, not names. */
export const COMMON = new Set(
  "a an and are as at but by can could did do does for from he her his how i if in is it its may might my no not of on or our she should so than that the their them then there these they this those to was we were what when where which who whom whose why will with would you your yes".split(" "),
);

/**
 * Proper-noun candidates: runs of capitalized words, minus sentence-starting common words.
 * Small local models miss names when asked to extract them, but classify a given list well,
 * so these go to a second, simpler model call.
 */
export function properNounCandidates(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*)*/gu)) {
    const words = m[0].split(/\s+/);
    while (words.length && COMMON.has(words[0]!.toLowerCase().replace(/[^a-z]/g, ""))) words.shift();
    const phrase = words.join(" ").replace(/[.’'-]+$/, "");
    if (phrase.length >= 2 && !COMMON.has(phrase.toLowerCase())) found.add(phrase);
  }
  return [...found];
}
