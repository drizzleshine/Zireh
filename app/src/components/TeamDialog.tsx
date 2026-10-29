import { Key as KeyRound, LinkSimple as Link2, ShieldCheck, UserMinus } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { inviteLink, myMemberId, removeMember, useStore } from "../store.ts";
import { Dialog } from "./Dialog.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function TeamDialog({ caseId, onClose }: { caseId: string; onClose: () => void }) {
  const rec = useStore((state) => state.cases[caseId])!;
  const me = myMemberId(caseId);
  const owner = me === rec.case.createdBy;
  const [busy, setBusy] = useState<string>();
  const [rotated, setRotated] = useState(false);
  return (
    <Dialog title="Case members" description="Removing someone locks them out of new changes. They keep what they already saw." onClose={onClose}>
      <ul className="grid gap-2">
        {rec.members.map((member) => (
          <li key={member.id} className="flex items-center gap-3 rounded-lg border p-3">
            <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold">{member.name.slice(0, 2).toUpperCase()}</span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                {member.name}
                {member.id === me && <span className="text-xs font-normal text-muted-foreground">you</span>}
                {member.id === rec.case.createdBy && <Badge variant="secondary" className="font-normal">creator</Badge>}
                {member.removedAt && <Badge variant="outline" className="font-normal text-muted-foreground">removed</Badge>}
              </p>
              <p className="flex items-center gap-1 font-mono text-[0.6875rem] text-muted-foreground">
                {member.signingKey ? <ShieldCheck className="size-3 text-protected" /> : <KeyRound className="size-3" />}
                {member.id.slice(0, 12)} · {member.signingKey ? "signs their edits" : "legacy unsigned"}
              </p>
            </div>
            {owner && !member.removedAt && member.id !== rec.case.createdBy && (
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(member.id);
                  try {
                    await removeMember(caseId, member.id);
                    setRotated(true);
                  } catch (error) {
                    toast.error("Couldn't remove", { description: (error as Error).message });
                  } finally {
                    setBusy(undefined);
                  }
                }}
              >
                <UserMinus /> Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {rotated && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-protected/40 bg-protected-wash p-3 text-sm" role="status">
          <span className="flex-1">Key rotated on this device. Remaining members need the updated invite.</span>
          <Button
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(await inviteLink(caseId));
                toast.success("Updated invite copied");
              } catch (error) {
                toast.error("Couldn't copy", { description: (error as Error).message });
              }
            }}
          >
            <Link2 /> Copy updated invite
          </Button>
        </div>
      )}
    </Dialog>
  );
}
