import { sha256Hex, canonicalJson } from "@zireh/crypto";
import { describe, expect, it } from "vitest";
import { Ledger } from "../src/index.ts";

describe("Ledger", () => {
  it("hashes exactly the wire payload and summarizes spend", () => {
    const ledger = new Ledger();
    const payload = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "Is [PERSON_1] at risk?" },
    ];
    const r = ledger.record({ destination: "relay", role: "real", payload, circuit: "c-1", charged: 120, expectedCharge: 120, overcharged: false });
    ledger.record({ destination: "relay", role: "decoy", payload: [{ role: "user", content: "decoy" }], charged: 80 });
    ledger.record({ destination: "local", role: "real", payload: "local only" });
    expect(r.payloadSha256).toBe(sha256Hex(canonicalJson(payload)));
    expect(r.payloadPreview).toBe("Is [PERSON_1] at risk?");
    expect(ledger.summary()).toEqual({ calls: 2, real: 1, decoys: 1, spent: 200, overcharges: 0 });
  });

  it("keeps which question a request belongs to, for grouping on this device", () => {
    const ledger = new Ledger();
    ledger.record({ destination: "relay", role: "real", runId: "run-1", caseId: "case-1", payload: "q" });
    expect(ledger.receipts()[0]).toMatchObject({ runId: "run-1", caseId: "case-1" });
  });

  it("enforces the run state machine", () => {
    const ledger = new Ledger();
    ledger.startRun("r1", "p1", 500);
    ledger.advance("r1", "submitted");
    expect(() => ledger.advance("r1", "prepared")).toThrow(/illegal/);
    expect(ledger.advance("r1", "settled", { charged: 200 }).charged).toBe(200);
    expect(() => ledger.advance("r1", "failed")).toThrow(/illegal/);
  });
});
