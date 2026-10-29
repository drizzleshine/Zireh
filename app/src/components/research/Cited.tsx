import { Fragment } from "react";
import { cn } from "@/lib/utils";

export function Cited({ text, invalid }: { text: string; invalid: string[] }) {
  return (
    <>
      {text.split(/(\[A\d+\])/g).map((part, i) => {
        const m = /^\[(A\d+)\]$/.exec(part);
        if (!m) return <Fragment key={i}>{part}</Fragment>;
        const bad = invalid.includes(m[1]!);
        return (
          <sup key={i} className={cn("mx-0.5 rounded px-1 font-sans text-[0.625rem] font-semibold", bad ? "bg-destructive/10 text-destructive line-through" : "bg-protected-wash text-protected")} title={bad ? "No answer matches this citation" : "Matches an answer that came back. Not a fact check."}>
            {m[1]}
          </sup>
        );
      })}
    </>
  );
}
