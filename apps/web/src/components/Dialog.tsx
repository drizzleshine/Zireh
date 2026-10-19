import { useEffect, useRef, type ReactNode } from "react";

/** Native modal dialog: focus trapping, Escape and backdrop come from the browser. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    const close = () => onClose();
    el.addEventListener("close", close);
    return () => el.removeEventListener("close", close);
  }, [onClose]);
  return (
    <dialog ref={ref} aria-labelledby="dialog-title">
      <div className="dialog-body">
        <h2 id="dialog-title">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
