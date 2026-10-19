import { commentsOn, memberName, newComment } from "@zireh/cases";
import { useState } from "react";
import { myMemberId, save, useStore } from "../store.ts";

/** Discussion attached to one item. Collapsed to a count until opened. */
export function Comments({ caseId, targetId }: { caseId: string; targetId: string }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const thread = commentsOn(rec, targetId);

  if (!open)
    return (
      <button className="btn small quiet" onClick={() => setOpen(true)} aria-expanded="false">
        {thread.length ? `${thread.length} comment${thread.length === 1 ? "" : "s"}` : "Comment"}
      </button>
    );

  return (
    <div className="thread">
      {thread.map((c) => (
        <div className="comment" key={c.id}>
          <span className="who">{memberName(rec, c.memberId)}</span>
          <span>{c.text}</span>
        </div>
      ))}
      <form
        className="comment-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          await save(caseId, "comments", newComment(caseId, myMemberId(caseId), { targetId, text }));
          setText("");
        }}
      >
        <input className="input" aria-label="Write a comment" placeholder="Write a comment" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn small">
          Post
        </button>
        <button type="button" className="btn small quiet" onClick={() => setOpen(false)}>
          Hide
        </button>
      </form>
    </div>
  );
}
