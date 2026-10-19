import type { Receipt } from "@zireh/schema";
import { useEffect, useState } from "react";
import { api, formatUsd } from "../api.ts";

type Data = Awaited<ReturnType<typeof api.receipts>>;

/** Every payload that left this computer, as sent, with its hash and cost. */
export function LogPanel() {
  const [data, setData] = useState<Data | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    api.receipts().then(setData, (e: Error) => setError(e.message));
  }, []);

  if (error) return <section className="panel"><p className="error">{error}</p></section>;
  if (!data) return <section className="panel">Loading…</section>;
  const { summary, receipts } = data;

  return (
    <section className="panel" aria-label="Privacy log">
      <p className="doc" style={{ maxWidth: "70ch" }}>
        This log is kept only on this computer. Each row is exactly what was sent, after names were hidden. The hash lets you prove what
        a provider received.
      </p>
      <div className="summary">
        <div>
          <strong>{summary.calls}</strong>
          <span>requests sent</span>
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
                  {r.payloadPreview}
                  <div className="hash">sha256 {r.payloadSha256}</div>
                </td>
                <td>
                  {r.destination === "local" ? "Answered locally" : r.role === "decoy" ? "Decoy" : r.destination === "search" ? "Web search" : "Question"}
                  {r.circuit && <div className="level-note">circuit {r.circuit.slice(2, 8)}</div>}
                </td>
                <td className="num">
                  {r.charged !== undefined ? formatUsd(r.charged) : "free"}
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
