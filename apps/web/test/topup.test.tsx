import type { QuoteStatus, TopupQuote } from "@zireh/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Payment } from "../src/components/WalletDialog.tsx";

const quote: TopupQuote = {
  quoteId: "a".repeat(32),
  credits: 5_000_000,
  zec: "0.10000000",
  address: "utest1fresh",
  paymentUri: "zcash:utest1fresh?amount=0.1",
  expiresAt: new Date(2_000_000_000_000).toISOString(),
  network: "testnet",
};
const render = (status?: QuoteStatus, q: TopupQuote = quote) =>
  renderToStaticMarkup(<Payment quote={q} status={status} error={undefined} busy={false} onSimulate={() => {}} onForget={() => {}} onRestart={() => {}} />);

describe("Top up payment screen", () => {
  it("shows a scannable QR, the wallet link and the testnet warning while waiting", () => {
    const html = render();
    expect(html).toContain("<svg");
    expect(html).toContain('href="zcash:utest1fresh?amount=0.1"');
    expect(html).toContain("Waiting for your payment");
    expect(html).toContain("testnet coins (TAZ)");
    expect(html).toContain("Cancel top-up");
  });

  it("tells a short payment apart from one waiting to confirm, and hides Cancel once money arrived", () => {
    const short = render({ state: "paid", received: "0.04000000" });
    expect(short).toContain("Received 0.04000000 of 0.10000000 ZEC. Send the rest to the same address.");
    expect(short).not.toContain("Cancel top-up");
    expect(render({ state: "paid", received: "0.10000000" })).toContain("Payment seen. Waiting for it to confirm.");
    expect(render({ state: "confirmed" })).toContain("Adding your coins");
  });

  it("keeps an expired quote watchable and offers a new address only if nothing was sent", () => {
    const empty = render({ state: "expired" });
    expect(empty).toContain("Already paid? It still counts once it confirms");
    expect(empty).toContain("Get a new address");
    expect(render({ state: "expired", received: "0.01000000" })).not.toContain("Get a new address");
  });

  it("builds the payment link itself and offers Mark as paid on the simulated network", () => {
    const { paymentUri: _omit, ...plain } = quote;
    const html = render(undefined, { ...plain, network: "simulated" });
    expect(html).toContain("Mark as paid");
    expect(html).not.toContain("Open in wallet");
  });
});
