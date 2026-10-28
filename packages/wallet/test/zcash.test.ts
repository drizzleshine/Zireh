import { describe, expect, it } from "vitest";
import { creditsToZec, fixedRate, simulatedWatcher } from "../src/zcash/index.ts";

describe("creditsToZec", () => {
  it("converts µUSD to ZEC with 8 decimals, rounding up", () => {
    expect(creditsToZec(5_000_000, fixedRate(50))).toBe("0.10000000"); // $5 at $50/ZEC
    expect(creditsToZec(1, fixedRate(50))).toBe("0.00000002"); // never rounds to zero
  });
});

describe("simulatedWatcher", () => {
  it("walks quoted → confirmed → minted and never mints twice", () => {
    const w = simulatedWatcher(fixedRate(50));
    const q = w.quote(1_000_000);
    expect(q.network).toBe("simulated");
    expect(q.address.startsWith("usim1")).toBe(true);
    expect(w.state(q.quoteId)).toBe("quoted");
    expect(() => w.markMinted(q.quoteId)).toThrow(/not confirmed/);
    w.simulatePayment(q.quoteId);
    expect(w.state(q.quoteId)).toBe("confirmed");
    w.markMinted(q.quoteId);
    expect(() => w.markMinted(q.quoteId)).toThrow();
  });

  it("expires unpaid quotes after 15 minutes", () => {
    let t = 0;
    const w = simulatedWatcher(fixedRate(50), () => t);
    const q = w.quote(100);
    t = 16 * 60 * 1000;
    expect(w.state(q.quoteId)).toBe("expired");
    expect(() => w.simulatePayment(q.quoteId)).toThrow(/expired/);
  });

  it("gives every quote a fresh address", () => {
    const w = simulatedWatcher(fixedRate(50));
    expect(w.quote(1).address).not.toBe(w.quote(1).address);
  });
});
