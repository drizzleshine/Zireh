import { ChatCircle } from "@phosphor-icons/react";
import { formatUsd } from "../../api.ts";
import type { Thread } from "../../research-history.ts";
import { SideItem, SideList } from "../Pane.tsx";

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
  return (
    <SideList title="Threads" count={threads.length}>
      {threads.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No threads yet. Your first question starts one.</li>}
      {threads.map((t) => (
        <SideItem
          key={t.id}
          active={t.id === openId}
          onSelect={() => onOpen(t.id)}
          live={t.id === liveId}
          icon={<ChatCircle />}
          title={t.turns[0]!.run.task}
          meta={[`${t.turns.length} question${t.turns.length === 1 ? "" : "s"}`, t.spent > 0 ? formatUsd(t.spent) : "", ago(t.updatedAt)].filter(Boolean).join(" · ")}
        />
      ))}
    </SideList>
  );
}
