import type { DaemonStatus } from "@zireh/schema";
import { formatUsd } from "../api.ts";
import { useStore } from "../store.ts";

interface Props {
  status: DaemonStatus | undefined;
  daemonError: string | undefined;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onTopUp: () => void;
  onNewCase: () => void;
  onDemo: () => void;
  onHome: () => void;
  onHow: () => void;
}

export function Rail({ status, daemonError, selected, onSelect, onTopUp, onNewCase, onDemo, onHome, onHow }: Props) {
  const cases = useStore((s) => s.workspaces.map((w) => ({ id: w.caseId, c: s.cases[w.caseId]?.case, members: s.cases[w.caseId]?.members.length ?? 0 })));

  return (
    <nav className="rail" aria-label="Zireh">
      <button className="brand" onClick={onHome} aria-label="Zireh home">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="6" fill="currentColor" />
          <rect x="7" y="9" width="18" height="4" rx="1" fill="var(--paper)" />
          <rect x="7" y="15" width="11" height="4" rx="1" fill="var(--viridian)" />
          <rect x="7" y="21" width="15" height="4" rx="1" fill="var(--paper)" />
        </svg>
        Zireh
      </button>

      <section aria-labelledby="health-title">
        <h2 id="health-title" className="section-title">
          Connection
        </h2>
        {daemonError ? (
          <p className="error">{daemonError}</p>
        ) : (
          <div className="health">
            <Health
              label="Tor"
              state={!status ? "idle" : status.transport === "direct" ? "bad" : status.tor.ready ? "ok" : "warn"}
              detail={!status ? "" : status.transport === "direct" ? "off (dev mode)" : status.tor.ready ? "connected" : `${status.tor.progress}%`}
            />
            <Health label="Local model" state={!status ? "idle" : status.localModel.ok ? "ok" : "bad"} detail={status?.localModel.id ?? ""} />
            <Health
              label="Relay"
              state={!status ? "idle" : status.relay.ok ? "ok" : "bad"}
              detail={!status ? "" : status.relay.ok ? (status.relay.network === "simulated" ? "simulated pay" : status.relay.network ?? "") : "unreachable"}
            />
          </div>
        )}
      </section>

      <section aria-labelledby="wallet-title">
        <h2 id="wallet-title" className="section-title">
          Balance
        </h2>
        <div className="balance">
          <strong>{status ? formatUsd(status.balance) : "—"}</strong>
          <button className="btn small" onClick={onTopUp} disabled={!status?.relay.ok}>
            Top up
          </button>
        </div>
        {status && status.pendingCalls > 0 && <p className="level-note">{status.pendingCalls} call(s) waiting to settle</p>}
      </section>

      <section aria-labelledby="cases-title">
        <h2 id="cases-title" className="section-title">
          Cases
        </h2>
        <ul className="case-list">
          {cases.map(({ id, c, members }) => (
            <li key={id}>
              <button aria-current={id === selected} onClick={() => onSelect(id)}>
                {c?.title ?? "Syncing…"}
                <span className="sub">{members === 1 ? "Just you" : `${members} members`}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="rail-actions">
          <button className="btn quiet" onClick={onNewCase}>
            + New case
          </button>
          <button className="btn quiet" onClick={onDemo}>
            Try the demo
          </button>
        </div>
      </section>

      <button className="btn quiet how-link" onClick={onHow}>
        How Zireh protects you
      </button>
    </nav>
  );
}

function Health({ label, state, detail }: { label: string; state: "ok" | "warn" | "bad" | "idle"; detail: string }) {
  return (
    <div className="health-row">
      <span className={`dot ${state === "idle" ? "" : state}`} aria-hidden="true" />
      <span>{label}</span>
      <span className="detail">{detail}</span>
    </div>
  );
}
