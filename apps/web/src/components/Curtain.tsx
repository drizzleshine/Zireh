import { useEffect, useRef } from "react";

/**
 * Privacy curtain: covers the whole app with a plain, unremarkable page the moment someone
 * looks over your shoulder. The tab title changes too. Lift it with the same shortcut
 * (⌘⇧H / Ctrl+Shift+H) or by double-clicking.
 */
export function Curtain({ onLift }: { onLift: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const title = document.title;
    document.title = "Untitled";
    ref.current?.focus();
    return () => {
      document.title = title;
    };
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      onDoubleClick={onLift}
      className="fixed inset-0 z-[100] grid place-items-start bg-white px-[12vw] py-[14vh] text-neutral-400 outline-none"
      aria-label="Screen hidden. Press Command Shift H or double-click to show it again."
      role="dialog"
    >
      <div className="grid w-full max-w-2xl gap-6">
        <div className="h-7 w-48 rounded bg-neutral-100" />
        <div className="grid gap-3">
          {[92, 100, 86, 97, 64].map((w, i) => (
            <div key={i} className="h-3 rounded bg-neutral-100" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
