import { type Publication } from "@zireh/cases";
import { OUTCOMES } from "./outcomes.ts";

export function PublicationPreview({ publication: p }: { publication: Publication }) {
  return (
    <article className="grid gap-4 rounded-lg border bg-background p-5 md:p-8" aria-label="Page preview">
      <p className="text-xs font-semibold uppercase tracking-wide text-protected">{p.conclusion ? OUTCOMES.find((o) => o.id === p.conclusion!.outcome)!.label : ""}</p>
      <h3 className="font-serif text-2xl leading-tight">{p.title}</h3>
      <p className="font-serif text-muted-foreground">{p.question}</p>
      <p className="font-serif text-lg leading-relaxed">{p.conclusion?.summary}</p>
      {p.conclusion?.openQuestion && <p className="font-serif text-muted-foreground">Still open: {p.conclusion.openQuestion}</p>}
      {p.findings.map((f, i) => (
        <section key={i} className="grid gap-2 border-t pt-4">
          <h4 className="text-sm font-semibold">Finding {i + 1}</h4>
          <p className="font-serif text-[1.0625rem]">{f.statement}</p>
          {f.uncertainty && <p className="font-serif text-sm text-muted-foreground">Uncertain: {f.uncertainty}</p>}
          <p className="text-xs text-muted-foreground">
            Team review: {f.support} agree, {f.disagree} disagree
          </p>
          {f.observations.map((o, j) => (
            <blockquote key={j} className="grid gap-1 border-l-[3px] border-protected bg-card px-4 py-2">
              <p className="font-serif text-[0.9375rem]">{o.text}</p>
              <footer className="text-xs text-muted-foreground">
                {o.by}
                {o.evidence.map((e, k) => (
                  <span key={k} className="block break-all">
                    Evidence: “{e.title}”
                  </span>
                ))}
              </footer>
            </blockquote>
          ))}
        </section>
      ))}
      <p className="text-xs text-muted-foreground">
        Published {new Date(p.publishedAt).toUTCString()}
        {p.authors.length ? ` by ${p.authors.join(", ")}` : ""}
      </p>
    </article>
  );
}
