import { scriptedModel } from "@zireh/llm";
import { describe, expect, it } from "vitest";
import { makeDecoys } from "../src/index.ts";

const real = "What documents does a refugee need for a first asylum interview?";

describe("makeDecoys", () => {
  it("returns n usable decoys and filters bad ones", async () => {
    const model = scriptedModel(() =>
      JSON.stringify({
        decoys: [
          real, // the real question itself
          "Why?", // far too short
          "Which records should a renter bring to a first housing tribunal hearing?",
          "What paperwork does a new founder need for a first bank account meeting?",
        ],
      }),
    );
    expect(await makeDecoys(model, real, 2)).toEqual([
      "Which records should a renter bring to a first housing tribunal hearing?",
      "What paperwork does a new founder need for a first bank account meeting?",
    ]);
  });

  it("fails when too few decoys survive filtering", async () => {
    const model = scriptedModel(() => JSON.stringify({ decoys: [real, "Which records should a renter bring to court?"] }));
    await expect(makeDecoys(model, real, 2)).rejects.toThrow(/only 1 of 2/);
  });

  it("rejects decoys with placeholders the real question doesn't use", async () => {
    const realWithPlace = "What legal protections exist for reporters working in [PLACE_1]?";
    const model = scriptedModel(() =>
      JSON.stringify({
        decoys: ["What labor laws protect dock workers in [NEW_PLACE_1]?", "What tax rules apply to freelance writers in [PLACE_1]?"],
      }),
    );
    expect(await makeDecoys(model, realWithPlace, 1)).toEqual(["What tax rules apply to freelance writers in [PLACE_1]?"]);
  });

  it("asks nothing for zero decoys", async () => {
    const model = scriptedModel(() => {
      throw new Error("should not be called");
    });
    expect(await makeDecoys(model, real, 0)).toEqual([]);
  });
});
