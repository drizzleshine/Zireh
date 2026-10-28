import { Check, Minus } from "@phosphor-icons/react";
import { Dialog } from "./Dialog.tsx";
import { Button } from "@/components/ui/button";

const SEES: [string, ...string[]][] = [
  ["Names, places, quotes", "✓", "–", "–", "–"],
  ["Your case files and team", "✓", "–", "locked", "–"],
  ["General questions (no names)", "✓", "✓", "–", "✓"],
  ["Which questions are decoys", "✓", "–", "–", "–"],
  ["Which questions belong together", "✓", "–", "–", "–"],
  ["Who paid", "✓", "–", "–", "–"],
];

const STEPS: [string, string][] = [
  ["Hide", "Names, places, numbers and quotes are swapped for vague words on your computer."],
  ["Rewrite and split", "Your question is made general. Higher levels split it so no single piece tells the story."],
  ["Check for leaks", "Each piece is checked before it goes. Risky ones are reworded or held back."],
  ["Add decoys", "Ordinary questions on unrelated topics go out alongside the real ones."],
  ["Send separately", "Each piece goes out on its own, paid with its own coins."],
  ["Put it back together", "Decoy answers are thrown away. Real ones are joined here and the names put back."],
];

/** Plain explanation of the privacy model, reachable from anywhere. Spacing follows the dialog rhythm: 24 between blocks, 16 inside. */
export function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="How Zireh protects you" description="What happens to a question between you and the AI." onClose={onClose} wide>
      <ol className="grid gap-4 sm:grid-cols-2">
        {STEPS.map(([title, text], i) => (
          <li key={title} className="flex gap-4">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-protected-wash font-display text-sm font-semibold text-protected tabular-nums">{i + 1}</span>
            <div className="grid gap-1 pt-1">
              <p className="text-sm font-medium">{title}</p>
              <p className="text-sm text-muted-foreground">{text}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="section">
        <h3 className="text-sm font-semibold">Who can see what</h3>
        <div className="overflow-x-auto rounded-xl surface">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr className="h-10">
                <th scope="col" className="px-4 text-left font-medium">
                  <span className="sr-only">What</span>
                </th>
                {["You", "Relay", "Sync server", "AI provider"].map((h) => (
                  <th key={h} scope="col" className="px-4 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {SEES.map(([what, ...cells]) => (
                <tr key={what} className="h-10">
                  <th scope="row" className="px-4 text-left font-normal">
                    {what}
                  </th>
                  {cells.map((c, i) => (
                    <td key={i} className="px-4 text-center">
                      {c === "✓" ? <Check className="mx-auto size-4 text-protected" weight="bold" aria-label="Yes" /> : c === "–" ? <Minus className="mx-auto size-4 text-muted-foreground/40" aria-label="No" /> : <span className="text-xs text-muted-foreground">{c}</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="rounded-xl bg-muted/60 p-4 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Two honest limits.</span> The topic still shows: the AI can tell someone asked about press safety, not who or where. And the relay can see your internet address. The Privacy log shows everything that was sent.
      </p>

      <div className="flex justify-end">
        <Button onClick={onClose}>Got it</Button>
      </div>
    </Dialog>
  );
}
