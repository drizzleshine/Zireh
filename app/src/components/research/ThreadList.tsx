import { ChatCircle, MagnifyingGlass as Search } from "@phosphor-icons/react";
import { useState } from "react";
import { formatUsd } from "../../api.ts";
import type { Thread } from "../../research-history.ts";
import { SideItem, SideList } from "../Pane.tsx";
import { Input } from "@/components/ui/input";

const ago = (iso: string) => {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (sec < 60) return "just now";
  if (sec < 3600) return rtf.format(-Math.round(sec / 60), "minute");
  if (sec < 86400) return rtf.format(-Math.round(sec / 3600), "hour");
  return rtf.format(-Math.round(sec / 86400), "day");
};

/** Threads down the side, in the same side list Evidence and Findings use. */
export function ThreadList({ threads, openId, liveId, onOpen }: { threads: Thread[]; openId: string | undefined; liveId: string | undefined; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const shown = threads.filter((t) => !query.trim() || t.turns[0]!.run.task.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <SideList
      title="Threads"
      count={threads.length}
      top={
        threads.length === 0 ? undefined : (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} placeholder="Search threads" aria-label="Search threads" className="h-8 pl-8 text-sm" />
          </div>
        )
      }
    >
      {threads.length === 0 ? (
        <li className="px-3 py-6 text-center text-sm text-muted-foreground">No threads yet. Your first question starts one.</li>
      ) : shown.length === 0 ? (
        <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</li>
      ) : (
        shown.map((t) => (
        <SideItem
          key={t.id}
          active={t.id === openId}
          onSelect={() => onOpen(t.id)}
          live={t.id === liveId}
          icon={<ChatCircle />}
          title={t.turns[0]!.run.task}
          meta={[`${t.turns.length} question${t.turns.length === 1 ? "" : "s"}`, t.spent > 0 ? formatUsd(t.spent) : "", ago(t.updatedAt)].filter(Boolean).join(" · ")}
        />
        ))
      )}
    </SideList>
  );
}
