/** The same arrows the board draws, small enough for the legend. */
export function LegendArrow({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
      <line x1="1" y1="5" x2="17" y2="5" stroke={color} strokeWidth={dashed ? 1.5 : 2} strokeDasharray={dashed ? "3 2.5" : undefined} strokeLinecap="round" />
      <path d="M16 1.5 L22.5 5 L16 8.5 Z" fill={color} />
    </svg>
  );
}
