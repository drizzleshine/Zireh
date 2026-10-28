import { Fragment, useMemo } from "react";
import type { Pseudonym } from "@zireh/schema";

/** The question with every hidden value covered by an ink bar, drawn one after another. */
export function Redacted({ text, table }: { text: string; table: readonly Pseudonym[] }) {
  const parts = useMemo(() => {
    if (!table.length) return [text];
    const escaped = [...table].sort((a, b) => b.original.length - a.original.length).map((p) => p.original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  }, [text, table]);
  const originals = new Set(table.map((p) => p.original.toLowerCase()));
  let n = 0;
  return (
    <>
      {parts.map((part, i) =>
        originals.has(part.toLowerCase()) ? (
          <span key={i} className="ink" style={{ ["--i" as string]: n++ }} title="Hidden before sending">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
