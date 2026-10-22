import type { Evidence } from "@zireh/schema";

export const isEmbeddedImage = (body: string): boolean => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(body);

/** The daemon accepts at most 20 context strings of 20,000 characters each. */
export function evidenceContext(evidence: readonly Evidence[], selected: readonly string[]) {
  const eligible = evidence.filter((item) => selected.includes(item.id) && item.kind !== "image");
  const entries = eligible.slice(0, 20).map((item) => {
    const prefix = `${item.title}\n`;
    const body = item.body.slice(0, Math.max(0, 20_000 - prefix.length));
    return { id: item.id, title: item.title, text: prefix + body, used: body.length, total: item.body.length, truncated: body.length < item.body.length };
  });
  return { entries, omitted: Math.max(0, eligible.length - entries.length) };
}

export function evidenceDownload(evidence: Evidence): { blob: Blob; filename: string } {
  const title = evidence.title.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 100) || "evidence";
  const image = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(evidence.body);
  if (evidence.kind === "image" && image) {
    const bytes = Uint8Array.from(atob(image[2]!), (character) => character.charCodeAt(0));
    return { blob: new Blob([bytes], { type: `image/${image[1]}` }), filename: `${title}.${image[1] === "jpeg" ? "jpg" : image[1]}` };
  }
  return { blob: new Blob([evidence.body], { type: "text/plain;charset=utf-8" }), filename: `${title}.txt` };
}
