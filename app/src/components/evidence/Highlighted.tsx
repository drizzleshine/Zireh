import { KIND_LABEL, segments, type Hit } from "../../intake.ts";

export function Highlighted({ text, hits, query }: { text: string; hits: readonly Hit[]; query: string }) {
  const q = query.trim();
  const marks = q.length > 1 ? [...hits, { text: q, kind: "other" as const, query: true }] : hits;
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
          <span key={i} className="underline decoration-protected/60 decoration-solid decoration-2 underline-offset-[3px]" title={`${KIND_LABEL[s.hit.kind]} on the hide list, always hidden`}>
            {s.text}
          </span>
        ),
      )}
    </>
  );
}
