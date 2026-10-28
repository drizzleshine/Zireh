import type { Attachment, Evidence } from "@zireh/schema";

export const isEmbeddedImage = (body: string): boolean => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(body);

/** Older evidence stored a picture as its whole body; read it as one attached picture. */
export function filesOf(e: Evidence): Attachment[] {
  if (e.kind === "image") {
    const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(e.body);
    if (!m) return [];
    return [{ name: `${e.title}.${m[2] === "jpeg" ? "jpg" : m[2]}`, type: m[1]!, size: Math.floor((m[3]!.length * 3) / 4), sha256: e.sha256, data: m[3]! }];
  }
  return e.attachments ?? [];
}

/** The member's own words on an item (never a picture's data). */
export const textOf = (e: Evidence): string => (e.kind === "image" ? "" : e.body);

/** Everything readable on an item: the member's text, then text read from its files. */
export function readableText(e: Evidence): string {
  return [textOf(e), ...filesOf(e).flatMap((a) => (a.text ? [`[${a.name}]\n${a.text}`] : []))].filter(Boolean).join("\n\n");
}

export type FileView = "image" | "pdf" | "text" | "audio" | "video" | "other";

const bytesOf = (a: Attachment) => Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
const starts = (bytes: Uint8Array, sig: number[]) => sig.every((b, i) => bytes[i] === b);

/**
 * What the viewer may show, decided from the file's own bytes where it matters: only raster
 * images, real PDFs, plain text and common media play inline. SVG, HTML and everything else
 * download, so a file can never run code in this page.
 */
export function viewOf(a: Attachment): FileView {
  const head = Uint8Array.from(atob(a.data.slice(0, 16)), (c) => c.charCodeAt(0));
  if (starts(head, [0xff, 0xd8, 0xff]) || starts(head, [0x89, 0x50, 0x4e, 0x47]) || (starts(head, [0x52, 0x49, 0x46, 0x46]) && /webp/i.test(a.type)) || starts(head, [0x47, 0x49, 0x46, 0x38])) return "image";
  if (starts(head, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (a.text !== undefined && !/html|svg|xml/i.test(a.type) && !/\.(html?|svg|xml)$/i.test(a.name)) return "text";
  if (/^audio\/(mpeg|mp4|ogg|wav|webm|x-m4a|aac)$/.test(a.type)) return "audio";
  if (/^video\/(mp4|webm|ogg|quicktime)$/.test(a.type)) return "video";
  return "other";
}

const SAFE_TYPE: Record<FileView, (a: Attachment) => string> = {
  image: (a) => (/^image\/(png|jpeg|webp|gif)$/.test(a.type) ? a.type : "image/jpeg"),
  pdf: () => "application/pdf",
  text: () => "text/plain;charset=utf-8",
  audio: (a) => a.type,
  video: (a) => a.type,
  other: () => "application/octet-stream",
};

/** A blob URL whose type matches what the viewer decided, never the type the file claimed. */
export function fileUrl(a: Attachment, forDownload = false): string {
  const type = forDownload ? "application/octet-stream" : SAFE_TYPE[viewOf(a)](a);
  return URL.createObjectURL(new Blob([bytesOf(a)], { type }));
}

export function downloadFile(a: Attachment) {
  const href = fileUrl(a, true);
  const link = document.createElement("a");
  link.href = href;
  link.download = a.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The research pipeline accepts at most 20 context strings of 20,000 characters each. */
export function evidenceContext(evidence: readonly Evidence[], selected: readonly string[]) {
  const eligible = evidence.filter((item) => selected.includes(item.id) && readableText(item));
  const entries = eligible.slice(0, 20).map((item) => {
    const prefix = `${item.title}\n`;
    const all = readableText(item);
    const body = all.slice(0, Math.max(0, 20_000 - prefix.length));
    return { id: item.id, title: item.title, text: prefix + body, used: body.length, total: all.length, truncated: body.length < all.length };
  });
  return { entries, omitted: Math.max(0, eligible.length - entries.length) };
}

/** Chain of custody: what is in the case file, its fingerprint, who it came from, who added it, what relies on it. */
export function custodyCsv(rec: import("@zireh/cases").CaseRecords): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const name = (id: string) => rec.members.find((m) => m.id === id)?.name ?? "Unknown member";
  const rows = [...rec.evidence]
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt))
    .map((e) => {
      const citing = rec.observations.filter((o) => o.status !== "rejected" && o.evidenceIds.includes(e.id));
      const findings = rec.findings.filter((f) => citing.some((o) => f.observationIds.includes(o.id)));
      return [e.addedAt, e.title, filesOf(e).map((a) => a.name).join(" | "), e.source ?? "", e.sha256, name(e.addedBy), String(citing.length), findings.map((f) => f.statement.slice(0, 120)).join(" | "), e.id];
    });
  return [["added_at", "title", "files", "source", "sha256", "added_by", "observations_citing", "findings_relying", "evidence_id"], ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}
