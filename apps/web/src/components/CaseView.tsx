import { TeamDialog } from "./TeamDialog.tsx";
import type { DaemonStatus } from "@zireh/schema";
import { useState } from "react";
import { inviteLink, useStore } from "../store.ts";
import { BackupDialog } from "./BackupDialog.tsx";
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
  const [team, setTeam] = useState(false);
  const [backup, setBackup] = useState(false);
  const [copyError, setCopyError] = useState<string>();
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
      {team && <TeamDialog caseId={caseId} onClose={() => setTeam(false)} />}
      {backup && <BackupDialog caseId={caseId} onClose={() => setBackup(false)} />}
      <header className="case-head">
        <h1>{rec.case.title}</h1>
        <p className="case-question">{rec.case.question}</p>
        <div className="case-meta">
          <span>{rec.members.filter((member) => !member.removedAt).map((m) => m.name).join(", ")}</span>
          <span>{ws?.syncError ? `Not synced: ${ws.syncError}` : ws?.outbox.length ? "Saving…" : ws?.syncedAt ? "Synced, end-to-end encrypted" : "Not synced yet"}</span>
          <span className="spacer" />
          <button className="btn small" onClick={() => setTeam(true)} disabled={ws?.needsInvite}>Manage members</button>
          <button className="btn small" onClick={() => setBackup(true)}>Back up case</button>
          <button
            className="btn small"
            onClick={async () => {
              setCopyError(undefined);
              try { await navigator.clipboard.writeText(await inviteLink(caseId)); setCopied(true); setTimeout(() => setCopied(false), 2000); }
              catch (error) { setCopyError((error as Error).message); }
            }}
          >
            {copied ? "Invite link copied" : "Copy invite link"}
          </button>
        </div>
        {copyError && <p className="error">{copyError}</p>}
        {!!ws?.replayWarnings && <p className="error" role="alert">Ignored {ws.replayWarnings} stale, repeated, or invalid sync records. The host may be replaying old data.</p>}
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count ? <span className="count">{t.count}</span> : null}
            </button>
          ))}
        </div>
      </header>
      {ws?.needsInvite && <p className="notice" role="alert">This case key has been rotated. Editing is paused. Ask the case creator for an updated invite. Your existing local copy can still be backed up.</p>}
      {!ws?.needsInvite && tab === "research" && <ResearchPanel caseId={caseId} status={status} onBalanceChange={onBalanceChange} onTopUp={onTopUp} />}
      {!ws?.needsInvite && tab === "evidence" && <EvidencePanel caseId={caseId} />}
      {!ws?.needsInvite && tab === "board" && <BoardPanel caseId={caseId} />}
      {!ws?.needsInvite && tab === "findings" && <FindingsPanel caseId={caseId} />}
      {!ws?.needsInvite && tab === "conclude" && <ConcludePanel caseId={caseId} />}
      {!ws?.needsInvite && tab === "log" && <LogPanel caseId={caseId} />}
    </>
  );
}
