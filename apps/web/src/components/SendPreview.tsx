import { applyTable, extendTable, findLeaks, redactWithoutModel, withHints } from "@zireh/redact";
import type { EntityKind, Pseudonym } from "@zireh/schema";
import { Warning as AlertTriangle, EyeSlash as EyeOff, PencilSimple } from "@phosphor-icons/react";
import { useDeferredValue, useMemo, useState } from "react";
import { toast } from "sonner";
import { scan } from "../intake.ts";
import { withoutIdentities } from "../sources.ts";
import { editPseudonym, savePseudonyms, useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface Item {
  readonly original: string;
  readonly kind: EntityKind;
  readonly hint: string | undefined;
  /** Hidden for certain. Otherwise the on-device AI decides when the question is sent. */
  readonly sure: boolean;
  /** A source's real name kept on this device only; its description can't be changed here. */
  readonly identity: boolean;
}

/**
 * What the question will look like to the AI provider, worked out on this device before Ask.
 * Without on-device AI this is exact: it runs the same rules the daemon will. With it, the model
 * can hide more and rewrites the question, so only the certain part is shown.
 */
export function SendPreview({ caseId, task, context, table, localAi }: { caseId: string; task: string; context: readonly string[]; table: readonly Pseudonym[]; localAi: boolean }) {
  const team = useStore((s) => s.cases[caseId]?.pseudonyms ?? []);
  const deferred = useDeferredValue(task);

  const { items, wire } = useMemo(() => {
    if (!deferred.trim()) return { items: [] as Item[], wire: undefined };
    const identity = (original: string) => !team.some((p) => p.original.toLowerCase() === original.toLowerCase());
    if (!localAi) {
      // Same input the shield builds: context first, then the task, sharing one table.
      const joined = context.join("\n\n");
      const red = redactWithoutModel(joined ? `${joined}\n\nTask: ${deferred}` : deferred, table);
      const present = new Set(findLeaks(deferred, red.table).map((o) => o.toLowerCase()));
      const items = red.table
        .filter((p) => present.has(p.original.toLowerCase()))
        .map((p): Item => ({ original: p.original, kind: p.kind, hint: p.hint, sure: true, identity: table.some((t) => t.original === p.original) && identity(p.original) }));
      return { items, wire: withHints(applyTable(deferred, red.table), red.table) };
    }
    const items = scan(deferred, table).map((h): Item => {
      const known = table.find((p) => p.original.toLowerCase() === h.text.toLowerCase());
      return { original: known?.original ?? h.text, kind: known?.kind ?? h.kind, hint: known?.hint, sure: !h.guess, identity: !!known && identity(known.original) };
    });
    return { items, wire: undefined };
  }, [deferred, context, table, team, localAi]);

  if (!items.length && !wire) return null;
  const vague = items.filter((i) => i.sure && i.hint === "a name").length;

  async function describe(item: Item, hint: string) {
    const known = team.find((p) => p.original.toLowerCase() === item.original.toLowerCase());
    if (known) await editPseudonym(caseId, known.original, hint);
    else await savePseudonyms(caseId, withoutIdentities(caseId, extendTable(table, [{ text: item.original, kind: item.kind, hint }])));
  }

  return (
    <div className="grid gap-2 px-4 pb-4 text-xs md:px-6" aria-label="What the AI will see">
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 flex items-center gap-1 font-medium text-protected">
            <EyeOff className="size-3.5" /> Hidden
          </span>
          {items.map((item) => (
            <Describe key={item.original} item={item} table={table} onSave={(hint) => describe(item, hint)} />
          ))}
        </div>
      )}
      {wire !== undefined ? (
        <p className="rounded-lg bg-muted/60 px-3 py-2 leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/80">The AI will see: </span>
          <span className="font-serif text-[14px] text-foreground">“{wire}”</span>
          {context.length > 0 && <span> Plus {context.length} evidence item{context.length === 1 ? "" : "s"}, hidden the same way.</span>}
        </p>
      ) : (
        items.some((i) => !i.sure) && <p className="text-muted-foreground">Dashed ones are checked by the on-device AI when you ask. It also rewrites the question; turn on review in Options to read the exact text first.</p>
      )}
      {vague > 1 && (
        <p className="flex items-start gap-1.5 text-decoy">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {vague} things will all read as “a name”, so the AI can't tell them apart. Click each one and say what it is, like “a reporter” or “a port”.
        </p>
      )}
    </div>
  );
}

/** One hidden value and how the AI will read it; click to change the description for the whole team. */
function Describe({ item, table, onSave }: { item: Item; table: readonly Pseudonym[]; onSave: (hint: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(item.hint ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const label = item.hint ?? (item.sure ? "hidden" : "AI decides");

  const submit = async () => {
    const hint = draft.trim();
    if (hint.length < 2) return setError("Write a few words.");
    if (findLeaks(hint, [...table, { original: item.original, placeholder: "[X_0]", kind: item.kind }]).length) return setError("Don't use a hidden name in the description.");
    setBusy(true);
    try {
      await onSave(hint.slice(0, 80));
      setOpen(false);
    } catch (e) {
      toast.error("Couldn't save the description", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const chip = (
    <span className={cn("inline-flex max-w-72 items-center gap-1 rounded-full border px-2 py-0.5", item.sure ? "border-protected/30 bg-protected-wash" : "border-dashed", !item.identity && "hover:border-protected")}>
      <span className="truncate font-medium text-foreground">{item.original}</span>
      <span className="shrink-0 text-muted-foreground">→ {label}</span>
      {!item.identity && <PencilSimple className="size-3 shrink-0 text-muted-foreground" />}
    </span>
  );
  if (item.identity) return <span title="A source's real name. Only this device knows it.">{chip}</span>;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDraft(item.hint === "a name" ? "" : (item.hint ?? ""));
          setError(undefined);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Change how ${item.original} is described to the AI`}>
          {chip}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-72 gap-2">
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="describe-hint" className="text-sm font-medium">
            The AI reads “{item.original}” as
          </label>
          <Input id="describe-hint" autoFocus maxLength={80} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="a reporter, a port, a newspaper…" className="h-8" />
          <p className="text-xs text-muted-foreground">
            General words that fit thousands of others. Your whole team uses this description{item.sure ? "" : ", and it will always be hidden"}.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" size="sm" disabled={busy} className="justify-self-end">
            Save
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
