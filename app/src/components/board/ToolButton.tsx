import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={onClick} aria-label={label} className="grid size-10 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&+&]:border-t [&_svg]:size-4">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
