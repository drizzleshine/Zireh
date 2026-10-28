import type { DaemonStatus } from "@zireh/schema";
import { CaretDown, Check, CloudWarning as CloudAlert, CloudCheck, CloudArrowUp as CloudUpload, Database as DatabaseBackup, EyeSlash as EyeOff, LinkSimple as Link2, DotsThree as MoreHorizontal, Trash, Users, X } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { inviteLink, removeCaseFromBrowser, useStore } from "../store.ts";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { BackupDialog } from "./BackupDialog.tsx";
import { TAB_META } from "./CommandMenu.tsx";
import { EvidencePanel } from "./EvidencePanel.tsx";
import { ResearchPanel } from "./ResearchPanel.tsx";
import { replyOverdue } from "./RightOfReply.tsx";
import { TeamDialog } from "./TeamDialog.tsx";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SwapIcon } from "@/components/ui/swap-icon";

// Heavier tabs load on first visit (the board pulls in React Flow).
const BoardPanel = lazy(() => import("./BoardPanel.tsx").then((m) => ({ default: m.BoardPanel })));
const ConcludePanel = lazy(() => import("./ConcludePanel.tsx").then((m) => ({ default: m.ConcludePanel })));
const FindingsPanel = lazy(() => import("./FindingsPanel.tsx").then((m) => ({ default: m.FindingsPanel })));
const LogPanel = lazy(() => import("./LogPanel.tsx").then((m) => ({ default: m.LogPanel })));
const TimelinePanel = lazy(() => import("./TimelinePanel.tsx").then((m) => ({ default: m.TimelinePanel })));

export type Tab = "research" | "evidence" | "board" | "timeline" | "findings" | "conclude" | "log";
/** Switch tab and, when given, open and highlight that item there. */
export type OpenItem = (tab: Tab, id?: string) => void;

interface Props {
  caseId: string;
  status: DaemonStatus | undefined;
  tab: Tab;
  /** An item another tab or the command menu asked to open, highlighted where it lives. */
  focus: string | undefined;
  onTab: (tab: Tab) => void;
  onOpen: OpenItem;
  onBalanceChange: () => void;
  onTopUp: () => void;
  onSettings: () => void;
  onCurtain: () => void;
}

/** "Sam (demo teammate)" → "S", "Ada Obi" → "AO": letters only, parenthetical notes ignored. */
const initials = (name: string) =>
  (name.replace(/\(.*?\)/g, "").match(/\p{L}+/gu) ?? ["?"])
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** A sync error only counts once it has lasted this long; single failed attempts retry quietly. */
const SYNC_GRACE_MS = 20_000;

