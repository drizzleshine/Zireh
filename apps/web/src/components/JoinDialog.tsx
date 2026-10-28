import type { Invite } from "@zireh/cases";
import { Key as KeyRound } from "@phosphor-icons/react";
import { useState } from "react";
import { joinCase } from "../store.ts";
import { Dialog } from "./Dialog.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function JoinDialog({ invite, onClose, onJoined }: { invite: Invite; onClose: () => void; onJoined: (id: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <Dialog title="Join a case" description="You've been invited to a private case. The key is inside your link; no server ever saw it." onClose={onClose}>
      <form
        className="grid gap-4"
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
        {invite.host && (
          <p className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" /> Sync host <code className="truncate">{invite.host}</code>
          </p>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="join-name">Your name in this case</Label>
          <Input id="join-name" required autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="A pseudonym works" />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Opening…" : "Join case"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
