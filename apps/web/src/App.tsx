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
import { createDemoCase } from "./demo.ts";
import { useStore } from "./store.ts";

export function App() {
  const [status, setStatus] = useState<DaemonStatus | undefined>();
  const [daemonError, setDaemonError] = useState<string | undefined>();
  const [selected, setSelectedRaw] = useState<string | undefined>();
  const [home, setHome] = useState(false);
  const setSelected = (id: string | undefined) => {
    if (id) setHome(false);
    setSelectedRaw(id);
  };
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
    if (selected && !ids.includes(selected)) setSelectedRaw(undefined); // e.g. a join that was rolled back
    else if (!selected && !home && ids.length) setSelectedRaw(ids[ids.length - 1]);
  }, [caseIds, selected, home]);

  return (
    <div className="shell">
      <Rail
        status={status}
        daemonError={daemonError}
        selected={selected}
        onSelect={setSelected}
        onTopUp={() => setDialog("wallet")}
        onNewCase={() => setDialog("new-case")}
        onDemo={async () => setSelected(await createDemoCase("You"))}
        onHome={() => {
          setHome(true);
          setSelected(undefined);
        }}
      />
      <main className="main">
        <ErrorBoundary key={selected}>
        {selected ? (
          <CaseView key={selected} caseId={selected} status={status} onBalanceChange={refresh} onTopUp={() => setDialog("wallet")} />
        ) : (
          <Welcome
            onNewCase={() => setDialog("new-case")}
            onDemo={async () => setSelected(await createDemoCase("You"))}
          />
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

function Welcome({ onNewCase, onDemo }: { onNewCase: () => void; onDemo: () => void }) {
  return (
    <section className="welcome">
      <h1>Investigate together. Ask powerful AI. Keep your sources to yourselves.</h1>
      <figure className="specimen" aria-label="Example of what Zireh sends">
        <div className="specimen-side">
          <span className="specimen-label">You write</span>
          <p className="doc">
            Is <span className="redacted" style={{ ["--i" as string]: 0 }}>Ada Obi</span> at risk after her report on smuggling at{" "}
            <span className="redacted" style={{ ["--i" as string]: 1 }}>Apapa port</span> in <span className="redacted" style={{ ["--i" as string]: 2 }}>Lagos</span>?
          </p>
        </div>
        <div className="specimen-side sent">
          <span className="specimen-label">The AI provider receives, over Tor, from nobody in particular</span>
          <p className="doc">Is a journalist at risk after her report on smuggling at a port in a city in West Africa?</p>
          <p className="doc decoy-line">
            <span className="decoy-tag">decoy</span>Which soils hold water best for dry-season maize?
          </p>
        </div>
      </figure>
      <p className="welcome-copy">
        Names are hidden on this computer by an NVIDIA Nemotron model before anything leaves. Questions are split, mixed with decoys and paid
        with unlinkable coins. Case files are end-to-end encrypted for your team.
      </p>
      <div className="welcome-actions">
        <button className="btn primary" onClick={onNewCase}>
          Start a case
        </button>
        <button className="btn" onClick={onDemo}>
          Try a fictional demo case
        </button>
      </div>
    </section>
  );
}
