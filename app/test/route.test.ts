import { describe, expect, it } from "vitest";
import { parseRoute, routePath } from "../src/route.ts";

const id = "a".repeat(32);
const item = "b".repeat(32);

describe("routes", () => {
  it("round-trips every view through the address bar", () => {
    for (const route of [
      { view: "home" },
      { view: "settings" },
      { view: "case", caseId: id, tab: "research" },
      { view: "case", caseId: id, tab: "board" },
      { view: "case", caseId: id, tab: "evidence", item },
    ] as const) expect(parseRoute(routePath(route))).toEqual(route);
  });

  it("falls back safely on unknown tabs, bad ids and junk", () => {
    expect(parseRoute(`/case/${id}/nope/${item}`)).toEqual({ view: "case", caseId: id, tab: "research" });
    expect(parseRoute("/case/../../etc")).toEqual({ view: "home" });
    expect(parseRoute(`/case/${id}/evidence/<script>`)).toEqual({ view: "case", caseId: id, tab: "evidence" });
    expect(parseRoute("/anything/else")).toEqual({ view: "home" });
  });
});
