import type { Invite } from "@zireh/cases";
import { useState } from "react";
import { joinCase } from "../store.ts";
import { Dialog } from "./Dialog.tsx";

export function JoinDialog({ invite, onClose, onJoined }: { invite: Invite; onClose: () => void; onJoined: (id: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <Dialog title="Join a case" onClose={onClose}>
      {invite.host && <p className="level-note">Sync host: <code>{invite.host}</code></p>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            onJoined(await joinCase(invite, name));
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <p className="doc" style={{ fontSize: "var(--s-15)" }}>
          You were invited to an encrypted case. The key is in the link you opened; it was never sent to a server.
        </p>
        <div className="field">
          <label htmlFor="join-name">Your name in this case</label>
          <input id="join-name" className="input" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="A pseudonym works" />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>
            Not now
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Opening…" : "Join case"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
