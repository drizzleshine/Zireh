import { STOCK, stockDecoys } from "@zireh/shield";
import { describe, expect, it } from "vitest";
import { compile, finish, NeedsLocalModel } from "../src/index.ts";

describe("without an on-device model", () => {
  const table = [{ original: "Ada Obi", placeholder: "[PERSON_1]", kind: "person" as const, hint: "a reporter" }];
  const input = { task: "Is Ada Obi at risk after her report on Apapa port? Email ada@example.org", level: "standard" as const, table, salt: "s" };

  it("sends the question as written, including names on the hide list", async () => {
    const plan = await compile(undefined, input);
    const real = plan.pieces.filter((p) => p.role === "real");
    expect(real).toHaveLength(1);
    const outbound = JSON.stringify(plan.pieces.map((p) => p.messages));
    expect(outbound).toContain("Ada Obi");
    expect(outbound).toContain("Apapa");
    expect(outbound).toContain("ada@example.org");
    expect(plan.table.map((p) => p.original)).toEqual(["Ada Obi"]);
  });

  it("sends Direct as one question with no decoys", async () => {
    const plan = await compile(undefined, input);
    expect(plan.pieces.filter((p) => p.role === "decoy")).toHaveLength(0);
  });

  it("refuses every level but Direct, since they need the model", async () => {
    for (const level of ["local", "private", "paranoid"] as const) await expect(compile(undefined, { ...input, level })).rejects.toBeInstanceOf(NeedsLocalModel);
  });

  it("draws stock decoys that pass the same checks", () => {
    const decoys = stockDecoys("Is a journalist at risk after reporting on a port?", 3);
    expect(decoys).toHaveLength(3);
    for (const d of decoys) expect(STOCK).toContain(d);
  });

  it("shows the real answer with names restored", async () => {
    const plan = await compile(undefined, { ...input, level: "standard" });
    const real = plan.pieces.find((p) => p.role === "real")!;
    const outcome = await finish(undefined, plan, new Map([[real.id, "She should vary her routes."]]));
    expect(outcome.answer).toBe("She should vary her routes.");
  });
});
