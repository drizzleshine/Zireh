import { newEvidence } from "@zireh/cases";
import { Check, CaretRight as ChevronRight, Globe, CircleNotch as Loader2, Plus, MagnifyingGlass as Search } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { api, formatUsd } from "../api.ts";
import { withIdentities, withoutIdentities } from "../sources.ts";
import { myMemberId, save, savePseudonyms, useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";

type Hit = { title: string; url: string; content: string };

/** Web search through the relay (Tavily). The query is redacted here first. */
export function SearchBox({ caseId }: { caseId: string }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sent: string; hits: Hit[]; charged: number } | undefined>();
  const [added, setAdded] = useState<string[]>([]);

  return (
    <Collapsible className="rounded-xl bg-card surface">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-sm font-medium">
        <Globe className="size-4 text-muted-foreground" />
        Search the web privately
        <span className="text-xs font-normal text-muted-foreground">names are left out of your search</span>
        <ChevronRight className="ml-auto size-4 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-4 border-t p-4">
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api.search(query, withIdentities(caseId, rec.pseudonyms), caseId);
              await savePseudonyms(caseId, withoutIdentities(caseId, r.table));
              setResult({ sent: r.redactedQuery, hits: r.hits, charged: r.charged });
            } catch (err) {
              toast.error("Search failed", { description: (err as Error).message });
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search query" value={query} maxLength={400} onChange={(e) => setQuery(e.target.value)} placeholder="Search with real names; they're replaced before the query leaves" className="pl-8" />
          </div>
          <Button type="submit" disabled={busy || query.trim().length < 2}>
            {busy && <Loader2 className="animate-spin" />} Search
          </Button>
        </form>
        {result && (
          <div className="grid gap-3">
            <p className="text-xs text-muted-foreground">
              Sent as <span className="font-serif text-sm text-foreground">“{result.sent}”</span> · {formatUsd(result.charged)}
            </p>
            {result.hits.length === 0 && <p className="text-sm text-muted-foreground">No results.</p>}
            <ul className="grid gap-2">
              {result.hits.map((h) => (
                <li key={h.url} className="grid gap-1 rounded-lg border p-3">
                  <div className="flex items-start gap-2">
                    <a href={h.url} target="_blank" rel="noreferrer noopener" className="flex-1 text-sm font-medium text-protected underline-offset-2 hover:underline" title="Opens from your own connection">
                      {h.title || h.url}
                    </a>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={added.includes(h.url)}
                      onClick={async () => {
                        await save(caseId, "evidence", newEvidence(caseId, myMemberId(caseId), { kind: "link", title: h.title.slice(0, 200) || h.url, body: `${h.url}\n\n${h.content}` }));
                        setAdded((a) => [...a, h.url]);
                      }}
                    >
                      {added.includes(h.url) ? <Check /> : <Plus />}
                      {added.includes(h.url) ? "Added" : "Evidence"}
                    </Button>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{h.url}</p>
                  <p className="line-clamp-3 font-serif text-sm">{h.content}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
