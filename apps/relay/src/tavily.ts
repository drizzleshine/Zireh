import type { SearchFn } from "./relay.ts";

/** Tavily web search, called by the relay with its own key. Users reach it only through the relay. */
export function tavilySearch(apiKey: string, fetchFn: typeof fetch = fetch): SearchFn {
  return async (query, maxResults) => {
    const res = await fetchFn("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
    });
    if (!res.ok) throw new Error(`tavily: HTTP ${res.status}`);
    const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (body.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", content: r.content ?? "" }));
  };
}
