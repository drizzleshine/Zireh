import { describe, expect, it } from "vitest";
import { tavilySearch } from "../src/tavily.ts";

describe("tavilySearch", () => {
  it("posts the query with the key and maps results", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const search = tavilySearch("tvly-test", (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ results: [{ title: "Press freedom", url: "https://example.org/a", content: "..." }, { url: "https://example.org/b" }] });
    }) as typeof fetch);
    const hits = await search("press freedom in a coastal city", 3);
    expect(seen!.url).toBe("https://api.tavily.com/search");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer tvly-test");
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({ query: "press freedom in a coastal city", max_results: 3 });
    expect(hits).toEqual([
      { title: "Press freedom", url: "https://example.org/a", content: "..." },
      { title: "", url: "https://example.org/b", content: "" },
    ]);
  });
});
