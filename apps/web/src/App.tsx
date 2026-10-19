import { parseInvite, type Invite } from "@zireh/cases";
import type { DaemonStatus } from "@zireh/schema";
import { useCallback, useEffect, useState } from "react";
import { api, DaemonError } from "./api.ts";
import { CaseView } from "./components/CaseView.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { JoinDialog } from "./components/JoinDialog.tsx";
import { NewCaseDialog } from "./components/NewCaseDialog.tsx";
import { Rail } from "./components/Rail.tsx";
import { WalletDialog } from "./components/WalletDialog.tsx";
import { useStore } from "./store.ts";

export function App() {
  const [status, setStatus] = useState<DaemonStatus | undefined>();
  const [daemonError, setDaemonError] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [dialog, setDialog] = useState<"wallet" | "new-case" | undefined>();
  const [invite, setInvite] = useState<Invite | undefined>(() => parseInvite(location.hash));
  const caseIds = useStore((s) => s.workspaces.map((w) => w.caseId).join(","));

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setDaemonError(undefined);
    } catch (err) {
      setDaemonError(err instanceof DaemonError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const ids = caseIds ? caseIds.split(",") : [];
    if (!selected && ids.length) setSelected(ids[ids.length - 1]);
  }, [caseIds, selected]);

  return (
    <div className="shell">
      <Rail
        status={status}
        daemonError={daemonError}
        selected={selected}
        onSelect={setSelected}
        onTopUp={() => setDialog("wallet")}
        onNewCase={() => setDialog("new-case")}
      />
      <main className="main">
        <ErrorBoundary key={selected}>
        {selected ? (
          <CaseView key={selected} caseId={selected} status={status} onBalanceChange={refresh} onTopUp={() => setDialog("wallet")} />
        ) : (
          <Welcome onNewCase={() => setDialog("new-case")} />
        )}
        </ErrorBoundary>
      </main>
      {dialog === "wallet" && <WalletDialog onClose={() => setDialog(undefined)} onBalanceChange={refresh} />}
      {dialog === "new-case" && (
        <NewCaseDialog
          onClose={() => setDialog(undefined)}
          onCreated={(id) => {
            setDialog(undefined);
            setSelected(id);
          }}
        />
      )}
      {invite && (
        <JoinDialog
          invite={invite}
          onClose={() => {
            setInvite(undefined);
            history.replaceState(null, "", location.pathname);
          }}
          onJoined={(id) => {
            setInvite(undefined);
            history.replaceState(null, "", location.pathname);
            setSelected(id);
          }}
        />
      )}
    </div>
  );
}

function Welcome({ onNewCase }: { onNewCase: () => void }) {
  return (
    <section className="welcome">
      <h1>Investigate together. Ask powerful AI. Keep your sources to yourselves.</h1>
      <p className="doc">
        Every question is stripped of names and places on this computer, split into harmless pieces, mixed with decoys, and sent over
        Tor with anonymous payment. Your team's case files are encrypted before they leave your browser.
      </p>
      <div>
        <button className="btn primary" onClick={onNewCase}>
          Start a case
        </button>
      </div>
    </section>
  );
}
