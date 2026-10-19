import { newEvidence } from "@zireh/cases";
import { useState } from "react";
import { api, formatUsd } from "../api.ts";
import { myMemberId, save, savePseudonyms, useStore } from "../store.ts";

type Hit = { title: string; url: string; content: string };

/** Web search through the relay (Tavily). The query is redacted here first and sent over Tor. */
export function SearchBox({ caseId }: { caseId: string }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sent: string; hits: Hit[]; charged: number } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [added, setAdded] = useState<string[]>([]);

  return (
    <details className="search-box">
      <summary>Search the web privately</summary>
      <form
        className="search-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const r = await api.search(query, rec.pseudonyms, caseId);
            await savePseudonyms(caseId, r.table);
            setResult({ sent: r.redactedQuery, hits: r.hits, charged: r.charged });
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input className="input" aria-label="Search query" value={query} maxLength={400} onChange={(e) => setQuery(e.target.value)} placeholder="Names are hidden before the query leaves" />
        <button type="submit" className="btn" disabled={busy || query.trim().length < 2}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && (
        <div className="search-results">
          <p className="level-note">
            Sent as “{result.sent}” over Tor · {formatUsd(result.charged)}
          </p>
          {result.hits.length === 0 && <p className="level-note">No results.</p>}
          {result.hits.map((h) => (
            <article key={h.url} className="hit">
              <a href={h.url} target="_blank" rel="noreferrer noopener">
                {h.title || h.url}
              </a>
              <p className="doc">{h.content.slice(0, 280)}</p>
              <button
                className="btn small"
                disabled={added.includes(h.url)}
                onClick={async () => {
                  await save(caseId, "evidence", newEvidence(caseId, myMemberId(caseId), { kind: "link", title: h.title.slice(0, 200) || h.url, body: `${h.url}\n\n${h.content}` }));
                  setAdded((a) => [...a, h.url]);
                }}
              >
                {added.includes(h.url) ? "Added to evidence" : "Add to evidence"}
              </button>
            </article>
          ))}
        </div>
      )}
    </details>
  );
}
