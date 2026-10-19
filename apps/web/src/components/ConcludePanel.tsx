import { buildPublication, findingViews, latestConclusion, memberName, newConclusion, type Publication } from "@zireh/cases";
import type { Outcome } from "@zireh/schema";
import { useState } from "react";
import { api } from "../api.ts";
import { myMemberId, save, savePseudonyms, useStore } from "../store.ts";

const OUTCOMES: { id: Outcome; label: string; ask: string }[] = [
  { id: "resolved", label: "Resolved", ask: "What does the evidence establish?" },
  { id: "unresolved", label: "Unresolved", ask: "What do we know so far?" },
  { id: "disputed", label: "Disputed", ask: "What are the competing readings?" },
];

/** Agree on an outcome, then publish a findings page anyone can verify by its hash. */
export function ConcludePanel({ caseId }: { caseId: string }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const current = latestConclusion(rec);
  const findings = findingViews(rec);
  const [outcome, setOutcome] = useState<Outcome>(current?.outcome ?? "unresolved");
  const [summary, setSummary] = useState(current?.summary ?? "");
  const [openQuestion, setOpenQuestion] = useState(current?.openQuestion ?? "");
  const [picked, setPicked] = useState<string[]>(current?.findingIds ?? findings.filter((f) => f.tally.status === "supported").map((f) => f.id));
  const [hideNames, setHideNames] = useState(true);
  const [savedNote, setSavedNote] = useState<string | undefined>();
  const [scan, setScan] = useState<"idle" | "running" | "done" | string>("idle");

  // Not memoized: case records change in place, and building the page is cheap.
  const preview = current ? buildPublication(rec, { hideNames }) : undefined;
  const disputedPicked = findings.filter((f) => picked.includes(f.id) && f.tally.status === "disputed").length;

  return (
    <section className="panel" aria-label="Conclude and publish">
      <form
        className="composer"
        onSubmit={async (e) => {
          e.preventDefault();
          await save(caseId, "conclusions", newConclusion(caseId, myMemberId(caseId), current, { outcome, summary, findingIds: picked, openQuestion }));
          setSavedNote(`Saved revision ${(current?.revision ?? 0) + 1}`);
        }}
      >
        <div className="field">
          <span style={{ fontWeight: 600, fontSize: "var(--s-13)" }} id="outcome-label">
            Outcome
          </span>
          <div className="levels" role="group" aria-labelledby="outcome-label">
            {OUTCOMES.map((o) => (
              <button type="button" key={o.id} aria-pressed={outcome === o.id} onClick={() => setOutcome(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="c-summary">{OUTCOMES.find((o) => o.id === outcome)!.ask}</label>
          <textarea id="c-summary" className="textarea" required value={summary} onChange={(e) => setSummary(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="c-open">{outcome === "resolved" ? "Anything left open?" : "What would settle it?"}</label>
          <input id="c-open" className="input" required={outcome !== "resolved"} value={openQuestion} onChange={(e) => setOpenQuestion(e.target.value)} />
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, fontSize: "var(--s-13)", marginBottom: 6 }}>Findings this rests on</legend>
          {findings.length === 0 && <span className="hint">No findings yet. Write them in the Findings tab.</span>}
          {findings.map((f) => (
            <label key={f.id} className="check-row">
              <input type="checkbox" checked={picked.includes(f.id)} onChange={() => setPicked((p) => (p.includes(f.id) ? p.filter((x) => x !== f.id) : [...p, f.id]))} />
              <span className="doc" style={{ fontSize: "var(--s-15)" }}>
                {f.statement}
              </span>
              <span className={`pill ${f.tally.status === "supported" ? "supported" : f.tally.status === "disputed" ? "disputed" : ""}`}>{f.tally.status.replace("-", " ")}</span>
            </label>
          ))}
          {disputedPicked > 0 && outcome === "resolved" && <p className="notice">{disputedPicked} of the chosen findings are disputed by a teammate. Consider "Disputed" instead.</p>}
        </fieldset>
        <div className="composer-foot">
          {current && (
            <span className="level-note">
              Current: revision {current.revision} by {memberName(rec, current.createdBy)}
            </span>
          )}
          <span className="spacer" />
          {savedNote && <span className="level-note">{savedNote}</span>}
          <button type="submit" className="btn primary">
            {current ? "Save new revision" : "Save conclusion"}
          </button>
        </div>
      </form>

      <div className="item">
        <h3>Publish a findings page</h3>
        {!preview ? (
          <p className="level-note">Save a conclusion first. The page is built from it.</p>
        ) : (
          <>
            <label className="check-row">
              <input type="checkbox" checked={hideNames} onChange={(e) => setHideNames(e.target.checked)} />
              <span>Hide names and places</span>
            </label>
            {hideNames && (
              <div className="hide-list">
                {rec.pseudonyms.length ? (
                  <span className="level-note">
                    Hiding: {rec.pseudonyms.map((p) => `${p.original} → ${p.hint ?? p.placeholder}`).join(", ")}
                  </span>
                ) : (
                  <span className="level-note">No names are marked for hiding in this case yet.</span>
                )}
                <button
                  className="btn small"
                  disabled={scan === "running"}
                  onClick={async () => {
                    setScan("running");
                    try {
                      const p = buildPublication(rec, { hideNames: false }).publication;
                      const texts = [p.title, p.question, p.conclusion?.summary ?? "", p.conclusion?.openQuestion ?? "", ...p.findings.flatMap((f) => [f.statement, f.uncertainty, ...f.observations.map((o) => o.text)])];
                      const { table } = await api.redact(texts, rec.pseudonyms);
                      await savePseudonyms(caseId, table);
                      setScan("done");
                    } catch (err) {
                      setScan((err as Error).message);
                    }
                  }}
                >
                  {scan === "running" ? "Scanning on this computer…" : "Scan this page for names"}
                </button>
                {scan !== "idle" && scan !== "running" && scan !== "done" && <p className="error">{scan}</p>}
              </div>
            )}
            <PublicationPreview publication={preview.publication} />
            <div className="meta">
              <span title={preview.hash}>Page hash sha256 {preview.hash.slice(0, 16)}…</span>
              <span style={{ flex: 1 }} />
              <button className="btn primary small" onClick={() => download(preview.publication, preview.hash)}>
                Download findings page
              </button>
            </div>
            <p className="level-note">
              The page is a single file with no trackers. Anyone can recompute its hash from the data inside to check it hasn't been edited.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function PublicationPreview({ publication: p }: { publication: Publication }) {
  return (
    <div className="pub-preview">
      <p className="pub-outcome">{p.conclusion ? OUTCOMES.find((o) => o.id === p.conclusion!.outcome)!.label : ""}</p>
      <h4 className="doc">{p.title}</h4>
      <p className="doc pub-summary">{p.conclusion?.summary}</p>
      <p className="level-note">
        {p.findings.length} finding{p.findings.length === 1 ? "" : "s"}, {p.findings.reduce((n, f) => n + f.observations.length, 0)} cited observations
      </p>
    </div>
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function download(p: Publication, hash: string) {
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
