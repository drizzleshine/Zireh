import { useEffect, useState } from "react";

/**
 * Layout guides for development, toggled with ⌘⇧G / Ctrl+Shift+G or opened with ?grid:
 *  - the content column every screen shares (max 1152px, gutters 16px / 40px) and its 12 columns,
 *  - an 8px baseline,
 *  - the real vertical gaps between stacked blocks and the padding of every card, measured from
 *    the page and labelled in px. Values off the 4px scale are red; on 4 but not 8 are amber.
 * Only included in development builds.
 */
export function DevGrid() {
  const [on, setOn] = useState(() => new URLSearchParams(location.search).has("grid"));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setOn((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!on) return null;

  return (
    <>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[60] overflow-hidden">
        <div className="absolute inset-0 bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_7px,oklch(0.65_0.2_300/0.08)_7px,oklch(0.65_0.2_300/0.08)_8px)]" />
        <div className="relative mx-auto h-full w-full max-w-6xl px-4 md:px-10">
          <div className="relative grid h-full grid-cols-4 gap-4 border-x border-[oklch(0.62_0.24_300/0.7)] md:grid-cols-12 md:gap-6">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className={i >= 4 ? "hidden bg-[oklch(0.65_0.2_300/0.05)] md:block" : "bg-[oklch(0.65_0.2_300/0.05)]"} />
            ))}
          </div>
        </div>
      </div>
      <Measures />
    </>
  );
}

interface Mark {
  readonly key: string;
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly value: number;
  readonly kind: "gap" | "pad";
}

const visible = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;

function measure(root: Element): Mark[] {
  const marks = new Map<string, Mark>();
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if (el.closest("[data-devgrid], .react-flow, svg")) continue;
    const box = el.getBoundingClientRect();
    if (!visible(box)) continue;
    const cs = getComputedStyle(el);

    // Padding of anything drawn as a card (border + padding): top and left.
    const pt = parseFloat(cs.paddingTop);
    const pl = parseFloat(cs.paddingLeft);
    if (parseFloat(cs.borderTopWidth) > 0 && pt >= 8 && pl >= 8 && box.height > 40) {
      marks.set(`p${Math.round(box.top)}:${Math.round(box.left)}`, { key: `p${marks.size}`, kind: "pad", top: box.top, left: box.left, width: pl, height: pt, value: Math.round(pt) });
    }

    // Gaps between consecutive children stacked on top of each other.
    const stacked = cs.display.includes("grid") || (cs.display.includes("flex") && cs.flexDirection.startsWith("column")) || cs.display === "block";
    if (!stacked || el.children.length < 2) continue;
    let prev: DOMRect | undefined;
    for (const child of el.children) {
      const r = child.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(child).position === "absolute" || getComputedStyle(child).position === "fixed") continue;
      if (prev && r.top >= prev.bottom - 0.5 && r.left < prev.right && r.right > prev.left) {
        const gap = r.top - prev.bottom;
        if (gap >= 2 && gap < 120 && visible(r)) {
          const top = prev.bottom;
          const key = `g${Math.round(top)}:${Math.round(gap)}`;
          if (!marks.has(key)) marks.set(key, { key, kind: "gap", top, left: box.left, width: box.width, height: gap, value: Math.round(gap) });
        }
      }
      prev = r;
    }
  }
  return [...marks.values()];
}

const tone = (v: number) => (v % 4 ? "bg-red-600" : v % 8 ? "bg-amber-500" : "bg-[oklch(0.55_0.24_300)]");

function Measures() {
  const [marks, setMarks] = useState<Mark[]>([]);
  useEffect(() => {
    const root = document.querySelector("[data-slot=sidebar-inset]");
    if (!root) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setMarks(measure(root)));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      removeEventListener("scroll", update);
      removeEventListener("resize", update);
    };
  }, []);

  return (
    <div aria-hidden="true" data-devgrid className="pointer-events-none fixed inset-0 z-[61]">
      {marks.map((m) =>
        m.kind === "gap" ? (
          <div key={m.key} className="absolute border-y border-dashed border-[oklch(0.62_0.24_300/0.55)] bg-[oklch(0.65_0.2_300/0.10)]" style={{ top: m.top, left: m.left, width: m.width, height: m.height }}>
            <span className={`absolute top-1/2 left-1 -translate-y-1/2 rounded-full px-1.5 font-mono text-[10px] leading-4 text-white shadow ${tone(m.value)}`}>{m.value}</span>
          </div>
        ) : (
          <div key={m.key} className="absolute bg-[oklch(0.75_0.15_200/0.18)]" style={{ top: m.top, left: m.left, width: m.width, height: m.height }}>
            <span className={`absolute top-0 left-0 rounded-br-md px-1 font-mono text-[9px] leading-3.5 text-white ${tone(m.value)}`}>{m.value}</span>
          </div>
        ),
      )}
    </div>
  );
}
