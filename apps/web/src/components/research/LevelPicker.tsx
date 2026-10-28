import { Check, Cpu, LockSimple as Lock, Shuffle, CaretUpDown, ShieldCheck } from "@phosphor-icons/react";
import { useState } from "react";
import type { PrivacyLevel } from "@zireh/schema";
import { LEVEL_COPY } from "../levels.ts";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const LEVEL_ICON: Record<PrivacyLevel, typeof Cpu> = { local: Cpu, standard: ShieldCheck, private: Shuffle, paranoid: Lock };

/** The privacy level as one compact button; the choices and what each does open in a short list. */
export function LevelPicker({ level, blocked, onChange, onSettings }: { level: PrivacyLevel; blocked: (l: PrivacyLevel) => boolean; onChange: (l: PrivacyLevel) => void; onSettings: (() => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const Icon = LEVEL_ICON[level];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="ml-auto text-muted-foreground" aria-label={`Privacy level: ${LEVEL_COPY[level].name}`}>
          <Icon /> {LEVEL_COPY[level].name} <CaretUpDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1">
        <div role="radiogroup" aria-label="Privacy level" className="grid">
          {(["standard", "private", "paranoid", "local"] as const).map((l) => {
            const LIcon = LEVEL_ICON[l];
            return (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={l === level}
                disabled={blocked(l)}
                onClick={() => {
                  onChange(l);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                <LIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="grid flex-1 gap-0.5">
                  <span className="text-sm font-medium">{LEVEL_COPY[l].name}</span>
                  <span className="text-xs text-muted-foreground">{blocked(l) ? "Needs on-device AI" : LEVEL_COPY[l].note}</span>
                </span>
                <Check className={cn("mt-0.5 size-4 shrink-0", l === level ? "opacity-100" : "opacity-0")} />
              </button>
            );
          })}
        </div>
        {onSettings && (
          <button type="button" onClick={onSettings} className="mt-1 w-full border-t px-3 pt-2 pb-1.5 text-left text-xs font-medium text-foreground/80 hover:text-foreground">
            Turn on on-device AI to unlock the rest
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
