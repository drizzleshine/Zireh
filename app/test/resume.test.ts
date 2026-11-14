import { describe, expect, it } from "vitest";
import { planResume } from "../src/model/resume.ts";

describe("planResume", () => {
  it("appends when the server continues from the bytes already stored", () => {
    expect(planResume(206, "bytes 1000-1999/2000", "1000", 1000)).toEqual({ action: "append", total: 2000 });
  });

  it("starts over when the server sends the whole file", () => {
    expect(planResume(200, null, "2000", 1000)).toEqual({ action: "restart", total: 2000 });
  });

  it("ignores a range that does not line up with what is stored", () => {
    expect(planResume(206, "bytes 50-1999/2000", "1950", 1000)).toEqual({ action: "passthrough" });
  });
});
