import type { CaseRecords } from "@zireh/cases";
import { extendTable } from "@zireh/shield";
import type { Finding, Pseudonym } from "@zireh/schema";
import { useSyncExternalStore } from "react";
import { database, Keys } from "./persistence.ts";

/**
 * Sources are shared with the team by codename only. A source's real identity can be noted,
 * but it lives in this browser alone: never synced, never in the team's hide list, and always
 * hidden from AI calls made on this device.
 */

type Vault = Record<string, string>; // codename → real identity
const listeners = new Set<() => void>();
const cache = new Map<string, Vault>();
const EMPTY: Vault = Object.freeze({}) as Vault;
const emit = () => {
  for (const l of listeners) l();
};

const read = (caseId: string): Vault => cache.get(caseId) ?? EMPTY;

function store(caseId: string, vault: Vault) {
  void database
    .write((s) => {
      if (Object.keys(vault).length) s.put(vault, Keys.vault(caseId));
      else s.delete(Keys.vault(caseId));
    })
    .catch(() => {
      /* kept in memory for this session */
    });
}

/**
 * Identities live in the case database (see persistence.ts). The store waits for them to load
 * before reporting itself loaded, so no AI call can run before source names are known to be hidden.
 */
export const identitiesReady: Promise<void> =
  typeof indexedDB === "undefined"
    ? Promise.resolve()
    : database.rangeEntries<Vault>(Keys.vaults).then(
        (entries) => {
          for (const [key, vault] of entries) cache.set(key.slice(Keys.vaults.length), vault);
          emit();
        },
        () => {},
      );

export function setIdentity(caseId: string, codename: string, identity: string) {
  const next = { ...read(caseId) };
  if (identity.trim()) next[codename] = identity.trim();
  else delete next[codename];
  cache.set(caseId, next);
  store(caseId, next);
  emit();
}

/** Drop every identity noted for a case on this device. */
export function forgetIdentities(caseId: string) {
  cache.delete(caseId);
  store(caseId, {});
  emit();
}

export function useIdentities(caseId: string): Vault {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => read(caseId),
    () => read(caseId),
  );
}

/** The team's hide list plus this device's source identities, for scans and AI calls made here. */
export function withIdentities(caseId: string, table: readonly Pseudonym[]): Pseudonym[] {
  const names = Object.values(read(caseId)).filter((n) => !table.some((p) => p.original.toLowerCase() === n.toLowerCase()));
  return names.length ? extendTable(table, names.map((text) => ({ text, kind: "person" as const, hint: "a source" }))) : [...table];
}

/** Drop this device's source identities before a table is saved for the team. */
export function withoutIdentities(caseId: string, table: readonly Pseudonym[]): Pseudonym[] {
  const names = new Set(Object.values(read(caseId)).map((n) => n.toLowerCase()));
  return table.filter((p) => !names.has(p.original.toLowerCase()));
}

export function codenames(rec: CaseRecords): string[] {
  return [...new Set(rec.evidence.flatMap((e) => (e.source ? [e.source] : [])))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** "Source A", "Source B", … then "Source AA". */
export function nextCodename(rec: CaseRecords): string {
  const taken = new Set(codenames(rec).map((c) => c.toLowerCase()));
  for (let i = 0; ; i++) {
    const letters = i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));
    if (!taken.has(`source ${letters}`.toLowerCase())) return `Source ${letters}`;
  }
}

export interface Corroboration {
  readonly sources: string[];
  readonly unattributed: number;
  readonly evidence: number;
  readonly level: "corroborated" | "single" | "unknown";
}

/** The two-source rule: how many independent sources stand behind a finding. */
export function corroboration(rec: CaseRecords, finding: Finding): Corroboration {
  const evidenceIds = new Set(rec.observations.filter((o) => finding.observationIds.includes(o.id) && o.status !== "rejected").flatMap((o) => o.evidenceIds));
  const items = rec.evidence.filter((e) => evidenceIds.has(e.id));
  const sources = [...new Set(items.flatMap((e) => (e.source ? [e.source] : [])))];
  const unattributed = items.filter((e) => !e.source).length;
  return { sources, unattributed, evidence: items.length, level: sources.length >= 2 ? "corroborated" : sources.length === 1 ? "single" : "unknown" };
}

export interface VerbatimRun {
  readonly evidenceTitle: string;
  readonly source: string | undefined;
  readonly words: number;
  readonly snippet: string;
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Canary-trap check: long word-for-word runs copied from non-public evidence. Leaked documents
 * are often worded slightly differently for each recipient, so quoting one exactly can point
 * straight back to whoever leaked it.
 */
export function verbatimRuns(published: string, rec: CaseRecords, min = 8): VerbatimRun[] {
  const out: VerbatimRun[] = [];
  const shown = published.match(/[\p{L}\p{N}]+/gu) ?? []; // original casing, for the snippet
  const pub = shown.map((w) => w.toLowerCase());
  if (pub.length < min) return out;
  for (const e of rec.evidence) {
    if (e.kind === "image" || e.kind === "link" || e.source === "Public record") continue;
    const grams = new Set<string>();
    const w = words(e.body.slice(0, 300_000));
    for (let i = 0; i + min <= w.length; i++) grams.add(w.slice(i, i + min).join(" "));
    if (!grams.size) continue;
    for (let i = 0; i + min <= pub.length; ) {
      if (!grams.has(pub.slice(i, i + min).join(" "))) {
        i++;
        continue;
      }
      let end = i + min;
      while (end < pub.length && grams.has(pub.slice(end - min + 1, end + 1).join(" "))) end++;
      out.push({ evidenceTitle: e.title, source: e.source, words: end - i, snippet: shown.slice(i, Math.min(end, i + 24)).join(" ") + (end - i > 24 ? "…" : "") });
      i = end;
    }
  }
  return out;
}
