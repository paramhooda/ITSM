import { Fragment, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { fmtNumber } from '@/lib/format';
import { useChartTheme } from './chartTheme';

export interface HeatmapCell {
  row: string;
  col: string;
  value: number;
  /** The list this cell drills down to (the created window of the cell, on the dashboards). */
  href?: string;
  /** Tooltip text; defaults to "<row> <col>:00 · <value> <unit>". */
  title?: string;
}

export interface HeatmapGridProps {
  cells: HeatmapCell[];
  /** Row and column order; defaults to first appearance. */
  rows?: readonly string[];
  cols?: readonly string[];
  /** Printed after the value in the tooltip and the legend. */
  unit?: string;
  emptyText?: string;
  /** Column header text (the hour by default). */
  colLabel?: (col: string) => string;
  legend?: boolean;
  className?: string;
}

/**
 * Weekday-by-hour grid (or any row × column grid) in one sequential hue: the
 * darker the cell the more it holds, zero cells sit on the surface, and the
 * legend names the scale in text. A cell with an `href` is a door into the
 * list it was counted on. Shared by the dashboards and the report preview.
 */
export function HeatmapGrid({ cells, rows, cols, unit = 'tickets', emptyText = 'No data', colLabel = (c) => c, legend = true, className }: HeatmapGridProps) {
  const t = useChartTheme();
  const rowKeys = rows ?? [...new Set(cells.map((c) => c.row))];
  const colKeys = cols ?? [...new Set(cells.map((c) => c.col))];
  const { lookup, max, total } = useMemo(() => {
    const lookup = new Map(cells.map((c) => [`${c.row}\u0000${c.col}`, c]));
    const values = cells.map((c) => Math.max(0, c.value || 0));
    return { lookup, max: Math.max(1, ...values), total: values.reduce((n, v) => n + v, 0) };
  }, [cells]);
  if (!cells.length || !rowKeys.length || !colKeys.length) return <div className="text-[13px] text-subtle py-6 text-center">{emptyText}</div>;
  const ramp = t.sequential;
  const shade = (v: number) => (v <= 0 ? null : ramp[Math.min(ramp.length - 1, Math.ceil((v / max) * ramp.length) - 1)]!);
  return (
    <div className={cn('overflow-x-auto', className)}>
      {/* A group, not a table: the cells are plain links and boxes without row or cell roles; each linked cell carries its own label. */}
      <div className="grid gap-px text-[10px] text-subtle min-w-[520px]" style={{ gridTemplateColumns: `auto repeat(${colKeys.length}, minmax(0, 1fr))` }} role="group" data-testid="heatmap" aria-label={`${fmtNumber(total)} ${unit} by ${rowKeys.length} rows and ${colKeys.length} columns`}>
        <div />
        {colKeys.map((c) => <div key={c} className="text-center tnum">{colLabel(c)}</div>)}
        {rowKeys.map((r) => (
          <Fragment key={r}>
            <div className="pr-1.5 text-right leading-4">{r}</div>
            {colKeys.map((c) => {
              const cell = lookup.get(`${r}\u0000${c}`);
              const v = Math.max(0, cell?.value ?? 0);
              const title = cell?.title ?? `${r} ${c}:00 · ${fmtNumber(v)} ${unit}`;
              const style = { background: shade(v) ?? undefined };
              const cls = cn('block h-4 rounded-[2px]', v <= 0 && 'bg-surface-2', cell?.href && 'hover:ring-2 hover:ring-brand-500/40 focus-visible:ring-2 focus-visible:ring-brand-500/40 outline-none');
              return cell?.href ? <Link key={c} to={cell.href} title={title} aria-label={title} className={cls} style={style} /> : <div key={c} title={title} className={cls} style={style} />;
            })}
          </Fragment>
        ))}
      </div>
      {legend && (
        <div className="flex items-center gap-2 mt-2 text-[11px] text-subtle tnum">
          <span>0</span>
          <span className="inline-flex gap-px" aria-hidden>
            {ramp.map((hex) => <span key={hex} className="h-2.5 w-4 rounded-[2px]" style={{ background: hex }} />)}
          </span>
          <span>{fmtNumber(max)} {unit}</span>
          <span className="ml-auto">{fmtNumber(total)} {unit} in all</span>
        </div>
      )}
    </div>
  );
}
