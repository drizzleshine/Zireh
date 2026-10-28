import { parseInvite, type Invite } from "@zireh/cases";
import type { DaemonStatus } from "@zireh/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, DaemonError } from "./api.ts";
import { BackupDialog } from "./components/BackupDialog.tsx";
import { CaseView } from "./components/CaseView.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { HowItWorks } from "./components/HowItWorks.tsx";
import { JoinDialog } from "./components/JoinDialog.tsx";
import { NewCaseDialog } from "./components/NewCaseDialog.tsx";
import { AppSidebar } from "./components/AppSidebar.tsx";
import { CommandMenu, TAB_META } from "./components/CommandMenu.tsx";
import type { Tab } from "./components/CaseView.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletDialog } from "./components/WalletDialog.tsx";
import { Curtain } from "./components/Curtain.tsx";
import { Welcome } from "./components/Welcome.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { DevGrid } from "./components/DevGrid.tsx";
import { createDemoCase } from "./demo.ts";
import { navigate, useRoute } from "./route.ts";
import { getSnapshot, useStore } from "./store.ts";

export function App() {
  const [status, setStatus] = useState<DaemonStatus | undefined>();
  const [daemonError, setDaemonError] = useState<string | undefined>();
  // The address bar is the one source of truth for where you are (see route.ts).
  const route = useRoute();
  const selected = route.view === "case" ? route.caseId : undefined;
  const settings = route.view === "settings";
  const tab: Tab = route.view === "case" ? route.tab : "research";
  const focus = route.view === "case" ? route.item : undefined;
  const setTab = (t: Tab) => selected && navigate({ view: "case", caseId: selected, tab: t });
  const openItem = (t: Tab, id?: string) => selected && navigate({ view: "case", caseId: selected, tab: t, ...(id ? { item: id } : {}) });
  const openSettings = () => navigate({ view: "settings" });
  const [command, setCommand] = useState(false);
  const [curtain, setCurtain] = useState(false);
  const setSelected = (id: string | undefined) => navigate(id ? { view: "case", caseId: id, tab: "research" } : { view: "home" });
  const [dialog, setDialog] = useState<"wallet" | "new-case" | "how" | "import" | undefined>();
  const [invite, setInvite] = useState<Invite | undefined>(() => parseInvite(location.hash));
  const caseIds = useStore((s) => s.workspaces.map((w) => w.caseId).join(","));
  const loaded = useStore((s) => s.loaded);
  const firstLoad = useRef(true);
  const openDemo = async () => {
    const s = getSnapshot();
    const existing = s.workspaces.find((w) => s.cases[w.caseId]?.case.title.includes("(fictional demo)"));
    setSelected(existing?.caseId ?? (await createDemoCase("You")));
  };

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setDaemonError(undefined);
    } catch (err) {
      setDaemonError(err instanceof DaemonError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // Chained, not an interval: a slow check must not stack up behind itself.
    let t: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const tick = async () => {
      await refresh();
      if (live) t = setTimeout(tick, 4000);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [refresh]);

  useEffect(() => {
    const ids = caseIds ? caseIds.split(",") : [];
    if (!loaded) return;
    // A case that isn't here (a join that was rolled back, an old link): go home rather than show nothing.
    if (selected && !ids.includes(selected)) navigate({ view: "home" }, { replace: true });
    // Opening the app at its root goes straight back to your latest case, once.
    else if (firstLoad.current && route.view === "home" && ids.length) navigate({ view: "case", caseId: ids[ids.length - 1]!, tab: "research" }, { replace: true });
    firstLoad.current = false;
  }, [caseIds, selected, loaded, route.view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setCurtain((c) => !c);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommand((open) => !open);
      } else if (e.altKey && selected) {
        const hit = (Object.keys(TAB_META) as Tab[]).find((t) => e.code === `Digit${TAB_META[t].key}`);
        if (hit) {
          e.preventDefault();
          setTab(hit);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    <TooltipProvider delayDuration={300}>
      <SidebarProvider>
        <AppSidebar
          status={status}
          daemonError={daemonError}
          selected={selected}
          onSelect={setSelected}
          onTopUp={() => setDialog("wallet")}
          onNewCase={() => setDialog("new-case")}
          onDemo={openDemo}
          onImport={() => setDialog("import")}
          onHow={() => setDialog("how")}
          onCommand={() => setCommand(true)}
          settingsOpen={settings}
          onSettings={openSettings}
          onHome={() => setSelected(undefined)}
        />
        <SidebarInset className="min-w-0">
          {import.meta.env.DEV && <DevGrid />}
          <ErrorBoundary key={selected}>
            {settings ? (
              <>
                <header className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 md:px-10">
                  <SidebarTrigger className="-ml-1" />
                </header>
                <SettingsPage status={status} onRefresh={refresh} onTopUp={() => setDialog("wallet")} onImport={() => setDialog("import")} />
              </>
            ) : selected ? (
              <CaseView key={selected} caseId={selected} status={status} tab={tab} focus={focus} onTab={setTab} onOpen={openItem} onBalanceChange={refresh} onTopUp={() => setDialog("wallet")} onCurtain={() => setCurtain(true)} onSettings={openSettings} />
            ) : (
              <>
                <header className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 md:px-10">
                  <SidebarTrigger className="-ml-1" />
                  <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
                  <span className="truncate text-xs font-medium tracking-wide text-protected uppercase">For journalists, legal aid and researchers</span>
                </header>
                <Welcome onNewCase={() => setDialog("new-case")} onDemo={openDemo} />
              </>
            )}
          </ErrorBoundary>
        </SidebarInset>
        <CommandMenu
          open={command}
          onOpenChange={setCommand}
          selected={selected}
          onSelect={setSelected}
          onTab={setTab}
          onOpen={openItem}
          onNewCase={() => setDialog("new-case")}
          onDemo={openDemo}
          onTopUp={() => setDialog("wallet")}
          onHow={() => setDialog("how")}
          onCurtain={() => setCurtain(true)}
          onSettings={openSettings}
        />
        {curtain && <Curtain onLift={() => setCurtain(false)} />}
        <Toaster position="bottom-right" />
        {dialog === "import" && <BackupDialog onClose={() => setDialog(undefined)} onImported={setSelected} />}
        {dialog === "how" && <HowItWorks onClose={() => setDialog(undefined)} />}
        {dialog === "wallet" && <WalletDialog onClose={() => setDialog(undefined)} onBalanceChange={refresh} />}
        {dialog === "new-case" && (
          <NewCaseDialog
            onClose={() => setDialog(undefined)}
            onCreated={(id) => {
              setDialog(undefined);
              setSelected(id);
            }}
          />
        )}
        {invite && (
          <JoinDialog
            invite={invite}
            onClose={() => {
              setInvite(undefined);
              history.replaceState(null, "", location.pathname);
            }}
            onJoined={(id) => {
              setInvite(undefined);
              history.replaceState(null, "", location.pathname);
              setSelected(id);
            }}
          />
        )}
      </SidebarProvider>
    </TooltipProvider>
  );
}