export function CaseView({ caseId, status, tab, focus, onTab, onOpen, onBalanceChange, onTopUp, onCurtain, onSettings }: Props) {
  const rec = useStore((s) => s.cases[caseId]);
  const ws = useStore((s) => s.workspaces.find((w) => w.caseId === caseId));
  const [team, setTeam] = useState(false);
  const [backup, setBackup] = useState(false);
  const [copied, setCopied] = useState(false);
  const [seenReplay, setSeenReplay] = useState<number>();
  const [removing, setRemoving] = useState(false);
  const [errorSince, setErrorSince] = useState<number>();
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!ws?.syncError) return setErrorSince(undefined);
    setErrorSince((since) => since ?? Date.now());
    const t = setTimeout(() => rerender((n) => n + 1), SYNC_GRACE_MS);
    return () => clearTimeout(t);
  }, [!!ws?.syncError]);

  if (!rec) return <section className="px-10 py-16 text-sm text-muted-foreground">Opening case…</section>;
  const members = rec.members.filter((m) => !m.removedAt);
  const lasting = !!ws?.syncError && errorSince !== undefined && Date.now() - errorSince >= SYNC_GRACE_MS;

  const sync = lasting
    ? { icon: CloudAlert, text: "Not synced", detail: `${ws!.syncError} Your changes are safe in this browser and will sync when the connection is back.`, tone: "text-destructive" }
    : ws?.outbox.length || ws?.syncError
      ? { icon: CloudUpload, text: "Saving…", detail: ws?.outbox.length ? `${ws.outbox.length} change(s) waiting` : "Retrying the sync host.", tone: "text-muted-foreground" }
      : ws?.syncedAt
        ? { icon: CloudCheck, text: "Synced", detail: "Locked so only your team can read it. The server can't.", tone: "text-protected" }
        : { icon: CloudUpload, text: "Not synced yet", detail: "Changes are saved in this browser.", tone: "text-muted-foreground" };

  const drafts = rec.observations.filter((o) => o.status === "draft").length;
  const late = rec.replies.filter(replyOverdue).length;
  const badge: Partial<Record<Tab, { text: string; tone?: "warn" | "bad"; title: string }>> = {
    ...(rec.evidence.length ? { evidence: { text: String(rec.evidence.length), title: `${rec.evidence.length} items` } } : {}),
    ...(drafts ? { findings: { text: String(drafts), tone: "warn" as const, title: `${drafts} observation${drafts === 1 ? "" : "s"} to check` } } : rec.findings.length ? { findings: { text: String(rec.findings.length), title: `${rec.findings.length} findings` } } : {}),
    ...(late ? { conclude: { text: String(late), tone: "bad" as const, title: `${late} reply deadline${late === 1 ? "" : "s"} passed` } } : {}),
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(await inviteLink(caseId));
      setCopied(true);
      toast.success("Invite link copied", { description: "The case key is in the link fragment, which never reaches a server." });
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error("Couldn't copy the invite", { description: (error as Error).message });
    }
  };

  return (
    <>
      {team && <TeamDialog caseId={caseId} onClose={() => setTeam(false)} />}
      {backup && <BackupDialog caseId={caseId} onClose={() => setBackup(false)} />}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this case from this browser?</AlertDialogTitle>
            <AlertDialogDescription>
              Its records, keys, research history, drafts and source identities are deleted from this device. Your team and the sync host keep their copies; an invite or a backup brings it back.
              {ws?.outbox.length ? ` ${ws.outbox.length} change${ws.outbox.length === 1 ? " hasn't" : "s haven't"} synced yet and will be lost. Back up first.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                void removeCaseFromBrowser(caseId).then(
                  () => toast.success("Removed from this browser"),
                  (error: Error) => toast.error("Couldn't remove the case", { description: error.message }),
                )
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70 md:rounded-t-xl">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 md:px-10">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 font-display text-[15px] font-semibold tracking-[-0.01em] hover:bg-muted" aria-label="About this case">
                <span className="truncate">{rec.case.title}</span>
                <CaretDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="grid w-[min(28rem,calc(100vw-2rem))] gap-2">
              <p className="text-xs font-medium text-muted-foreground">What you're trying to find out</p>
              <p className="font-serif text-[15px] leading-relaxed text-pretty">{rec.case.question}</p>
              <p className="text-xs text-muted-foreground">
                Opened {new Date(rec.case.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} · {members.length === 1 ? "just you" : `${members.length} people`}
              </p>
            </PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn("hidden shrink-0 items-center gap-1 text-xs sm:inline-flex", sync.tone)}>
                <sync.icon className="size-3.5" />
                {sync.text}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{sync.detail}</TooltipContent>
          </Tooltip>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => setTeam(true)} disabled={ws?.needsInvite} className="hidden -space-x-2 sm:flex" aria-label="Manage members">
              {members.slice(0, 4).map((m) => (
                <span key={m.id} title={m.name} className="flex size-7 items-center justify-center rounded-full border-2 border-background bg-secondary text-[11px] font-semibold">
                  {initials(m.name)}
                </span>
              ))}
              {members.length > 4 && <span className="flex size-7 items-center justify-center rounded-full border-2 border-background bg-muted text-[11px]">+{members.length - 4}</span>}
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="size-8" onClick={onCurtain} aria-label="Hide the screen">
                  <EyeOff />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hide the screen now · ⌘⇧H</TooltipContent>
            </Tooltip>
            <Button size="sm" variant="outline" onClick={copyInvite}>
              <SwapIcon swapped={copied} from={<Link2 />} to={<Check />} />
              <span className="hidden sm:inline">{copied ? "Copied" : "Invite"}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="size-8" aria-label="Case actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setTeam(true)} disabled={ws?.needsInvite}>
                  <Users />
                  Manage members
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setBackup(true)}>
                  <DatabaseBackup />
                  Back up case
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
                  <Trash />
                  Remove from this browser…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <nav className="mx-auto flex w-full max-w-6xl gap-5 overflow-x-auto px-4 [scrollbar-width:none] md:px-10" role="tablist" aria-label="Case sections">
          {(Object.keys(TAB_META) as Tab[]).map((t) => {
            const { label, icon: Icon, key } = TAB_META[t];
            const b = badge[t];
            return (
              <Tooltip key={t}>
                <TooltipTrigger asChild>
                  <button
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => onTab(t)}
                    className={cn(
                      "relative -mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 border-transparent font-display text-[14px] font-medium text-muted-foreground transition-colors hover:text-foreground",
                      tab === t && "border-protected text-foreground",
                    )}
                  >
                    <Icon className={cn("size-4", tab === t && "text-protected")} />
                    {label}
                    {b && (
                      <span
                        className={cn(
                          "min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 tabular-nums",
                          b.tone === "warn" ? "bg-decoy-wash text-decoy" : b.tone === "bad" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
                        )}
                      >
                        {b.text}
                      </span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {b ? `${b.title} · ` : ""}⌥{key}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>
      </header>

      {ws?.replayWarnings && ws.replayWarnings !== seenReplay ? (
        <div className="mx-auto mt-4 w-full max-w-6xl px-4 md:px-10">
          <p className="flex items-center gap-2 rounded-lg bg-destructive/5 py-2 pr-1 pl-3 text-sm text-destructive" role="alert">
            <span className="flex-1">Ignored {ws.replayWarnings} old or invalid sync records. Your case is unchanged.</span>
            <button type="button" onClick={() => setSeenReplay(ws.replayWarnings)} className="hit shrink-0 rounded p-1 hover:bg-destructive/10" aria-label="Dismiss">
              <X className="size-4" />
            </button>
          </p>
        </div>
      ) : null}
      {ws?.needsInvite && (
        <p className="mx-auto mt-4 w-full max-w-6xl rounded-lg border border-decoy/40 bg-decoy-wash px-4 py-3 text-sm md:mx-10" role="alert">
          This case key has been rotated. Editing is paused. Ask the case creator for an updated invite. Your existing local copy can still be backed up.
        </p>
      )}
      <Suspense fallback={<div className="mx-auto grid w-full max-w-6xl gap-3 px-4 pt-6 md:px-10">{[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />)}</div>}>
      <div className={cn("case-body mx-auto w-full", tab === "board" ? "max-w-none" : "max-w-6xl")}>
        {!ws?.needsInvite && tab === "research" && <ResearchPanel caseId={caseId} status={status} onBalanceChange={onBalanceChange} onTopUp={onTopUp} onSettings={onSettings} />}
        {!ws?.needsInvite && tab === "evidence" && <EvidencePanel caseId={caseId} focus={focus} onOpen={onOpen} />}
        {!ws?.needsInvite && tab === "board" && <BoardPanel caseId={caseId} onOpen={onOpen} />}
        {!ws?.needsInvite && tab === "timeline" && <TimelinePanel caseId={caseId} onOpen={onOpen} />}
        {!ws?.needsInvite && tab === "findings" && <FindingsPanel caseId={caseId} focus={focus} onOpen={onOpen} />}
        {!ws?.needsInvite && tab === "conclude" && <ConcludePanel caseId={caseId} onOpen={onOpen} />}
        {!ws?.needsInvite && tab === "log" && <LogPanel caseId={caseId} />}
      </div>
      </Suspense>
    </>
  );
}
