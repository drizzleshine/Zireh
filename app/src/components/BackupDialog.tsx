import { MAX_BACKUP_BYTES } from "@zireh/crypto";
import { Check, FileArrowUp as FileUp } from "@phosphor-icons/react";
import { useState } from "react";
import { backupCase, restoreCase } from "../store.ts";
import { Dialog } from "./Dialog.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function BackupDialog({ caseId, onClose, onImported }: { caseId?: string; onClose: () => void; onImported?: (id: string) => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (caseId) {
        const text = await backupCase(caseId, passphrase);
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `zireh-case-${caseId.slice(0, 8)}.zireh`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setDone(true);
        setPassphrase("");
      } else {
        if (!file || file.size > MAX_BACKUP_BYTES) throw new Error("Choose a backup file smaller than 64 MiB");
        const id = await restoreCase(await file.text(), passphrase);
        setPassphrase("");
        onImported?.(id);
        onClose();
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={caseId ? "Back up case" : "Import case backup"}
      description="A locked file with everything in this case. Your money isn't in it."
      onClose={onClose}
    >
      {done ? (
        <div className="grid gap-4">
          <p className="flex items-center gap-2 text-sm" role="status">
            <Check className="size-4 text-protected" /> Encrypted backup downloaded. Keep its passphrase somewhere else.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {!caseId && (
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-4 text-sm hover:border-ring/60">
              <FileUp className="size-5 text-muted-foreground" />
              <span className="flex-1 truncate">{file ? file.name : "Choose a .zireh backup file"}</span>
              <input type="file" required accept=".zireh,.zireh,application/json" className="sr-only" onChange={(event) => setFile(event.target.files?.[0])} />
            </label>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="backup-passphrase">Passphrase (at least 12 characters)</Label>
            <Input id="backup-passphrase" type="password" minLength={12} maxLength={1024} required value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete={caseId ? "new-password" : "current-password"} />
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy}>{busy ? "Working…" : caseId ? "Download encrypted backup" : "Import case"}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
