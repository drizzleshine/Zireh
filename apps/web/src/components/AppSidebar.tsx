import type { DaemonStatus } from "@zireh/schema";
import { BookOpenText, CaretUpDown, Cpu, Flask, FolderSimpleLock, GearSix, MagnifyingGlass, Plus, Wallet } from "@phosphor-icons/react";
import { formatUsd } from "../api.ts";
import { useStore } from "../store.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Props {
  status: DaemonStatus | undefined;
  daemonError: string | undefined;
  selected: string | undefined;
  settingsOpen: boolean;
  onSelect: (id: string) => void;
  onTopUp: () => void;
  onNewCase: () => void;
  onDemo: () => void;
  onHome: () => void;
  onHow: () => void;
  onImport: () => void;
  onCommand: () => void;
  onSettings: () => void;
}

type Health = "ok" | "warn" | "bad" | "idle";

/** Cases first; help and settings below; balance and connection pinned to the bottom. */
export function AppSidebar({ status, daemonError, selected, settingsOpen, onSelect: select, onTopUp, onNewCase, onDemo: demo, onHome: home, onHow, onCommand, onSettings: settings }: Props) {
  // On phones the sidebar is a sheet over the page; going somewhere should close it.
  const { isMobile, setOpenMobile } = useSidebar();
  const go = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
    if (isMobile) setOpenMobile(false);
    fn(...a);
  };
  const onSelect = go(select);
  const onDemo = go(demo);
  const onHome = go(home);
  const onSettings = go(settings);
  const cases = useStore((s) =>
    s.workspaces.map((w) => ({ id: w.caseId, title: s.cases[w.caseId]?.case.title, members: s.cases[w.caseId]?.members.filter((m) => !m.removedAt).length ?? 0, evidence: s.cases[w.caseId]?.evidence.length ?? 0, demo: !!s.cases[w.caseId]?.case.title.includes("(fictional demo)") })),
  );
  // Only the relay decides whether Zireh can work. On-device AI is an optional extra.
  // A reachable relay whose AI is down can't answer anything, so it is not "Ready".
  const aiDown = !!status?.relay.ok && status.relay.upstreamOk === false;
  const relay: Health = daemonError ? "bad" : !status ? "idle" : !status.relay.ok ? "bad" : aiDown ? "warn" : "ok";
  const summary = daemonError ? "Can't connect" : relay === "ok" ? "Ready" : relay === "warn" ? "The AI isn't answering" : relay === "bad" ? "Can't reach the relay" : "Connecting…";

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="gap-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" onClick={onHome} tooltip="Zireh home">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
                <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
                  <rect x="5" y="7" width="22" height="4.5" rx="1.2" fill="currentColor" />
                  <rect x="5" y="14" width="13" height="4.5" rx="1.2" fill="var(--protected)" />
                  <rect x="5" y="21" width="18" height="4.5" rx="1.2" fill="currentColor" />
                </svg>
              </span>
              <span className="font-display text-[17px] font-semibold tracking-[-0.02em]">Zireh</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <button
          type="button"
          onClick={onCommand}
          className="flex h-8 items-center gap-2 rounded-md border bg-background/60 px-2 text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <MagnifyingGlass className="size-4 shrink-0" />
          <span className="group-data-[collapsible=icon]:hidden">Search</span>
          <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">⌘K</Kbd>
        </button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="font-display tracking-wide">Cases</SidebarGroupLabel>
          <SidebarGroupAction title="New case" onClick={onNewCase}>
            <Plus />
            <span className="sr-only">New case</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {cases.map(({ id, title, members, evidence }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton isActive={id === selected && !settingsOpen} onClick={() => onSelect(id)} tooltip={title ?? "Syncing…"} className="h-auto py-2">
                    <FolderSimpleLock className="mt-0.5 self-start" weight={id === selected ? "duotone" : "regular"} />
                    <span className="grid min-w-0 leading-snug">
                      <span className="truncate">{title ?? "Syncing…"}</span>
                      <span className="text-xs text-muted-foreground">
                        {members === 1 ? "Just you" : `${members} people`} · {evidence} {evidence === 1 ? "file" : "files"}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {!cases.some((c) => c.demo) && (
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={onDemo} tooltip="Open the demo case" className="text-muted-foreground">
                    <Flask />
                    <span>Open the demo case</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={go(onHow)} tooltip="How Zireh keeps you safe">
                  <BookOpenText />
                  <span>How it keeps you safe</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={onSettings} isActive={settingsOpen} tooltip="Settings">
                  <GearSix weight={settingsOpen ? "duotone" : "regular"} />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" tooltip="Balance and connection" className="data-[state=open]:bg-sidebar-accent">
                  <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-protected-wash text-protected">
                    <Wallet className="size-4" weight="duotone" />
                    <Dot state={relay} className="absolute right-0.5 top-0.5 size-1.5" />
                  </span>
                  <span className="grid min-w-0 leading-tight">
                    <span className="font-display font-semibold tabular-nums">{status ? formatUsd(status.balance) : "—"}</span>
                    <span className="truncate text-xs text-muted-foreground">{summary}</span>
                  </span>
                  <CaretUpDown className="ml-auto size-4 text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-64">
                <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Connection</DropdownMenuLabel>
                {daemonError ? (
                  <p className="px-2 pb-2 text-sm text-destructive">{daemonError}</p>
                ) : (
                  <div className="grid gap-2 px-2 pb-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Dot state={relay} />
                      Relay
                      <span className="ml-auto text-xs text-muted-foreground">{!status ? "…" : aiDown ? "up, AI not answering" : status.relay.ok ? (status.relay.network === "simulated" ? "test money" : (status.relay.network ?? "ok")) : "unreachable"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Cpu className={cn("size-3.5", status?.localModel.ok ? "text-protected" : "text-muted-foreground")} />
                      On-device AI
                      <span className="ml-auto text-xs text-muted-foreground">{status?.localModel.ok ? "on" : "off"}</span>
                    </div>
                  </div>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onTopUp} disabled={!status?.relay.ok}>
                  <Wallet />
                  Add money
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onSettings}>
                  <GearSix />
                  Settings
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function Dot({ state, className }: { state: Health; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-hidden="true"
          className={cn(
            "inline-block size-2 shrink-0 rounded-full",
            state === "ok" && "bg-protected",
            state === "warn" && "animate-pulse bg-decoy",
            state === "bad" && "bg-destructive",
            state === "idle" && "bg-muted-foreground/40",
            className,
          )}
        />
      </TooltipTrigger>
      <TooltipContent>{state === "ok" ? "Working" : state === "warn" ? "Partly working" : state === "bad" ? "Not working" : "Checking"}</TooltipContent>
    </Tooltip>
  );
}
