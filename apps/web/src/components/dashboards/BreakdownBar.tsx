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
  /** Explicit bar colour (a categorical slot or the de-emphasis gray); wins over `color`. */
  hex?: string;
  href?: string;
  /** Marks the row as the active selection (e.g. the filter currently applied). */
  active?: boolean;
}

/** The rows beyond `foldAfter` folded into one "Other" row in the de-emphasis gray (no link: a folded row has no single predicate). */
export function foldItems(items: BreakdownItem[], foldAfter: number | undefined, gray: string): BreakdownItem[] {
  if (!foldAfter || items.length <= foldAfter + 1) return items;
  const rest = items.slice(foldAfter);
  const secondary = rest.reduce((n, i) => n + (i.secondary ?? 0), 0);
  return [...items.slice(0, foldAfter), { label: `Other (${rest.length})`, value: rest.reduce((n, i) => n + i.value, 0), secondary: secondary || null, secondaryLabel: rest[0]?.secondaryLabel, hex: gray }];
}

/** Horizontal bar list for categorical breakdowns (identity → one colour unless the entity carries its own). */
export function BreakdownBar({ items, emptyText = 'Nothing to show', max, dense, onSelect, foldAfter }: { items: BreakdownItem[]; emptyText?: string; max?: number; dense?: boolean; /** Click handler (rows render as buttons, filtering in place without scrolling); `href` wins when both are set. */ onSelect?: (item: BreakdownItem) => void; /** Rows beyond this many fold into one "Other" row. */ foldAfter?: number }) {
  const t = useChartTheme();
  const shown = foldItems(items, foldAfter, t.deemphasis);
  if (!shown.length) return <div className="text-[13px] text-subtle py-4 text-center">{emptyText}</div>;
  const top = max ?? Math.max(1, ...shown.map((i) => i.value));
  return (
    <ul className={cn('flex flex-col', dense ? 'gap-1' : 'gap-1.5')}>
      {shown.map((i, idx) => {
        const row = (
          <>
            <div className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className={cn('truncate min-w-0', i.active && 'font-medium text-default')}>{i.label}</span>
              <span className="tabular-nums text-muted shrink-0">
                {fmtNumber(i.value)}
                {i.secondary !== undefined && i.secondary !== null && i.secondary > 0 && <span className="ml-1.5 text-red-600" title={i.secondaryLabel ?? 'breached'}>({i.secondary})</span>}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden mt-0.5">
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, (i.value / top) * 100)}%`, background: i.hex ?? optionHex(i.color, t.dark, t.series[0]!) }} />
            </div>
          </>
        );
        return (
          <li key={`${i.label}-${idx}`}>
            {i.href ? (
              <Link to={i.href} className="block rounded-md hover:bg-surface-2 px-1 -mx-1 py-0.5">{row}</Link>
            ) : onSelect ? (
              <button type="button" onClick={() => onSelect(i)} aria-pressed={i.active} className={cn('block w-full text-left rounded-md hover:bg-surface-2 px-1 -mx-1 py-0.5', i.active && 'bg-surface-2')}>{row}</button>
            ) : (
              <div className="px-1 -mx-1 py-0.5">{row}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
