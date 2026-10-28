import { describe, expect, it } from "vitest";
import { fixedRate, zecCheckoutWatcher } from "../src/zcash/index.ts";

/** A stand-in ZecCheckout: one invoice per POST, status set by the test. */
function fakeService(overrides: { address?: string; amountZat?: (requested: number) => number } = {}) {
  const invoices = new Map<string, { id: string; status: string; amount_zat: number; received_zat: number; order_id: string }>();
  const seen: { method: string; path: string; auth: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ method: init?.method ?? "GET", path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { amount_zec: string; order_id: string; expires_in_secs: number };
      const requested = Math.round(Number(body.amount_zec) * 1e8);
      const id = `inv${invoices.size + 1}`;
      const invoice = { id, status: "pending", amount_zat: overrides.amountZat?.(requested) ?? requested, received_zat: 0, order_id: body.order_id };
      invoices.set(id, invoice);
      const address = overrides.address ?? `utest1${id}`;
      return Response.json({ ...invoice, address, payment_uri: `zcash:${address}?amount=${body.amount_zec}`, expires_at: 2_000_000_000 }, { status: 201 });
    }
    const invoice = invoices.get(url.pathname.split("/").pop()!);
    return invoice ? Response.json(invoice) : Response.json({ error: "not found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, invoices, seen };
}

const watcherFor = (service: ReturnType<typeof fakeService>) =>
  zecCheckoutWatcher({ url: "http://zeccheckout:10000/", apiKey: "k".repeat(24), network: "testnet", rate: fixedRate(50), fetch: service.fetch });

describe("zecCheckoutWatcher", () => {
  it("issues the service's fresh address and payment link for the quoted amount", async () => {
    const service = fakeService();
    const quote = await watcherFor(service).quote(5_000_000);
    expect(quote).toMatchObject({ credits: 5_000_000, zec: "0.10000000", address: "utest1inv1", paymentUri: "zcash:utest1inv1?amount=0.10000000", network: "testnet" });
    expect(quote.expiresAt).toBe(new Date(2_000_000_000_000).toISOString());
    expect(service.invoices.get("inv1")!.order_id).toBe(quote.quoteId);
    expect(service.seen[0]).toEqual({ method: "POST", path: "/api/v1/invoices", auth: `Bearer ${"k".repeat(24)}` });
  });

  it("follows the payment: seen → confirmed → minted once, and keeps partial amounts", async () => {
    const service = fakeService();
    const watcher = watcherFor(service);
    const { quoteId } = await watcher.quote(100);
    const invoice = service.invoices.get("inv1")!;

    await watcher.refresh!(quoteId);
    expect(watcher.state(quoteId)).toBe("quoted");

    Object.assign(invoice, { status: "underpaid", received_zat: 1 });
    await watcher.refresh!(quoteId);
    expect(watcher.state(quoteId)).toBe("paid");
    expect(watcher.received!(quoteId)).toBe("0.00000001");

    invoice.status = "paid";
    await watcher.refresh!(quoteId);
    expect(watcher.state(quoteId)).toBe("confirmed");
    watcher.markMinted(quoteId);
    expect(() => watcher.markMinted(quoteId)).toThrow("minted");

    // A later poll can't undo the mint, and doesn't ask the service again.
    const calls = service.seen.length;
    await watcher.refresh!(quoteId);
    expect(watcher.state(quoteId)).toBe("minted");
    expect(service.seen.length).toBe(calls);
  });

  it("credits a late payment after the quote expired", async () => {
    const service = fakeService();
    const watcher = watcherFor(service);
    const { quoteId } = await watcher.quote(100);
    service.invoices.get("inv1")!.status = "expired";
    await watcher.refresh!(quoteId);
    expect(watcher.state(quoteId)).toBe("expired");
    service.invoices.get("inv1")!.status = "paid";
    await watcher.refresh!(quoteId);
    expect(watcher.state(quoteId)).toBe("confirmed");
  });

  it("refuses an address for the wrong network or an amount it didn't ask for", async () => {
    await expect(watcherFor(fakeService({ address: "u1mainnetaddress" })).quote(100)).rejects.toThrow("wrong network");
    await expect(watcherFor(fakeService({ amountZat: (z) => z - 1 })).quote(100)).rejects.toThrow("wrong amount");
  });

  it("reports an unknown quote and an unknown service status", async () => {
    const service = fakeService();
    const watcher = watcherFor(service);
    expect(() => watcher.state("nope")).toThrow("unknown quote");
    const { quoteId } = await watcher.quote(100);
    service.invoices.get("inv1")!.status = "refunded";
    await expect(watcher.refresh!(quoteId)).rejects.toThrow("unknown status");
    expect(watcher.state(quoteId)).toBe("quoted");
  });
});
