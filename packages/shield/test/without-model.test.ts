import { STOCK, stockDecoys } from "@zireh/decoy";
import { describe, expect, it } from "vitest";
import { compile, finish, NeedsLocalModel } from "../src/index.ts";

describe("without an on-device model", () => {
  const input = { task: "Is Ada Obi at risk after her report on Apapa port? Email ada@example.org", level: "standard" as const, table: [], salt: "s" };

  it("hides every name-like phrase and pattern, and sends the task as one question", async () => {
    const plan = await compile(undefined, input);
    const real = plan.pieces.filter((p) => p.role === "real");
    expect(real).toHaveLength(1);
    const outbound = JSON.stringify(plan.pieces.map((p) => p.messages));
    for (const secret of ["Ada Obi", "Apapa", "ada@example.org"]) expect(outbound).not.toContain(secret);
    expect(plan.table.map((p) => p.original)).toEqual(expect.arrayContaining(["Ada Obi", "ada@example.org"]));
  });

  it("sends Standard as one question with no decoys", async () => {
    const plan = await compile(undefined, input);
    expect(plan.pieces.filter((p) => p.role === "decoy")).toHaveLength(0);
  });

  it("refuses every level but Standard, since they need the model", async () => {
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
    const placeholder = plan.table.find((p) => p.original === "Ada Obi")!.placeholder;
    const outcome = await finish(undefined, plan, new Map([[real.id, `${placeholder} should vary her routes.`]]));
    expect(outcome.answer).toBe("Ada Obi should vary her routes.");
  });
});
