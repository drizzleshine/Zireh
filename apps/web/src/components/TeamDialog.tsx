import { useState } from "react";
import { inviteLink, myMemberId, removeMember, useStore } from "../store.ts";
import { Dialog } from "./Dialog.tsx";

export function TeamDialog({ caseId, onClose }: { caseId: string; onClose: () => void }) {
  const rec = useStore((state) => state.cases[caseId])!;
  const owner = myMemberId(caseId) === rec.case.createdBy;
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  return <Dialog title="Case members" onClose={onClose}>
    <p>Removing a member creates a fresh case key and sync namespace. Previous copies remain accessible. Share the updated invite only with the remaining members.</p>
    {rec.members.map((member) => <div className="row" key={member.id}><span>{member.name}{member.removedAt ? " (removed)" : member.id === rec.case.createdBy ? " (creator)" : ""}</span>
      {owner && !member.removedAt && member.id !== rec.case.createdBy && <button className="btn small" disabled={busy} onClick={async () => {
        setBusy(true); setError(undefined);
        try { await removeMember(caseId, member.id); setDone(true); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      }}>Remove and rotate key</button>}
    </div>)}
    {done && <p className="notice" role="status">The key has been rotated on this device. Remaining members need an updated invite.<button className="btn small" onClick={() => navigator.clipboard.writeText(inviteLink(caseId))}>Copy updated invite</button></p>}
    {error && <p className="error" role="alert">{error}</p>}
  </Dialog>;
}
