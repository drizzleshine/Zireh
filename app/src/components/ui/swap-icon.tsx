import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Cross-fades between two icons in place (scale 0.25→1, opacity, 4px blur) instead of
 * swapping them, so a state change like "copied" reads as one motion. Both stay mounted.
 */
export function SwapIcon({ swapped, from, to, className }: { swapped: boolean; from: ReactNode; to: ReactNode; className?: string }) {
  const layer = "col-start-1 row-start-1 grid place-items-center transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)]"
  return (
    <span className={cn("inline-grid size-4 shrink-0 place-items-center", className)} aria-hidden="true">
      <span className={cn(layer, swapped ? "scale-[0.25] opacity-0 blur-[0.25rem]" : "scale-100 opacity-100 blur-0")}>{from}</span>
      <span className={cn(layer, swapped ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[0.25rem]")}>{to}</span>
    </span>
  )
}
