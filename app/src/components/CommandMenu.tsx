import { BookOpenText, CalendarBlank as CalendarRange, EyeSlash as EyeOff, FileMagnifyingGlass as FileSearch, Flask as FlaskConical, FolderLock, Graph as Network, Notebook as NotebookPen, Plus, Receipt as ReceiptText, Scales as Scale, Sparkle as Sparkles, Wallet, GearSix } from "@phosphor-icons/react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { useStore } from "../store.ts";
import type { OpenItem, Tab } from "./CaseView.tsx";

export const TAB_META: Record<Tab, { label: string; icon: typeof Sparkles; key: string }> = {
  research: { label: "Research", icon: Sparkles, key: "1" },
  evidence: { label: "Evidence", icon: FileSearch, key: "2" },
  board: { label: "Board", icon: Network, key: "3" },
  timeline: { label: "Timeline", icon: CalendarRange, key: "4" },
  findings: { label: "Findings", icon: NotebookPen, key: "5" },
  conclude: { label: "Conclude", icon: Scale, key: "6" },
  log: { label: "Privacy log", icon: ReceiptText, key: "7" },
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onTab: (tab: Tab) => void;
  onOpen: OpenItem;
  onNewCase: () => void;
  onDemo: () => void;
  onTopUp: () => void;
  onHow: () => void;
  onCurtain: () => void;
  onSettings: () => void;
}

/** ⌘K: jump to any case, section or evidence item, or run an action, without the mouse. */
export function CommandMenu({ open, onOpenChange, selected, onSelect, onTab, onOpen, onNewCase, onDemo, onTopUp, onHow, onCurtain, onSettings }: Props) {
  const cases = useStore((s) => s.workspaces.map((w) => ({ id: w.caseId, title: s.cases[w.caseId]?.case.title ?? "Syncing…" })));
  const evidence = useStore((s) => (selected ? (s.cases[selected]?.evidence ?? []) : []));
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search and commands" description="Jump to a case, section or evidence, or run an action">
      <CommandInput placeholder="Search cases, evidence, actions…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {selected && (
          <CommandGroup heading="This case">
            {(Object.keys(TAB_META) as Tab[]).map((t) => {
              const { label, icon: Icon, key } = TAB_META[t];
              return (
                <CommandItem key={t} onSelect={run(() => onTab(t))}>
                  <Icon />
                  Go to {label}
                  <CommandShortcut>⌥{key}</CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {evidence.length > 0 && (
          <CommandGroup heading="Evidence">
            {evidence.map((e) => (
              <CommandItem key={e.id} value={`evidence ${e.title} ${e.body.slice(0, 200)}`} onSelect={run(() => onOpen("evidence", e.id))}>
                <FileSearch />
                <span className="truncate">{e.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Cases">
          {cases.map((c) => (
            <CommandItem key={c.id} value={`case ${c.title}`} onSelect={run(() => onSelect(c.id))}>
              <FolderLock />
              <span className="truncate">{c.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem onSelect={run(onCurtain)}>
            <EyeOff />
            Hide the screen now
            <CommandShortcut>⌘⇧H</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(onNewCase)}>
            <Plus />
            Start a new case
          </CommandItem>
          <CommandItem onSelect={run(onDemo)}>
            <FlaskConical />
            Open the fictional demo case
          </CommandItem>
          <CommandItem onSelect={run(onTopUp)}>
            <Wallet />
            Top up balance
          </CommandItem>
          <CommandItem onSelect={run(onSettings)}>
            <GearSix />
            Settings: theme, on-device AI, shortcuts
          </CommandItem>
          <CommandItem onSelect={run(onHow)}>
            <BookOpenText />
            How Zireh protects you
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
