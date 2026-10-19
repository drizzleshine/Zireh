import type { DaemonStatus } from "@zireh/schema";
import { useState } from "react";
import { inviteLink, useStore } from "../store.ts";
import { BoardPanel } from "./BoardPanel.tsx";
import { ConcludePanel } from "./ConcludePanel.tsx";
import { EvidencePanel } from "./EvidencePanel.tsx";
import { FindingsPanel } from "./FindingsPanel.tsx";
import { LogPanel } from "./LogPanel.tsx";
import { ResearchPanel } from "./ResearchPanel.tsx";

type Tab = "research" | "evidence" | "board" | "findings" | "conclude" | "log";

interface Props {
  caseId: string;
  status: DaemonStatus | undefined;
  onBalanceChange: () => void;
  onTopUp: () => void;
}

export function CaseView({ caseId, status, onBalanceChange, onTopUp }: Props) {
  const rec = useStore((s) => s.cases[caseId]);
  const ws = useStore((s) => s.workspaces.find((w) => w.caseId === caseId));
  const [tab, setTab] = useState<Tab>("research");
  const [copied, setCopied] = useState(false);

  if (!rec) return <section className="panel">Opening case…</section>;
  const drafts = rec.observations.filter((o) => o.status === "draft").length;

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "research", label: "Research" },
    { id: "evidence", label: "Evidence", count: rec.evidence.length },
    { id: "board", label: "Board" },
    { id: "findings", label: "Findings", count: rec.findings.length + drafts },
    { id: "conclude", label: "Conclude" },
    { id: "log", label: "Privacy log" },
  ];

  return (
    <>
      <header className="case-head">
        <h1>{rec.case.title}</h1>
        <p className="case-question">{rec.case.question}</p>
        <div className="case-meta">
          <span>{rec.members.map((m) => m.name).join(", ")}</span>
          <span>{ws?.syncError ? `Not synced: ${ws.syncError}` : ws?.outbox.length ? "Saving…" : ws?.syncedAt ? "Synced, end-to-end encrypted" : "Not synced yet"}</span>
          <span className="spacer" />
          <button
            className="btn small"
            onClick={async () => {
              await navigator.clipboard.writeText(inviteLink(caseId));
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Invite link copied" : "Copy invite link"}
          </button>
        </div>
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count ? <span className="count">{t.count}</span> : null}
            </button>
          ))}
        </div>
      </header>
      {tab === "research" && <ResearchPanel caseId={caseId} status={status} onBalanceChange={onBalanceChange} onTopUp={onTopUp} />}
      {tab === "evidence" && <EvidencePanel caseId={caseId} />}
      {tab === "board" && <BoardPanel caseId={caseId} />}
      {tab === "findings" && <FindingsPanel caseId={caseId} />}
      {tab === "conclude" && <ConcludePanel caseId={caseId} />}
      {tab === "log" && <LogPanel caseId={caseId} />}
    </>
  );
}
