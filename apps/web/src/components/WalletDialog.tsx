import type { TopupQuote } from "@zireh/schema";
import { useState } from "react";
import { api, formatUsd } from "../api.ts";
import { Dialog } from "./Dialog.tsx";

const AMOUNTS = [1, 5, 20];

/** Top up: quote → pay in shielded ZEC → redeem blind-signed coins. */
export function WalletDialog({ onClose, onBalanceChange }: { onClose: () => void; onBalanceChange: () => void }) {
  const [usd, setUsd] = useState(5);
  const [quote, setQuote] = useState<TopupQuote | undefined>();
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [balance, setBalance] = useState<number | undefined>();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Top up" onClose={onClose}>
      {balance !== undefined ? (
        <>
          <p>
            Added {formatUsd(quote!.credits)}. Your balance is <strong>{formatUsd(balance)}</strong>.
          </p>
          <p className="level-note">
            Your balance is held as blind-signed coins on this computer. The relay can't link them to this payment or to each other.
          </p>
          <div className="dialog-foot">
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : !quote ? (
        <>
          <div className="field">
            <span id="amount-label" style={{ fontWeight: 600, fontSize: "var(--s-13)" }}>
              Amount
            </span>
            <div className="levels" role="group" aria-labelledby="amount-label">
              {AMOUNTS.map((a) => (
                <button key={a} aria-pressed={usd === a} onClick={() => setUsd(a)}>
                  ${a}
                </button>
              ))}
            </div>
            <span className="hint">About {Math.round((usd * 1_000_000) / 500)} private research questions at the Standard level.</span>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="dialog-foot">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy} onClick={() => run(async () => setQuote(await api.quote(usd * 1_000_000)))}>
              Get payment address
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="quote">
            <span className="level-note">Send exactly</span>
            <strong>{quote.zec} ZEC</strong>
            <span className="level-note">to this fresh shielded address</span>
            <span className="addr">{quote.address}</span>
            <span className="level-note">Valid until {new Date(quote.expiresAt).toLocaleTimeString()}</span>
          </div>
          {quote.network === "simulated" ? (
            <p className="notice">
              This relay runs on a simulated Zcash network for the demo. No real ZEC moves; "Mark as paid" stands in for the shielded
              payment.
            </p>
          ) : (
            <p className="notice">Pay from your own shielded wallet. Paying straight from an exchange tells the exchange you paid this relay.</p>
          )}
          {error && <p className="error">{error}</p>}
          <div className="dialog-foot">
            {quote.network === "simulated" && !paid && (
              <button className="btn" disabled={busy} onClick={() => run(async () => (await api.simulatePayment(quote.quoteId), setPaid(true)))}>
                Mark as paid
              </button>
            )}
            <button
              className="btn primary"
              disabled={busy || (quote.network === "simulated" && !paid)}
              onClick={() =>
                run(async () => {
                  const { balance } = await api.redeem(quote);
                  setBalance(balance);
                  onBalanceChange();
                })
              }
            >
              Redeem coins
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
