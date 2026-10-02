import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useChartTheme, optionHex } from './chartTheme';
import { fmtNumber } from '@/lib/format';

export interface BreakdownItem {
  label: string;
  value: number;
  /** Secondary count shown after the value (e.g. breached). */
  secondary?: number | null;
  secondaryLabel?: string;
  /** Option colour name (priority/severity); falls back to series slot 1. */
  color?: string | null;
  href?: string;
}

/** Horizontal bar list for categorical breakdowns (identity → one colour unless the entity carries its own). */
export function BreakdownBar({ items, emptyText = 'Nothing to show', max, dense }: { items: BreakdownItem[]; emptyText?: string; max?: number; dense?: boolean }) {
  const t = useChartTheme();
  if (!items.length) return <div className="text-[13px] text-subtle py-4 text-center">{emptyText}</div>;
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={cn('flex flex-col', dense ? 'gap-1' : 'gap-1.5')}>
      {items.map((i, idx) => {
        const row = (
          <>
            <div className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className="truncate min-w-0">{i.label}</span>
              <span className="tabular-nums text-muted shrink-0">
                {fmtNumber(i.value)}
                {i.secondary !== undefined && i.secondary !== null && i.secondary > 0 && <span className="ml-1.5 text-red-600" title={i.secondaryLabel ?? 'breached'}>({i.secondary})</span>}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden mt-0.5">
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, (i.value / top) * 100)}%`, background: optionHex(i.color, t.dark, t.series[0]) }} />
            </div>
          </>
        );
        return (
          <li key={`${i.label}-${idx}`}>
            {i.href ? <Link to={i.href} className="block rounded-md hover:bg-surface-2 px-1 -mx-1 py-0.5">{row}</Link> : <div className="px-1 -mx-1 py-0.5">{row}</div>}
          </li>
        );
      })}
    </ul>
  );
}
