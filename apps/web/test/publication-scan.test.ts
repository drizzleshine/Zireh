import { afterEach, expect, it, vi } from "vitest";
import { scanPublicationTexts } from "../src/api.ts";
afterEach(() => vi.unstubAllGlobals());
it("scans all fields beyond the daemon batch limit while retaining earlier detections", async () => {
  const sizes: number[] = [], priorCounts: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    sizes.push(body.texts.length); priorCounts.push(body.table.length);
    return Response.json({ table: [...body.table, { original: `source ${sizes.length}`, placeholder: `[PERSON_${sizes.length}]`, kind: "person" }] });
  }));
  const table = await scanPublicationTexts(Array.from({ length: 201 }, (_, i) => `field ${i}`), []);
  expect(sizes).toEqual([100, 100, 1]);
  expect(priorCounts).toEqual([0, 1, 2]);
  expect(table).toHaveLength(3);
});
