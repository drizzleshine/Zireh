import { Check, Plus, Scales as Scale } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

/** What this page is for, in three steps, for a case with no findings yet. */
export function Explainer({ onWrite, canWrite }: { onWrite: () => void; canWrite: boolean }) {
  const steps = [
    { n: 1, title: "Notice", text: "Someone adds an observation to a piece of evidence, or saves an answer from Research." },
    { n: 2, title: "Check", text: "Your team reads it against the evidence and accepts or rejects it." },
    { n: 3, title: "Claim", text: "A finding is a sentence you'd print, backed by accepted observations from two sources." },
  ];
  return (
    <div className="grid gap-6 rounded-2xl border border-dashed px-6 py-10">
      <div className="grid justify-items-center gap-2 text-center">
        <Scale className="size-8 text-muted-foreground" />
        <strong>No findings yet</strong>
      </div>
      <ol className="mx-auto grid max-w-3xl gap-4 sm:grid-cols-3">
        {steps.map((s) => (
          <li key={s.n} className="grid content-start gap-1">
            <span className="flex items-center gap-2 text-sm font-medium">
              <span className="grid size-6 place-items-center rounded-full bg-protected-wash text-xs font-semibold text-protected">{s.n}</span>
              {s.title}
            </span>
            <span className="text-sm text-muted-foreground">{s.text}</span>
          </li>
        ))}
      </ol>
      {canWrite && (
        <Button className="justify-self-center" onClick={onWrite}>
          <Plus /> Write the first finding
        </Button>
      )}
    </div>
  );
}
