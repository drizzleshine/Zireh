import { expect, it, vi } from "vitest";
import type { Pseudonym } from "@zireh/schema";

const sizes: number[] = [], priorCounts: number[] = [];
vi.mock("../src/engine/index.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  redact: vi.fn(async (texts: string[], table: Pseudonym[]) => {
    sizes.push(texts.length); priorCounts.push(table.length);
    return { table: [...table, { original: `source ${sizes.length}`, placeholder: `[PERSON_${sizes.length}]`, kind: "person" }] };
  }),
}));
const { scanPublicationTexts } = await import("../src/api.ts");

it("scans all fields beyond the pipeline's batch limit while retaining earlier detections", async () => {
  const table = await scanPublicationTexts(Array.from({ length: 201 }, (_, i) => `field ${i}`), []);
  expect(sizes).toEqual([100, 100, 1]);
  expect(priorCounts).toEqual([0, 1, 2]);
  expect(table).toHaveLength(3);
});
