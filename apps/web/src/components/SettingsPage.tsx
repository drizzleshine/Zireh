import type { DaemonStatus } from "@zireh/schema";
import { ArrowClockwise, Check, Copy, Cpu, Desktop, Keyboard, Moon, PaintBrush, Sun, UploadSimple, Wallet } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { formatUsd } from "../api.ts";
import { setTheme, useTheme, type Theme } from "../theme.ts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { SwapIcon } from "@/components/ui/swap-icon";

interface Props {
  status: DaemonStatus | undefined;
  onRefresh: () => Promise<void>;
  onTopUp: () => void;
  onImport: () => void;
}

const THEMES: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "Match my device", icon: Desktop },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

const SHORTCUTS: [string, string][] = [
  ["⌘ K", "Search and jump anywhere"],
  ["⌘ ⇧ H", "Hide the screen instantly"],
  ["⌥ 1 – 7", "Switch between case tabs"],
  ["⌘ ↵", "Send what you've typed"],
];

export function SettingsPage({ status, onRefresh, onTopUp, onImport }: Props) {
  const { theme } = useTheme();
  return (
    <section className="page mx-auto w-full max-w-6xl [&>*]:max-w-3xl">
      <header className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-[-0.025em]">Settings</h1>
        <p className="text-muted-foreground">Saved in this browser only.</p>
      </header>

      <Group icon={PaintBrush} title="Appearance">
        <div className="grid grid-cols-3 gap-3">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id)}
              aria-pressed={theme === t.id}
              className={cn(
                "group grid gap-3 rounded-[20px] border bg-card p-3 text-left text-sm transition-[border-color,box-shadow] hover:border-foreground/30 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
                theme === t.id && "border-protected ring-[3px] ring-protected/15",
              )}
            >
              <Preview kind={t.id} />
              <span className="flex items-center gap-2 font-medium">
                <t.icon className="size-4" weight={theme === t.id ? "fill" : "regular"} />
                {t.label}
              </span>
            </button>
          ))}
        </div>
      </Group>

      <Group icon={Cpu} title="On-device AI" badge="Recommended">
        <LocalModel status={status} onRefresh={onRefresh} />
      </Group>

      <Group icon={Wallet} title="Balance">
        <div className="panel surface flex flex-wrap items-center gap-4">
          <div className="grid">
            <span className="font-display text-3xl font-semibold tabular-nums">{status ? formatUsd(status.balance) : "—"}</span>
            <span className="text-sm text-muted-foreground">Paid with private Zcash. Nobody can link it to you.</span>
          </div>
          <Button className="ml-auto" onClick={onTopUp} disabled={!status?.relay.ok}>
            <Wallet /> Add money
          </Button>
        </div>
      </Group>

      <Group icon={Keyboard} title="Shortcuts">
        <ul className="divide-y rounded-xl bg-card surface">
          {SHORTCUTS.map(([keys, what]) => (
            <li key={keys} className="flex items-center gap-4 px-5 py-3 text-sm">
              {what}
              <Kbd className="ml-auto font-display">{keys}</Kbd>
            </li>
          ))}
        </ul>
      </Group>

      <Group icon={UploadSimple} title="Your data">
        <div className="panel surface flex flex-wrap items-center gap-4 text-sm">
          <p className="max-w-[44ch] text-muted-foreground">Cases live in this browser. Bring one in from an encrypted backup file.</p>
          <Button variant="outline" className="ml-auto" onClick={onImport}>
            <UploadSimple /> Import a backup
          </Button>
        </div>
      </Group>
    </section>
  );
}

function Group({ icon: Icon, title, badge, children }: { icon: typeof Sun; title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Icon className="size-5 text-protected" weight="duotone" />
        {title}
        {badge && <span className="rounded-full bg-muted px-2 py-0.5 font-sans text-xs font-medium text-muted-foreground">{badge}</span>}
      </h2>
      {children}
    </div>
  );
}

/** A tiny drawing of the app in each theme. */
function Preview({ kind }: { kind: Theme }) {
  const half = (dark: boolean) => (
    <div className={cn("grid h-full grid-cols-[30%_1fr] gap-1 p-1.5", dark ? "bg-[oklch(0.175_0.006_70)]" : "bg-[oklch(0.955_0.009_82)]")}>
      <div className={cn("rounded-sm", dark ? "bg-[oklch(0.25_0.008_70)]" : "bg-[oklch(0.915_0.013_80)]")} />
      <div className={cn("grid content-start gap-1 rounded-sm p-1.5", dark ? "bg-[oklch(0.21_0.007_70)]" : "bg-white")}>
        <div className={cn("h-1.5 w-3/4 rounded-full", dark ? "bg-white/70" : "bg-black/70")} />
        <div className={cn("h-1 w-1/2 rounded-full", dark ? "bg-white/30" : "bg-black/25")} />
        <div className="mt-1 h-1.5 w-1/3 rounded-full bg-protected" />
      </div>
    </div>
  );
  return (
    <div className="aspect-[16/10] overflow-hidden rounded-md border">
      {kind === "system" ? (
        <div className="grid h-full grid-cols-2">
          {half(false)}
          {half(true)}
        </div>
      ) : (
        half(kind === "dark")
      )}
    </div>
  );
}

function LocalModel({ status, onRefresh }: { status: DaemonStatus | undefined; onRefresh: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  const ok = status?.localModel.ok;
  const model = status?.localModel.id ?? "nemotron-3-nano:4b";
  const command = `ollama pull ${model}`;
  return (
    <div className="panel surface gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className={cn("size-2.5 rounded-full", ok ? "bg-protected" : "bg-muted-foreground/40")} />
        <span className="font-medium">{ok ? `Connected: ${model}` : "Not connected"}</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            await onRefresh();
            setChecking(false);
          }}
        >
          <ArrowClockwise className={cn(checking && "animate-spin")} /> Check again
        </Button>
      </div>
      <p className="max-w-[60ch] text-muted-foreground">
        A free AI model on your own computer that protects each question before it leaves: it tells people from places and companies, writes a fitting description for each, rewrites follow-ups, splits questions up and adds decoys.
      </p>
      {!ok && (
        <p className="max-w-[60ch] rounded-lg bg-muted/60 px-3 py-2 text-muted-foreground">
          <span className="font-medium text-foreground">Without it:</span> every name-like word is hidden by rule and reads as “a name” unless you describe it, each question goes out whole, without splitting or decoys, and only Standard is available.
        </p>
      )}
      {!ok && (
        <ol className="grid gap-3">
          <li className="flex gap-3">
            <Step n={1} />
            <span>
              Install{" "}
              <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
                Ollama
              </a>
              , a free app that runs AI models on your computer.
            </span>
          </li>
          <li className="flex gap-3">
            <Step n={2} />
            <span className="grid min-w-0 gap-2">
              Download the model:
              <span className="flex min-w-0 items-center gap-2 rounded-lg bg-muted px-3 py-2 font-mono text-xs">
                <span className="truncate">{command}</span>
                <CopyButton text={command} />
              </span>
            </span>
          </li>
          <li className="flex gap-3">
            <Step n={3} />
            <span>Keep Ollama open, then press Check again.</span>
          </li>
        </ol>
      )}
    </div>
  );
}

function Step({ n }: { n: number }) {
  return <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-protected-wash font-display text-xs font-semibold text-protected">{n}</span>;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="hit ml-auto rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
      aria-label="Copy command"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Couldn't copy. Select the text instead.");
        }
      }}
    >
      <SwapIcon swapped={done} from={<Copy className="size-4" />} to={<Check className="size-4" />} />
    </button>
  );
}
