import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clip } from "./model.ts";

/**
 * Expands the board into a modal that fills the window, leaving a thin margin to click out.
 * The frame is fixed in place at once and revealed outwards from where the board sat with a
 * clip-path, so nothing stretches; collapsing plays it back the other way.
 */
export function useExpand(onSettle: () => void) {
  const frame = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const busy = useRef(false);
  const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
  const insetOf = (from: DOMRect, to: DOMRect, radius: number) =>
    `inset(${from.top - to.top}px ${to.right - from.right}px ${to.bottom - from.bottom}px ${from.left - to.left}px round ${radius}px)`;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  useLayoutEffect(() => {
    const el = frame.current;
    const home = slot.current;
    if (!expanded || !el || !home || reduced()) return void (expanded && onSettle());
    el.animate([{ clipPath: insetOf(home.getBoundingClientRect(), el.getBoundingClientRect(), 22) }, { clipPath: "inset(0px 0px 0px 0px round 22px)" }], { duration: 480, easing: EASE });
    onSettle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const toggle = useCallback(() => {
    const el = frame.current;
    const home = slot.current;
    if (busy.current) return;
    if (!expanded || !el || !home || reduced()) {
      setExpanded((e) => !e);
      if (expanded) onSettle();
      return;
    }
    busy.current = true;
    const run = el.animate([{ clipPath: "inset(0px 0px 0px 0px round 22px)" }, { clipPath: insetOf(home.getBoundingClientRect(), el.getBoundingClientRect(), 22) }], { duration: 380, easing: EASE, fill: "forwards" });
    // A background tab may never tick the animation; the timer makes sure the board still closes.
    const done = () => {
      if (!busy.current) return;
      setExpanded(false);
      run.cancel();
      busy.current = false;
      onSettle();
    };
    run.onfinish = done;
    setTimeout(done, 420);
  }, [expanded, onSettle]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && toggle();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [expanded, toggle]);

  return { expanded, frame, slot, toggle };
}
