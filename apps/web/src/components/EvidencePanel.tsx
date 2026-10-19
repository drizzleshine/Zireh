import { memberName, newEvidence, newObservation } from "@zireh/cases";
import type { Evidence } from "@zireh/schema";
import { useState } from "react";
import { prepareImage } from "../media.ts";
import { myMemberId, save, useStore } from "../store.ts";
import { Comments } from "./Comments.tsx";
import { ImageRedactor } from "./ImageRedactor.tsx";

const KINDS: { id: Evidence["kind"]; label: string }[] = [
  { id: "note", label: "Note" },
  { id: "document", label: "Document text" },
  { id: "link", label: "Link" },
  { id: "image", label: "Image" },
];

export function EvidencePanel({ caseId }: { caseId: string }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const [adding, setAdding] = useState(rec.evidence.length === 0);
  const [kind, setKind] = useState<Evidence["kind"]>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [noting, setNoting] = useState<string | undefined>();
  const [note, setNote] = useState("");
  const [imageNote, setImageNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const add = async () => {
    await save(caseId, "evidence", newEvidence(caseId, myMemberId(caseId), { kind, title, body }));
    setTitle("");
    setBody("");
    setImageNote(undefined);
    setAdding(false);
  };

  return (
    <section className="panel" aria-label="Evidence">
      {adding ? (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="levels" role="group" aria-label="Kind of evidence">
            {KINDS.map((k) => (
              <button
                type="button"
                key={k.id}
                aria-pressed={kind === k.id}
                onClick={() => {
                  setKind(k.id);
                  setBody("");
                  setImageNote(undefined);
                }}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="ev-title">Title</label>
            <input id="ev-title" className="input" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          {kind === "image" ? (
            <div className="field">
              <label htmlFor="ev-file">Image</label>
              <input
                id="ev-file"
                type="file"
                accept="image/*"
                required={!body}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setError(undefined);
                  try {
                    const img = await prepareImage(file);
                    setBody(img.dataUrl);
                    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
                    setImageNote(`Re-encoded at ${img.width}×${img.height}. Location, camera and time data removed on this computer.`);
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              />
              {body.startsWith("data:image/") && <ImageRedactor src={body} onChange={setBody} />}
              {imageNote && <span className="hint">{imageNote}</span>}
              {error && <p className="error">{error}</p>}
            </div>
          ) : (
            <div className="field">
              <label htmlFor="ev-body">{kind === "link" ? "URL and why it matters" : "Content"}</label>
              <textarea id="ev-body" className="textarea" required maxLength={100_000} value={body} onChange={(e) => setBody(e.target.value)} />
              <span className="hint">Encrypted before it leaves this browser. When you include it in a question, names in it are hidden first.</span>
            </div>
          )}
          <div className="composer-foot">
            <span className="spacer" />
            {rec.evidence.length > 0 && (
              <button type="button" className="btn" onClick={() => setAdding(false)}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn primary">
              Add evidence
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button className="btn" onClick={() => setAdding(true)}>
            Add evidence
          </button>
        </div>
      )}

      <div className="list">
        {[...rec.evidence].reverse().map((e) => (
          <article className="item" key={e.id}>
            <h3>{e.title}</h3>
            {e.kind === "image" ? (
              <img className="evidence-image" src={e.body} alt={e.title} />
            ) : (
              <p className="doc">{e.body.length > 900 ? `${e.body.slice(0, 900)}…` : e.body}</p>
            )}
            <div className="meta">
              <span>{KINDS.find((k) => k.id === e.kind)?.label ?? e.kind}</span>
              <span>Added by {memberName(rec, e.addedBy)}</span>
              <span title={e.sha256}>sha256 {e.sha256.slice(0, 12)}</span>
              <span style={{ flex: 1 }} />
              <Comments caseId={caseId} targetId={e.id} />
              <button className="btn small" onClick={() => setNoting(noting === e.id ? undefined : e.id)}>
                Add observation
              </button>
            </div>
            {noting === e.id && (
              <form
                className="field"
                onSubmit={async (ev) => {
                  ev.preventDefault();
                  await save(caseId, "observations", newObservation(caseId, { kind: "member", memberId: myMemberId(caseId) }, { text: note, evidenceIds: [e.id] }));
                  setNote("");
                  setNoting(undefined);
                }}
              >
                <label htmlFor={`obs-${e.id}`}>What do you see in this?</label>
                <textarea id={`obs-${e.id}`} className="textarea" required value={note} onChange={(ev) => setNote(ev.target.value)} />
                <div>
                  <button type="submit" className="btn primary small">
                    Save observation
                  </button>
                </div>
              </form>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
