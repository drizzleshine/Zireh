import { detectPatterns, properNounCandidates } from "@zireh/redact";
import type { EntityKind, Evidence, Pseudonym } from "@zireh/schema";
import { prepareImage } from "./media.ts";

/**
 * Evidence intake: turn whatever the user pastes or drops into evidence drafts, and scan
 * each one on this device for what would be hidden before any AI call.
 */

export interface Draft {
  readonly key: string;
  kind: Evidence["kind"];
  title: string;
  body: string;
  /** What happened to the source on the way in (re-encoded, text extracted, truncated…). */
  note?: string;
  /** Codename of who it came from. */
  source?: string | undefined;
}

const MAX_TEXT = 1_000_000;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|eml|html?|xml|ya?ml|srt|vtt|rtf)$/i;
const URL_ONLY = /^\s*(https?:\/\/[^\s]+)\s*$/i;
const stem = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";
const key = () => crypto.randomUUID();

/** Best guess at a kind for typed or pasted text; the user can always change it. */
export function guessText(text: string): Pick<Draft, "kind" | "title"> {
  const url = URL_ONLY.exec(text);
  if (url) {
    try {
      const u = new URL(url[1]!);
      return { kind: "link", title: `${u.hostname.replace(/^www\./, "")}${u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : ""}`.slice(0, 120) };
    } catch {
      /* fall through: not a parseable URL */
    }
  }
  const firstLine = text.trim().split("\n")[0]!.replace(/^#+\s*/, "").trim();
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 77).replace(/\s+\S*$/, "")}…` : firstLine;
  return { kind: text.length > 600 || text.split(/\n\s*\n/).length > 2 ? "document" : "note", title };
}

async function pdfText(file: File): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join(""));
  }
  await task.destroy();
  return { text: pages.map((p, i) => `[Page ${i + 1}]\n${p.trim()}`).join("\n\n"), pages: doc.numPages };
}

/** One file → one draft. Images are re-encoded here, so metadata never reaches storage. */
export async function fromFile(file: File): Promise<Draft> {
  if (file.type.startsWith("image/")) {
    const img = await prepareImage(file);
    return { key: key(), kind: "image", title: stem(file.name), body: img.dataUrl, note: `Re-encoded at ${img.width}×${img.height}. Location, camera and time data removed.` };
  }
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const { text, pages } = await pdfText(file);
    if (!text.replace(/\[Page \d+\]/g, "").trim()) throw new Error(`${file.name} has no text layer (a scan?). Add its pages as images instead.`);
    return { key: key(), kind: "document", title: stem(file.name), ...clamp(text), note: `Text extracted from ${pages} page${pages === 1 ? "" : "s"} on this device. The PDF itself is not kept.` };
  }
  if (file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXT.test(file.name)) {
    return { key: key(), kind: "document", title: stem(file.name), ...clamp(await file.text()) };
  }
  throw new Error(`${file.name}: only text, PDF and image files can be read here.`);
}

function clamp(text: string): { body: string; note?: string } {
  return text.length > MAX_TEXT ? { body: text.slice(0, MAX_TEXT), note: `Trimmed to the first ${MAX_TEXT.toLocaleString()} characters.` } : { body: text };
}

export function fromText(text: string): Draft {
  return { key: key(), ...guessText(text), body: text.slice(0, MAX_TEXT) };
}

export interface Hit {
  readonly text: string;
  readonly kind: EntityKind;
  /** Already in the case's hide list, so it is replaced in every question. */
  readonly known: boolean;
  /** Found by capitalization only; may be a false alarm. */
  readonly guess: boolean;
}

const NOT_NAMES = new Set(
  "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday page evidence note document ai q a".split(" "),
);

/**
 * What this device can tell, without a model, would be hidden before any AI call: values in
 * the case's hide list, contact details, numbers, money, verbatim quotes, and likely names.
 */
export function scan(text: string, table: readonly Pseudonym[]): Hit[] {
  if (!text || text.startsWith("data:")) return [];
  const seen = new Set<string>();
  const out: Hit[] = [];
  const add = (hit: Hit) => {
    const k = hit.text.toLowerCase();
    if (hit.text.length < 2 || seen.has(k)) return;
    seen.add(k);
    out.push(hit);
  };
  const lower = text.toLowerCase();
  for (const p of table) if (lower.includes(p.original.toLowerCase())) add({ text: p.original, kind: p.kind, known: true, guess: false });
  for (const d of detectPatterns(text)) add({ text: d.text, kind: d.kind, known: false, guess: false });
  const sample = text.slice(0, 50_000);
  for (const raw of properNounCandidates(sample)) {
    const n = raw.replace(/['’]s$/, "");
    if (NOT_NAMES.has(n.toLowerCase()) || n.split(/\s+/).every((w) => NOT_NAMES.has(w.toLowerCase()))) continue;
    // A lone capitalized word only counts if it is also capitalized mid-sentence ("Call", "Payment" are not names).
    if (!n.includes(" ") && !new RegExp(`[^.!?\\n]\\s${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(sample)) continue;
    add({ text: n, kind: "person", known: false, guess: true });
  }
  return out;
}

/** Split text into plain and hit segments for highlighting. Longest matches win. */
export function segments(text: string, hits: readonly Hit[]): { text: string; hit?: Hit }[] {
  if (!hits.length) return [{ text }];
  const sorted = [...hits].sort((a, b) => b.text.length - a.text.length);
  const re = new RegExp(sorted.map((h) => h.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  const out: { text: string; hit?: Hit }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], hit: sorted.find((h) => h.text.toLowerCase() === m[0].toLowerCase())! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export const KIND_LABEL: Record<EntityKind, string> = {
  person: "name",
  org: "organization",
  place: "place",
  id: "ID number",
  contact: "contact",
  date: "date",
  money: "amount",
  other: "quote",
};
