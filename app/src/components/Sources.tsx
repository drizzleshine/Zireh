import type { CaseRecords } from "@zireh/cases";
import { Check, Fingerprint, LockSimple as Lock, Plus, Trash, User as UserRound } from "@phosphor-icons/react";
import { useState } from "react";
import { addSource, nextCodename, removeSource, setIdentity, useIdentities, useSources } from "../sources.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** Attribute evidence to a source by codename. Never asks for a real name. */
/** `plain` renders the trigger as inline text, for use inside a line of metadata. */
export function SourcePicker({ rec, value, onChange, disabled, className, plain }: { rec: CaseRecords; value: string | undefined; onChange: (source: string | undefined) => void; disabled?: boolean; className?: string; plain?: boolean }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const existing = useSources(rec.case.id, rec);
  const fresh = nextCodename(existing);
  const pick = (source: string | undefined) => {
    onChange(source);
    setOpen(false);
    setTyped("");
  };
  const custom = typed.trim();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {plain ? (
          <button type="button" className={cn("inline-flex items-center gap-1 rounded-sm text-xs underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none", value ? "text-foreground/80" : "text-protected", className)}>
            <UserRound className="size-3.5" />
            {value ?? "Add source"}
          </button>
        ) : (
          <Button type="button" variant="outline" size="sm" className={cn("h-7 gap-1.5 px-2 text-xs font-normal", !value && "text-muted-foreground", className)}>
            <UserRound className="size-3.5" />
            {value ?? "Add source"}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Codename or public record…" value={typed} onValueChange={setTyped} />
          <CommandList>
            <CommandEmpty>Press the option below to use it.</CommandEmpty>
            {custom && !existing.some((c) => c.toLowerCase() === custom.toLowerCase()) && (
              <CommandGroup>
                <CommandItem value={`__custom ${custom}`} onSelect={() => pick(custom.slice(0, 60))}>
                  <Plus /> Use “{custom.slice(0, 60)}”
                </CommandItem>
              </CommandGroup>
            )}
            {existing.length > 0 && (
              <CommandGroup heading="Sources in this case">
                {existing.map((c) => (
                  <CommandItem key={c} value={c} onSelect={() => pick(c)}>
                    <UserRound /> {c}
                    {value === c && <Check className="ml-auto" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="New">
              <CommandItem value={`__new ${fresh}`} onSelect={() => pick(fresh)}>
                <Plus /> New source: {fresh}
              </CommandItem>
              <CommandItem value="__public Public record" onSelect={() => pick("Public record")}>
                <Fingerprint /> Public record
              </CommandItem>
            </CommandGroup>
            {value && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="__none" onSelect={() => pick(undefined)} className="text-muted-foreground">
                    No source recorded
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
        <p className="border-t px-3 py-2 text-[11px] leading-snug text-muted-foreground">Use a codename, never a real name. Your team only sees codenames.</p>
      </PopoverContent>
    </Popover>
  );
}

/** Every source in the case, with a real-identity note that never leaves this browser. */
export function SourcesSheet({ caseId, rec, open, onOpenChange }: { caseId: string; rec: CaseRecords; open: boolean; onOpenChange: (open: boolean) => void }) {
  const identities = useIdentities(caseId);
  const list = useSources(caseId, rec);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Sources</SheetTitle>
          <SheetDescription>Your team only sees codenames. A real name you write here stays in this browser and is always hidden from AI.</SheetDescription>
        </SheetHeader>
        <div className="grid content-start gap-3 overflow-y-auto p-4">
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => addSource(caseId, nextCodename(list))}>
            <Plus /> Add source
          </Button>
          {list.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No sources yet. Add one here, or pick one when you add evidence.</p>}
          {list.map((codename) => {
            const items = rec.evidence.filter((e) => e.source === codename);
            const backs = rec.findings.filter((f) => rec.observations.some((o) => f.observationIds.includes(o.id) && o.evidenceIds.some((id) => items.some((e) => e.id === id)))).length;
            return (
              <div key={codename} className="grid gap-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <UserRound className="size-4 text-muted-foreground" />
                  <span className="font-medium">{codename}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {items.length ? `${items.length} item${items.length === 1 ? "" : "s"} · backs ${backs} finding${backs === 1 ? "" : "s"}` : "Not used yet · only on this device"}
                  </span>
                  {items.length === 0 && (
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={`Remove ${codename}`} onClick={() => removeSource(caseId, codename)}>
                      <Trash />
                    </Button>
                  )}
                </div>
                {codename !== "Public record" && (
                  <label className="grid gap-1">
                    <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                      <Lock className="size-3" /> Real identity · this device only
                    </span>
                    <Input
                      type="password"
                      autoComplete="off"
                      defaultValue={identities[codename] ?? ""}
                      onBlur={(e) => setIdentity(caseId, codename, e.target.value)}
                      onFocus={(e) => (e.target.type = "text")}
                      onBlurCapture={(e) => ((e.target as HTMLInputElement).type = "password")}
                      placeholder="Optional. Shown only while editing."
                      className="h-8 text-sm"
                    />
                  </label>
                )}
                {identities[codename] && (
                  <Badge variant="outline" className="w-fit gap-1 border-protected/30 font-normal text-protected">
                    <Check className="size-3" /> Hidden from AI calls on this device
                  </Badge>
                )}
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
