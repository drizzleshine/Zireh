import type { QuoteStatus, TopupQuote } from "@zireh/schema";
import { ArrowSquareOut, Check, Copy, CircleNotch as Loader2, ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { api, formatUsd } from "../api.ts";
import { database, Keys } from "../persistence.ts";
import { Dialog } from "./Dialog.tsx";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const AMOUNTS = [1, 5, 20];
const POLL_MS = 5000;

/** The quote waiting for payment survives closing the dialog and reloading the page. */
const savePending = (quote: TopupQuote | undefined) =>
  database.write((store) => (quote ? store.put(quote, Keys.pendingTopup) : store.delete(Keys.pendingTopup))).catch(() => {});

/** ZIP 321 link: wallets open with the address and amount filled in. */
const paymentLink = (quote: TopupQuote) => quote.paymentUri ?? `zcash:${quote.address}?amount=${Number(quote.zec)}`;

/**
 * Top up: pick an amount → pay the fresh shielded address from any Zcash wallet → coins arrive.
 * The dialog watches the payment itself and redeems the coins once it confirms.
 */
export function WalletDialog({ onClose, onBalanceChange }: { onClose: () => void; onBalanceChange: () => void }) {
  const [usd, setUsd] = useState(5);
  const [quote, setQuote] = useState<TopupQuote | undefined>();
  const [status, setStatus] = useState<QuoteStatus | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [balance, setBalance] = useState<number | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0); // bump to check the payment right away
  const balanceChanged = useRef(onBalanceChange);
  balanceChanged.current = onBalanceChange;

  useEffect(() => {
    void database.get<TopupQuote>(Keys.pendingTopup).then(
      (pending) => { if (pending) setQuote(pending); setLoaded(true); },
      () => setLoaded(true),
    );
  }, []);

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

  const start = () =>
    run(async () => {
      const fresh = await api.quote(usd * 1_000_000);
      await savePending(fresh);
      setStatus(undefined);
      setQuote(fresh);
    });

  const forget = () => {
    void savePending(undefined);
    setQuote(undefined);
    setStatus(undefined);
    setError(undefined);
  };

  // Watch the payment. Once it confirms, redeem: minting is idempotent, so a repeat is harmless.
  const redeeming = useRef(false);
  useEffect(() => {
    if (!quote || balance !== undefined) return;
    let stopped = false;
    const check = async () => {
      try {
        const next = await api.quoteStatus(quote.quoteId);
        if (stopped) return;
        setStatus(next);
        setError(undefined);
        if ((next.state === "confirmed" || next.state === "minted") && !redeeming.current) {
          redeeming.current = true;
          try {
            const result = await api.redeem(quote);
            await savePending(undefined);
            setBalance(result.balance);
            balanceChanged.current();
          } finally {
            redeeming.current = false;
          }
        }
      } catch (err) {
        if (!stopped) setError((err as Error).message);
      }
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [quote, balance, tick]);

  return (
    <Dialog title="Top up" description="Pay with private Zcash. You get coins to spend on questions." onClose={onClose}>
      {balance !== undefined && quote ? (
        <div className="grid gap-4">
          <div className="flex items-center gap-3 rounded-lg border border-protected/40 bg-protected-wash p-4">
            <Check className="size-5 text-protected" />
            <p className="text-sm">
              Added {formatUsd(quote.credits)}. Balance <strong className="tabular-nums">{formatUsd(balance)}</strong>.
            </p>
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : !loaded ? (
        <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />
      ) : !quote ? (
        <div className="grid gap-4">
          <ToggleGroup type="single" variant="outline" value={String(usd)} onValueChange={(v) => v && setUsd(Number(v))} className="w-full" aria-label="Amount">
            {AMOUNTS.map((a) => (
              <ToggleGroupItem key={a} value={String(a)} className="h-14 flex-1 text-lg font-semibold tabular-nums">
                ${a}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">Roughly {Math.round((usd * 1_000_000) / 500).toLocaleString()} questions at the Standard level. Unused coins stay yours.</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void start()}>
              {busy && <Loader2 className="animate-spin" />} Get payment address
            </Button>
          </div>
        </div>
      ) : (
        <Payment quote={quote} status={status} error={error} busy={busy} onSimulate={() => run(async () => { await api.simulatePayment(quote.quoteId); setTick((t) => t + 1); })} onForget={forget} onRestart={() => { forget(); void start(); }} />
      )}
    </Dialog>
  );
}

export function Payment({ quote, status, error, busy, onSimulate, onForget, onRestart }: {
  quote: TopupQuote;
  status: QuoteStatus | undefined;
  error: string | undefined;
  busy: boolean;
  onSimulate: () => void;
  onForget: () => void;
  onRestart: () => void;
}) {
  const link = paymentLink(quote);
  const qr = useMemo(() => renderSVG(link, { border: 1 }), [link]);
  const state = status?.state ?? "quoted";
  const simulated = quote.network === "simulated";
  const short = status?.received !== undefined && Number(status.received) < Number(quote.zec);
  const nothingSent = state === "quoted" || (state === "expired" && !status?.received);
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`), () => toast.error("Couldn't copy"));

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
        {/* The QR code stays black on white in both themes so every wallet camera can read it. */}
        <div className="mx-auto size-36 rounded-md bg-white p-1 sm:mx-0 [&>svg]:size-full" role="img" aria-label="QR code for this payment" dangerouslySetInnerHTML={{ __html: qr }} />
        <div className="grid min-w-0 content-start gap-2">
          <span className="text-xs text-muted-foreground">Send exactly</span>
          <button type="button" className="w-fit text-left text-2xl font-semibold tabular-nums hover:underline" onClick={() => copy(quote.zec, "Amount")} title="Copy amount">
            {quote.zec} ZEC
          </button>
          <div className="flex items-start gap-2">
            <code className="flex-1 break-all rounded bg-muted p-2 text-[11px] leading-relaxed">{quote.address}</code>
            <Button size="icon" variant="outline" className="size-8" aria-label="Copy address" onClick={() => copy(quote.address, "Address")}>
              <Copy />
            </Button>
          </div>
          {!simulated && (
            <Button asChild variant="outline" size="sm" className="w-fit">
              <a href={link}>
                <ArrowSquareOut /> Open in wallet
              </a>
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-md border p-3 text-sm" role="status" aria-live="polite">
        {state === "expired" ? null : <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />}
        <div className="grid gap-0.5">
          <span>
            {state === "quoted" && (simulated ? "Waiting for “Mark as paid”." : "Waiting for your payment…")}
            {state === "paid" && (short ? `Received ${status!.received} of ${quote.zec} ZEC. Send the rest to the same address.` : "Payment seen. Waiting for it to confirm.")}
            {(state === "confirmed" || state === "minted") && "Confirmed. Adding your coins…"}
            {state === "expired" && "This address has expired."}
          </span>
          <span className="text-xs text-muted-foreground">
            {state === "quoted" && `Pay before ${new Date(quote.expiresAt).toLocaleTimeString()}. You can close this; it keeps watching next time you open it.`}
            {state === "paid" && !short && "Usually a few minutes (3 blocks)."}
            {state === "expired" && "Already paid? It still counts once it confirms — keep this open."}
          </span>
        </div>
      </div>

      <p className="flex gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" />
        {simulated
          ? "This is test money. No real Zcash moves; “Mark as paid” pretends to pay."
          : quote.network === "testnet"
            ? "Zcash testnet: pay with testnet coins (TAZ), which have no value. Use a wallet set to testnet."
            : "Pay from your own private wallet. Paying from an exchange tells the exchange who you paid."}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        {nothingSent && (
          <Button variant="ghost" onClick={onForget}>
            Cancel top-up
          </Button>
        )}
        {state === "expired" && nothingSent && (
          <Button variant="outline" disabled={busy} onClick={onRestart}>
            Get a new address
          </Button>
        )}
        {simulated && state === "quoted" && (
          <Button disabled={busy} onClick={onSimulate}>
            {busy && <Loader2 className="animate-spin" />} Mark as paid
          </Button>
        )}
      </div>
    </div>
  );
}
