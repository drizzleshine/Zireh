import { useState } from "react";
import { backupCase, restoreCase } from "../store.ts";
import { Dialog } from "./Dialog.tsx";

export function BackupDialog({ caseId, onClose, onImported }: { caseId?: string; onClose: () => void; onImported?: (id: string) => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      if (caseId) {
        const text = await backupCase(caseId, passphrase);
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = `zireh-case-${caseId.slice(0, 8)}.zireh`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setDone(true); setPassphrase("");
      } else {
        if (!file || file.size > 64 * 1024 * 1024) throw new Error("Choose a backup file smaller than 64 MiB");
        const id = await restoreCase(await file.text(), passphrase);
        setPassphrase(""); onImported?.(id); onClose();
      }
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <Dialog title={caseId ? "Back up case" : "Import case backup"} onClose={onClose}>
    {done ? <p role="status">Encrypted backup downloaded. Keep its passphrase separately.</p> : <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p>The encrypted file includes the case key, evidence and team records. Wallet coins are stored separately by the daemon.</p>
      {!caseId && <div className="field"><label htmlFor="backup-file">Backup file</label><input id="backup-file" type="file" required accept=".zireh,application/json" onChange={(event) => setFile(event.target.files?.[0])} /></div>}
      <div className="field"><label htmlFor="backup-passphrase">Passphrase (at least 12 characters)</label><input id="backup-passphrase" className="input" type="password" minLength={12} maxLength={1024} required value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete={caseId ? "new-password" : "current-password"} /></div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-foot"><button className="btn" type="button" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? "Working…" : caseId ? "Download encrypted backup" : "Import case"}</button></div>
    </form>}
  </Dialog>;
}
