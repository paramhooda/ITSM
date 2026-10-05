/** The plain-English lines the server derives from a specification (never re-implemented in the browser). */
export function SpecSummary({ lines, className }: { lines: string[]; className?: string }) {
  if (!lines.length) return null;
  return (
    <ul className={`text-[12.5px] text-muted flex flex-col gap-0.5 ${className ?? ''}`} aria-label="Report summary">
      {lines.map((l, i) => (
        <li key={i} className="flex gap-1.5">
          <span className="text-subtle">·</span>
          <span>{l}</span>
        </li>
      ))}
    </ul>
  );
}
