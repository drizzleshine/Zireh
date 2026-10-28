import { type Publication } from "@zireh/cases";
import { OUTCOMES } from "./outcomes.ts";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function download(p: Publication, hash: string) {
  const outcome = p.conclusion ? OUTCOMES.find((o) => o.id === p.conclusion!.outcome)!.label : "";
  const findings = p.findings
    .map(
      (f, i) => `<section><h2>Finding ${i + 1}</h2><p class="statement">${esc(f.statement)}</p>
${f.uncertainty ? `<p class="muted">Uncertain: ${esc(f.uncertainty)}</p>` : ""}
<p class="muted">Team review: ${f.support} support, ${f.disagree} disagree (${esc(f.status.replace("-", " "))})</p>
${f.observations.map((o) => `<blockquote>${esc(o.text)}<footer>${esc(o.by)}${o.evidence.map((e) => `<br>Evidence “${esc(e.title)}” sha256 ${e.sha256}`).join("")}</footer></blockquote>`).join("\n")}</section>`,
    )
    .join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>${esc(p.title)}</title><style>
body{margin:0;background:#eef1f4;color:#1b2430;font:17px/1.6 Georgia,serif}main{max-width:720px;margin:0 auto;padding:48px 20px}
h1{font-size:2rem;line-height:1.2;margin:.2em 0}h2{font:600 1rem system-ui,sans-serif;margin-top:2.5em}.outcome{font:600 .9rem system-ui,sans-serif;color:#0e7c66}
.statement{font-size:1.2rem}.muted{color:#5b6675;font-size:.95rem}blockquote{margin:1em 0;padding:.8em 1em;background:#fff;border-left:3px solid #0e7c66}
blockquote footer{font:.8rem system-ui,sans-serif;color:#5b6675;margin-top:.5em;word-break:break-all}.hash{font:.75rem system-ui,sans-serif;color:#5b6675;word-break:break-all;margin-top:3em}
@media (prefers-color-scheme:dark){body{background:#141a22;color:#e6ebf1}blockquote{background:#1c2430}}</style></head><body><main>
<p class="outcome">${esc(outcome)}</p><h1>${esc(p.title)}</h1><p class="muted">${esc(p.question)}</p>
${p.conclusion ? `<p class="statement">${esc(p.conclusion.summary)}</p>${p.conclusion.openQuestion ? `<p class="muted">Still open: ${esc(p.conclusion.openQuestion)}</p>` : ""}` : ""}
${findings}
<p class="hash">Published ${esc(new Date(p.publishedAt).toUTCString())}${p.authors.length ? ` by ${esc(p.authors.join(", "))}` : ""}${p.namesHidden ? ". Names and places are generalized." : "."}<br>
Content hash (sha256 of the canonical JSON below): ${hash}</p>
<script type="application/json" id="zireh-publication">${JSON.stringify(p).replace(/</g, "\\u003c")}</script>
</main></body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${p.title.replace(/[^\w-]+/g, "-").toLowerCase().slice(0, 60) || "findings"}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
