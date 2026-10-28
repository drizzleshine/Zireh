import type { ReactNode } from "react";
import { Dialog as Root, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** App modal on Radix: focus trap, Escape, scroll lock and enter/exit motion. */
export function Dialog({ title, description, onClose, children, wide }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <Root open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={wide ? "gap-6 sm:max-w-2xl" : "gap-6 sm:max-w-lg"}>
        <DialogHeader>
          <DialogTitle className="text-lg">{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        {/* Body blocks sit 24px apart; the negative margin keeps focus rings from being clipped by the scroller. */}
        <div className="-mx-6 grid max-h-[70vh] content-start gap-6 overflow-y-auto px-6">{children}</div>
      </DialogContent>
    </Root>
  );
}
