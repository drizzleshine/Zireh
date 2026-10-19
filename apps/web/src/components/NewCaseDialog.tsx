import type { PrivacyLevel } from "@zireh/schema";
import { useState } from "react";
import { createCase } from "../store.ts";
import { Dialog } from "./Dialog.tsx";
import { LEVEL_COPY } from "./levels.ts";

export function NewCaseDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [name, setName] = useState("");
  const [privacy, setPrivacy] = useState<PrivacyLevel>("private");
  const [error, setError] = useState<string | undefined>();

  return (
    <Dialog title="Start a case" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            onCreated(await createCase({ title, question, privacy, memberName: name }));
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <div className="field">
          <label htmlFor="nc-title">Case name</label>
          <input id="nc-title" className="input" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Port smuggling story" />
        </div>
        <div className="field">
          <label htmlFor="nc-question">What are you trying to find out?</label>
          <textarea id="nc-question" className="textarea" required maxLength={2000} value={question} onChange={(e) => setQuestion(e.target.value)} />
          <span className="hint">Stays encrypted. Only people you invite can read it.</span>
        </div>
        <div className="field">
          <label htmlFor="nc-name">Your name in this case</label>
          <input id="nc-name" className="input" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="A pseudonym works" />
        </div>
        <div className="field">
          <span style={{ fontWeight: 600, fontSize: "var(--s-13)" }} id="nc-level">
            Default privacy
          </span>
          <div className="levels" role="group" aria-labelledby="nc-level">
            {(Object.keys(LEVEL_COPY) as PrivacyLevel[]).map((l) => (
              <button type="button" key={l} aria-pressed={privacy === l} onClick={() => setPrivacy(l)}>
                {LEVEL_COPY[l].name}
              </button>
            ))}
          </div>
          <span className="hint">{LEVEL_COPY[privacy].note}</span>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Start case
          </button>
        </div>
      </form>
    </Dialog>
  );
}
