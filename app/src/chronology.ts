import type { Evidence } from "@zireh/schema";

/**
 * A chronology built on this device from the dates written in the evidence. Dates without a
 * year take the year the evidence was added (or the year before, if that would put them in
 * the future). Numeric dates like 03/04/2024 are skipped: day and month order is ambiguous.
 */

export interface ChronoEvent {
  readonly key: string;
  readonly date: string; // YYYY-MM-DD
  /** Last day of a written range ("4–9 March"), same month and year as `date`. */
  readonly end?: string;
  readonly precision: "day" | "month";
  readonly label: string; // the date as written
  readonly text: string; // the sentence it appears in
  readonly evidence: Evidence;
  readonly guessedYear: boolean;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON = `(${MONTHS.map((m) => `${m[0]!.toUpperCase()}${m.slice(1, 3)}(?:${m.slice(3)})?\\.?`).join("|")})`;
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "(\\d{4})";
const PATTERNS: { re: RegExp; parse: (m: RegExpExecArray) => { d?: number; to?: number; mo: number; y?: number } }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parse: (m) => ({ y: +m[1]!, mo: +m[2]! - 1, d: +m[3]! }) },
  // 4 March 2024, 4–9 March, 4 March
  { re: new RegExp(`\\b${DAY}(?:\\s*[–-]\\s*(\\d{1,2}))?\\s+${MON}(?:,?\\s+${YEAR})?\\b`, "g"), parse: (m) => ({ d: +m[1]!, ...(m[2] ? { to: +m[2] } : {}), mo: month(m[3]!), ...(m[4] ? { y: +m[4] } : {}) }) },
  // March 4, 2024 / March 4
  { re: new RegExp(`\\b${MON}\\s+${DAY}(?:,?\\s+${YEAR})?\\b`, "g"), parse: (m) => ({ d: +m[2]!, mo: month(m[1]!), ...(m[3] ? { y: +m[3] } : {}) }) },
  // March 2024
  { re: new RegExp(`\\b${MON}\\s+${YEAR}\\b`, "g"), parse: (m) => ({ mo: month(m[1]!), y: +m[2]! }) },
];

function month(word: string): number {
  return MONTHS.findIndex((m) => m.startsWith(word.toLowerCase().replace(/\.$/, "").slice(0, 3)));
}

const pad = (n: number) => String(n).padStart(2, "0");

function sentenceAround(text: string, index: number): string {
  const stop = text.lastIndexOf(". ", index - 1);
  const start = Math.max(stop < 0 ? 0 : stop + 2, text.lastIndexOf("\n", index - 1) + 1);
  const ends = [text.indexOf(". ", index), text.indexOf("\n", index)].filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  const s = text.slice(start, end).trim();
  return s.length > 280 ? `${s.slice(0, 277)}…` : s;
}

export function chronology(evidence: readonly Evidence[]): { events: ChronoEvent[]; undated: Evidence[] } {
  const events: ChronoEvent[] = [];
  const undated: Evidence[] = [];
  for (const e of evidence) {
    if (e.kind === "image") continue;
    const added = new Date(e.addedAt);
    const seen = new Set<string>();
    const taken: [number, number][] = [];
    let found = false;
    for (const source of [{ text: e.title, title: true }, { text: e.body.slice(0, 200_000), title: false }]) {
      for (const { re, parse } of PATTERNS) {
        for (const m of source.text.matchAll(re)) {
          const at = m.index;
          if (!source.title && taken.some(([s, end]) => at < end && at + m[0].length > s)) continue;
          if (!source.title) taken.push([at, at + m[0].length]);
          const p = parse(m as unknown as RegExpExecArray);
          if (p.mo < 0 || (p.d !== undefined && (p.d < 1 || p.d > 31))) continue;
          let y = p.y ?? added.getFullYear();
          if (p.y === undefined && new Date(y, p.mo, p.d ?? 1) > new Date(added.getTime() + 31 * 86_400_000)) y -= 1;
          const date = `${y}-${pad(p.mo + 1)}-${pad(p.d ?? 1)}`;
          const end = p.d !== undefined && p.to !== undefined && p.to > p.d && p.to <= 31 ? `${y}-${pad(p.mo + 1)}-${pad(p.to)}` : undefined;
          if (seen.has(date)) continue;
          seen.add(date);
          found = true;
          events.push({
            key: `${e.id}:${date}`,
            date,
            ...(end ? { end } : {}),
            precision: p.d === undefined ? "month" : "day",
            label: m[0],
            text: source.title ? sentenceAround(e.body, 0) || e.title : sentenceAround(source.text, at),
            evidence: e,
            guessedYear: p.y === undefined,
          });
        }
      }
    }
    if (!found) undated.push(e);
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.evidence.addedAt.localeCompare(b.evidence.addedAt));
  return { events, undated };
}
