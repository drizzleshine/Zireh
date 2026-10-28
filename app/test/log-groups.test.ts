import type { Receipt } from "@zireh/schema";
import { describe, expect, it } from "vitest";
import { groupByQuestion } from "../src/log-groups.ts";

const receipt = (id: string, at: string, extra: Partial<Receipt> = {}): Receipt => ({ id, at, destination: "relay", role: "real", payloadSha256: "0".repeat(64), payloadPreview: id, ...extra });

describe("privacy log grouping", () => {
  it("keeps a question's real and decoy requests together, newest question first", () => {
    const groups = groupByQuestion([
      receipt("a", "2026-10-28T10:00:01Z", { runId: "run-1" }),
      receipt("search", "2026-10-28T11:00:00Z", { destination: "search" }),
      receipt("b", "2026-10-28T10:00:00Z", { runId: "run-1", role: "decoy" }),
    ]);
    expect(groups.map((g) => g.receipts.map((r) => r.id))).toEqual([["search"], ["b", "a"]]);
    expect(groups[1]!.runId).toBe("run-1");
  });
});
