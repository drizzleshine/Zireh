import type { Receipt } from "@zireh/schema";
import { useEffect, useState } from "react";
import { api, formatUsd } from "../api.ts";

type Data = Awaited<ReturnType<typeof api.receipts>>;

/** Every payload that left this computer, as sent, with its hash and cost. */
export function LogPanel({ caseId }: { caseId: string }) {
  const [data, setData] = useState<Data | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [confirmLoss, setConfirmLoss] = useState<string | undefined>();
  const [scope, setScope] = useState<"case" | "all">("case");
  useEffect(() => {
    api.receipts(scope === "case" ? caseId : undefined).then(setData, (e: Error) => setError(e.message));
  }, [caseId, scope]);

  async function resolveDispute(requestId: string, action: "retry" | "write-off") {
    setBusy(requestId); setActionError(undefined);
    try {
      if (action === "retry") await api.retryDispute(requestId);
      else await api.writeOffDispute(requestId);
      setConfirmLoss(undefined);
    } catch (e) { setActionError((e as Error).message); }
    finally {
      try { setData(await api.receipts(scope === "case" ? caseId : undefined)); }
      catch (e) { setActionError((e as Error).message); }
      setBusy(undefined);
    }
  }

  if (error) return <section className="panel"><p className="error">{error}</p></section>;
  if (!data) return <section className="panel">Loading…</section>;
  const { summary, receipts } = data;

  return (
    <section className="panel" aria-label="Privacy log">
      <p className="doc" style={{ maxWidth: "70ch" }}>
        Paid research and search requests attempted by this computer. The log stays here.
        Each row keeps the complete request body and its hash; a failed attempt may still have reached the provider.
      </p>
      <div className="levels" role="group" aria-label="Which requests">
        <button aria-pressed={scope === "case"} onClick={() => setScope("case")}>
          This case
        </button>
        <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>
          All cases
        </button>
      </div>
      <div className="summary">
        <div>
          <strong>{summary.calls}</strong>
          <span>requests attempted</span>
        </div>
        <div>
          <strong>{summary.decoys}</strong>
          <span>of them decoys</span>
        </div>
        <div>
          <strong>{formatUsd(summary.spent)}</strong>
          <span>spent</span>
        </div>
        <div>
          <strong>{summary.overcharges}</strong>
          <span>overcharges detected</span>
        </div>
      </div>
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {data.disputes?.map((dispute) => <div key={dispute.requestId}>
        <p className="error" role="alert">{dispute.reason} Request {dispute.requestId}.
          {" "}{formatUsd(dispute.amount)} ({dispute.amount.toLocaleString()} credits) at stake. Automatic retries are paused.</p>
        <div className="actions">
          <button disabled={!!busy} onClick={() => void resolveDispute(dispute.requestId, "retry")}>{busy === dispute.requestId ? "Working…" : "Re-check once"}</button>
          {confirmLoss === dispute.requestId ? <>
            <span>Accept this loss permanently? The audit record will be kept.</span>
            <button disabled={!!busy} onClick={() => void resolveDispute(dispute.requestId, "write-off")}>Accept loss</button>
            <button disabled={!!busy} onClick={() => setConfirmLoss(undefined)}>Keep dispute</button>
          </> : <button disabled={!!busy} onClick={() => setConfirmLoss(dispute.requestId)}>Write off…</button>}
        </div>
      </div>)}
      {data.writtenOff?.map((entry) => <p key={entry.requestId}>Written off {formatUsd(entry.amount)} ({entry.amount.toLocaleString()} credits)
        {" "}on {new Date(entry.at).toLocaleString()}. Request {entry.requestId}. {entry.reason}</p>)}
      {receipts.length === 0 ? (
        <div className="empty">
          <strong>Nothing has been sent yet</strong>
          Ask a question in Research and every request will be listed here.
        </div>
      ) : (
        <table className="log">
          <thead>
            <tr>
              <th>When</th>
              <th>Sent</th>
              <th>Kind</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r: Receipt) => (
              <tr key={r.id}>
                <td className="num">{new Date(r.at).toLocaleString()}</td>
                <td className="wire">
                  {(() => {
                    const m = /^Session ([0-9a-f]{64})\n\n([\s\S]*)$/.exec(r.payloadPreview);
                    return m ? (
                      <>
                        <span className="salt">case salt {m[1]!.slice(0, 10)}…</span>
                        <div>{m[2]}</div>
                      </>
                    ) : (
                      r.payloadPreview
                    );
                  })()}
                  <div className="hash">sha256 {r.payloadSha256}</div>
                  {r.payloadWire && <details><summary>Complete request body</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.payloadWire}</pre></details>}
                  {(r.state === "failed" || r.state === "disputed" || r.state === "written-off") && r.error && <div className="error">{r.error}</div>}
                </td>
                <td>
                  {r.destination === "local" ? "Answered locally" : r.role === "decoy" ? "Decoy" : r.destination === "search" ? "Web search" : "Question"}
                  {r.state && <div className="level-note">{r.state}</div>}
                  {r.circuit && <div className="level-note">circuit {r.circuit.slice(2, 8)}</div>}
                </td>
                <td className="num">
                  {r.charged !== undefined ? formatUsd(r.charged) : r.destination === "local" ? "free" : "unsettled"}
                  {r.overcharged && <div className="error">billed more than used</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
