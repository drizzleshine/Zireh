import { sha256Hex } from "@zireh/crypto";
import type { CaseRecords } from "@zireh/cases";
import type { Evidence, Pseudonym } from "@zireh/schema";
import { X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { scan, type Draft } from "../../intake.ts";
import { SourcePicker } from "../Sources.tsx";
import { ImageRedactor } from "../ImageRedactor.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { KINDS, kindOf } from "./kinds.ts";
import { ScanStrip } from "./ScanStrip.tsx";

export function DraftRow({ rec, caseId, draft, table, onChange, onRemove }: { rec: CaseRecords; caseId: string; draft: Draft; table: readonly Pseudonym[]; onChange: (patch: Partial<Draft>) => void; onRemove: () => void }) {
  const hits = useMemo(() => scan(draft.body, table), [draft.body, table]);
  const [hash, setHash] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setHash(sha256Hex(draft.body)), 150);
    return () => clearTimeout(t);
  }, [draft.body]);
  const Icon = kindOf(draft.kind).icon;

  return (
    <li className="grid gap-3 rounded-xl bg-card p-4 surface animate-in fade-in-0 slide-in-from-top-1 duration-200">
      <div className="flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
          <Icon className="size-4" />
        </span>
        <Input value={draft.title} onChange={(e) => onChange({ title: e.target.value })} maxLength={200} aria-label="Title" className="h-8 flex-1 border-transparent bg-transparent px-1.5 font-medium shadow-none hover:border-input focus-visible:border-ring" />
        <SourcePicker rec={rec} value={draft.source} onChange={(source) => onChange({ source })} />
        {draft.kind !== "image" && (
          <ToggleGroup type="single" size="sm" variant="outline" value={draft.kind} onValueChange={(v) => v && onChange({ kind: v as Evidence["kind"] })} aria-label="Kind">
            {KINDS.filter((k) => k.id !== "image").map((k) => (
              <ToggleGroupItem key={k.id} value={k.id} className="px-2 text-xs" aria-label={k.label}>
                {k.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <Button variant="ghost" size="icon" className="size-8" onClick={onRemove} aria-label="Remove from staging">
          <X />
        </Button>
      </div>
      {draft.kind === "image" ? (
        <ImageRedactor src={draft.body} onChange={(body) => onChange({ body, note: "Marked areas pixelated on this device." })} />
      ) : (
        <Textarea value={draft.body} onChange={(e) => onChange({ body: e.target.value })} aria-label="Content" className="max-h-56 min-h-20 font-serif text-[15px] leading-relaxed" />
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {draft.note && <span>{draft.note}</span>}
        {draft.kind !== "image" && <span className="tabular-nums">{draft.body.length.toLocaleString()} characters</span>}
        {hash && <span className="font-mono tabular-nums" title={hash}>sha256 {hash.slice(0, 12)}</span>}
      </div>
      {hits.length > 0 && <ScanStrip hits={hits} caseId={caseId} table={table} />}
    </li>
  );
}
