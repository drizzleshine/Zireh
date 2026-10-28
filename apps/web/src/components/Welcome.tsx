import { ArrowRight, CalendarBlank as CalendarRange, EyeSlash as EyeOff, Flask as FlaskConical, LockSimple as Lock, ChatTeardropText as MessageSquareReply, Plus, ShieldCheck, User as UserRound } from "@phosphor-icons/react";
import { Fragment, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** Each example: the question as written, with [bracketed] parts hidden, and what the provider gets. */
const EXAMPLES = [
  {
    asked: "Is [Ada Obi] at risk after her report on smuggling at [Apapa port] in [Lagos]?",
    sent: "Is a journalist at risk after reporting on smuggling at a port in a West African city?",
    decoy: "Which soils hold water best for dry-season maize?",
  },
  {
    asked: "Can [Dr. Lena Ortiz] be sued for sharing [St. Brigid's] infection data with us?",
    sent: "Can a doctor face legal action for sharing hospital infection data with the press?",
    decoy: "How long should sourdough proof in a cold kitchen?",
  },
  {
    asked: "Who owns [Harbor Line Freight], the firm paid [$2.4m] by [the ministry]?",
    sent: "How can I find the owners of a private freight company that received a government payment?",
    decoy: "What are the rules for a backyard chicken coop?",
  },
];

const FEATURES = [
  { icon: EyeOff, title: "Names hidden on your device" },
  { icon: UserRound, title: "Sources kept by codename" },
  { icon: ShieldCheck, title: "Two-source rule on every finding" },
  { icon: MessageSquareReply, title: "Right-of-reply tracker" },
  { icon: CalendarRange, title: "Timeline from your evidence" },
  { icon: Lock, title: "Leak check before you publish" },
];

export function Welcome({ onNewCase, onDemo }: { onNewCase: () => void; onDemo: () => void }) {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-16 px-4 pt-2 pb-16 md:px-10 md:pt-6">
      <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.05fr]">
        <div className="grid content-start gap-6">
          <h1 style={{ ["--i" as string]: 1 }} className="arrive text-[2.5rem] leading-[1.02] font-semibold tracking-[-0.035em] md:text-[3.25rem] xl:text-[3.75rem]">
            Ask AI about your investigation. <span className="text-muted-foreground">Keep your sources yours.</span>
          </h1>
          <p style={{ ["--i" as string]: 2 }} className="arrive max-w-[46ch] text-base leading-relaxed text-muted-foreground md:text-lg">
            Ask AI about sensitive work and see exactly what gets sent. Case files are end-to-end encrypted for your team.
          </p>
          <div style={{ ["--i" as string]: 3 }} className="arrive flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={onDemo} className="h-11 px-5">
              <FlaskConical /> Open the demo case <ArrowRight />
            </Button>
            <Button size="lg" variant="ghost" onClick={onNewCase} className="h-11">
              <Plus /> Start your own
            </Button>
          </div>
        </div>
        <Specimen />
      </div>

      <ul className="grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-8 sm:grid-cols-3">
        {FEATURES.map((f, n) => (
          <li key={f.title} style={{ ["--i" as string]: 6 + n }} className="arrive flex items-center gap-3 text-sm">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-protected-wash text-protected">
              <f.icon className="size-4" weight="duotone" />
            </span>
            {f.title}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A looping before/after: the reader watches names get inked out, then sees what actually leaves. */
function Specimen() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), 6500);
    return () => clearInterval(t);
  }, []);
  const ex = EXAMPLES[i]!;
  let hidden = 0;

  return (
    <figure className="relative overflow-hidden rounded-2xl bg-card shadow-[var(--shadow-border),0_24px_48px_-24px_oklch(0.3_0.02_60/0.25)]" aria-label="Example of what Zireh sends">
      <div className="flex items-center gap-2 border-b px-5 py-3 text-xs text-muted-foreground">
        <span className="ml-auto flex">
          {EXAMPLES.map((_, n) => (
            <button key={n} type="button" onClick={() => setI(n)} aria-label={`Example ${n + 1}`} className="-my-3 grid h-10 w-6 place-items-center">
              <span className={n === i ? "h-1.5 w-6 rounded-full bg-foreground transition-[width,background-color] duration-200 ease-out" : "h-1.5 w-1.5 rounded-full bg-border transition-[width,background-color] duration-200 ease-out"} />
            </button>
          ))}
        </span>
      </div>
      <div key={i} className="grid">
        <div className="grid gap-2 p-5 md:p-7">
          <span className="text-xs font-medium text-muted-foreground">You write</span>
          <p className="font-serif text-xl leading-relaxed md:text-[22px]">
            {ex.asked.split(/(\[[^\]]+\])/).map((part, n) =>
              part.startsWith("[") ? (
                <span key={n} className="ink" style={{ ["--i" as string]: hidden++, ["--ink-delay" as string]: "700ms" }}>
                  {part.slice(1, -1)}
                </span>
              ) : (
                <Fragment key={n}>{part}</Fragment>
              ),
            )}
          </p>
        </div>
        <div className="grid min-h-52 content-start gap-3 border-t border-dashed bg-muted/40 p-5 md:p-7">
          <span className="text-xs font-medium text-muted-foreground">The AI provider receives</span>
          <p className="arrive font-serif text-lg leading-relaxed" style={{ ["--i" as string]: 16 }}>
            {ex.sent}
          </p>
          <p className="arrive flex items-baseline gap-2 rounded-lg bg-decoy-wash px-3 py-2 font-serif leading-relaxed" style={{ ["--i" as string]: 20 }}>
            <span className="font-sans text-[11px] font-semibold tracking-wide text-decoy uppercase">decoy</span>
            {ex.decoy}
          </p>
        </div>
      </div>
    </figure>
  );
}
