import type { Receipt } from "@zireh/schema";
import { useEffect, useState } from "react";
import { api, formatUsd } from "../api.ts";

type Data = Awaited<ReturnType<typeof api.receipts>>;

/** Every payload that left this computer, as sent, with its hash and cost. */
export function LogPanel({ caseId }: { caseId: string }) {
  const [data, setData] = useState<Data | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [scope, setScope] = useState<"case" | "all">("case");
  useEffect(() => {
    api.receipts(scope === "case" ? caseId : undefined).then(setData, (e: Error) => setError(e.message));
  }, [caseId, scope]);

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
      {data.disputes?.map((dispute) => <p className="error" key={dispute.requestId} role="alert">
        {dispute.reason} Request {dispute.requestId}. Its recovery record is retained; change has not been accepted.
      </p>)}
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
                  {(r.state === "failed" || r.state === "disputed") && r.error && <div className="error">{r.error}</div>}
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
