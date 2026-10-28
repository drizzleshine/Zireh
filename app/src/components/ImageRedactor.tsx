import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";

type Box = { x: number; y: number; w: number; h: number };

/**
 * Hide faces, plates and signs before an image becomes evidence: drag boxes over them, then
 * pixelate. Runs on a canvas on this computer; the result replaces the image (no original kept).
 */
export function ImageRedactor({ src, onChange }: { src: string; onChange: (dataUrl: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [drag, setDrag] = useState<Box | undefined>();

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const c = canvas.current!;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
    };
    img.src = src;
    setBoxes([]);
  }, [src]);

  const toImage = (e: ReactPointerEvent) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };

  function pixelate() {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    for (const b of boxes) {
      const x = Math.max(0, Math.round(Math.min(b.x, b.x + b.w)));
      const y = Math.max(0, Math.round(Math.min(b.y, b.y + b.h)));
      const w = Math.min(c.width - x, Math.round(Math.abs(b.w)));
      const h = Math.min(c.height - y, Math.round(Math.abs(b.h)));
      if (w < 2 || h < 2) continue;
      const cell = Math.max(8, Math.round(Math.max(w, h) / 12)); // coarse enough that faces can't be recovered
      const data = ctx.getImageData(x, y, w, h);
      for (let cy = 0; cy < h; cy += cell)
        for (let cx = 0; cx < w; cx += cell) {
          const i = (cy * w + cx) * 4;
          ctx.fillStyle = `rgb(${data.data[i]},${data.data[i + 1]},${data.data[i + 2]})`;
          ctx.fillRect(x + cx, y + cy, Math.min(cell, w - cx), Math.min(cell, h - cy));
        }
    }
    setBoxes([]);
    onChange(c.toDataURL("image/jpeg", 0.85));
  }

  return (
    <div className="grid gap-2">
      <div className="relative justify-self-start leading-none">
        <canvas
          ref={canvas}
          className="block max-h-[360px] max-w-[min(100%,520px)] cursor-crosshair touch-none rounded-md border"
          aria-label="Image. Drag to mark areas to hide."
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            const p = toImage(e);
            setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
          }}
          onPointerMove={(e) => {
            if (!drag) return;
            const p = toImage(e);
            setDrag({ ...drag, w: p.x - drag.x, h: p.y - drag.y });
          }}
          onPointerUp={() => {
            if (drag && Math.abs(drag.w) > 4 && Math.abs(drag.h) > 4) setBoxes((b) => [...b, drag]);
            setDrag(undefined);
          }}
        />
        {canvas.current &&
          [...boxes, ...(drag ? [drag] : [])].map((b, i) => {
            const c = canvas.current!;
            return (
              <span
                key={i}
                className="pointer-events-none absolute border-2 border-destructive bg-destructive/15"
                style={{
                  left: `${(Math.min(b.x, b.x + b.w) / c.width) * 100}%`,
                  top: `${(Math.min(b.y, b.y + b.h) / c.height) * 100}%`,
                  width: `${(Math.abs(b.w) / c.width) * 100}%`,
                  height: `${(Math.abs(b.h) / c.height) * 100}%`,
                }}
              />
            );
          })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Drag over faces, plates or signs to hide them.</span>
        {boxes.length > 0 && (
          <>
            <Button type="button" size="sm" variant="ghost" onClick={() => setBoxes([])}>
              Clear marks
            </Button>
            <Button type="button" size="sm" onClick={pixelate}>
              Hide {boxes.length} area{boxes.length === 1 ? "" : "s"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
