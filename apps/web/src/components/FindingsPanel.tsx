import { findingViews, memberName, newFinding, newReview } from "@zireh/cases";
import type { Observation, Review } from "@zireh/schema";
import { useState } from "react";
import { myMemberId, save, useStore } from "../store.ts";

const DECISIONS: { id: Review["decision"]; label: string }[] = [
  { id: "support", label: "Supports" },
  { id: "disagree", label: "Disagree" },
  { id: "needs-evidence", label: "Needs evidence" },
];

const STATUS_COPY = { unreviewed: "Not reviewed", supported: "Supported", disputed: "Disputed", "needs-evidence": "Needs evidence" } as const;

export function FindingsPanel({ caseId }: { caseId: string }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const me = myMemberId(caseId);
  const [picked, setPicked] = useState<string[]>([]);
  const [statement, setStatement] = useState("");
  const [uncertainty, setUncertainty] = useState("");
  const usable = rec.observations.filter((o) => o.status !== "rejected");
  const findings = findingViews(rec);

  const author = (o: Observation) => (o.author.kind === "ai" ? `AI answer requested by ${memberName(rec, o.author.requestedBy)}` : memberName(rec, o.author.memberId));

  return (
    <section className="panel" aria-label="Findings">
      <div>
        <h2 className="section-title">Observations</h2>
        {usable.length === 0 ? (
          <div className="empty">
            <strong>No observations yet</strong>
            Add one from a piece of evidence, or save an answer from Research.
          </div>
        ) : (
          <div className="list">
            {usable.map((o) => (
              <article className="item" key={o.id}>
                <p className="doc">{o.text}</p>
                <div className="meta">
                  {o.status === "draft" && <span className="pill draft">Draft</span>}
                  <span>{author(o)}</span>
                  <span style={{ flex: 1 }} />
                  {o.status === "draft" && (
                    <>
                      <button className="btn small" onClick={() => save(caseId, "observations", { ...o, status: "accepted" })}>
                        Accept
                      </button>
                      <button className="btn small quiet" onClick={() => save(caseId, "observations", { ...o, status: "rejected" })}>
                        Reject
                      </button>
                    </>
                  )}
                  {o.status === "accepted" && (
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={picked.includes(o.id)} onChange={() => setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]))} />
                      Cite in a finding
                    </label>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {picked.length > 0 && (
        <form
          className="composer"
          onSubmit={async (e) => {
            e.preventDefault();
            await save(caseId, "findings", newFinding(caseId, me, { statement, observationIds: picked, uncertainty }));
            setStatement("");
            setUncertainty("");
            setPicked([]);
          }}
        >
          <div className="field">
            <label htmlFor="f-statement">Finding, citing {picked.length} observation{picked.length === 1 ? "" : "s"}</label>
            <textarea id="f-statement" className="textarea" required value={statement} onChange={(e) => setStatement(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="f-uncertainty">What's still uncertain?</label>
            <input id="f-uncertainty" className="input" value={uncertainty} onChange={(e) => setUncertainty(e.target.value)} />
          </div>
          <div className="composer-foot">
            <span className="spacer" />
            <button type="submit" className="btn primary">
              Add finding
            </button>
          </div>
        </form>
      )}

      <div>
        <h2 className="section-title">Findings</h2>
        {findings.length === 0 ? (
          <div className="empty">
            <strong>No findings yet</strong>
            Accept observations, tick the ones that support a conclusion, and write it up for your team to review.
          </div>
        ) : (
          <div className="list">
            {findings.map((f) => {
              const mine = f.reviews.filter((r) => r.memberId === me).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
              return (
                <article className="item" key={f.id}>
                  <p className="doc" style={{ fontSize: "var(--s-18)" }}>
                    {f.statement}
                  </p>
                  {f.uncertainty && <p className="level-note">Uncertain: {f.uncertainty}</p>}
                  {f.missingObservations.length > 0 && <p className="notice">Cites {f.missingObservations.length} observation(s) that were rejected or removed.</p>}
                  <div className="meta">
                    <span className={`pill ${f.tally.status === "supported" ? "supported" : f.tally.status === "disputed" ? "disputed" : ""}`}>{STATUS_COPY[f.tally.status]}</span>
                    <span>
                      {f.tally.support} support · {f.tally.disagree} disagree · {f.tally.needsEvidence} need evidence
                    </span>
                    <span>By {memberName(rec, f.createdBy)}</span>
                    <span style={{ flex: 1 }} />
                    <div className="reviews" role="group" aria-label="Your review">
                      {DECISIONS.map((d) => (
                        <button
                          key={d.id}
                          className="chip"
                          aria-pressed={mine?.decision === d.id}
                          onClick={() => save(caseId, "reviews", newReview(caseId, me, { findingId: f.id, decision: d.id, reason: "" }))}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
