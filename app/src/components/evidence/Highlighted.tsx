import { KIND_LABEL, segments, type Hit } from "../../intake.ts";
import { cn } from "@/lib/utils";

export function Highlighted({ text, hits, query }: { text: string; hits: readonly Hit[]; query: string }) {
  const q = query.trim();
  const marks = q.length > 1 ? [...hits, { text: q, kind: "other" as const, known: false, guess: false, query: true }] : hits;
  return (
    <>
      {segments(text, marks).map((s, i) =>
        !s.hit ? (
          <span key={i}>{s.text}</span>
        ) : "query" in s.hit ? (
          <mark key={i} className="rounded-sm bg-decoy-wash px-0.5 text-foreground">
            {s.text}
          </mark>
        ) : (
          <span key={i} className={cn("decoration-protected/60 underline decoration-dotted decoration-2 underline-offset-[3px]", s.hit.known && "decoration-solid")} title={s.hit.known ? "Always hidden" : `${KIND_LABEL[s.hit.kind]}, hidden when sent`}>
            {s.text}
          </span>
        ),
      )}
    </>
  );
}
