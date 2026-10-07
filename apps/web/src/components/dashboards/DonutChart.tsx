import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { MAX_SLICES } from '@itsm/shared';
import { cn } from '@/lib/utils';
import { fmtNumber } from '@/lib/format';
import { useChartTheme, optionHex } from './chartTheme';
import { BreakdownBar } from './BreakdownBar';

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  /** Option colour name (priority, severity, status) when the category owns a colour; otherwise the categorical slot by position. */
  color?: string | null;
  /** The list this slice drills down to (the same predicates the number was counted with). */
  href?: string;
}

export interface DonutChartProps {
  slices: DonutSlice[];
  /** Caption under the centre total. */
  centerLabel?: string;
  /** Diameter of the ring in pixels. */
  size?: number;
  emptyText?: string;
  valueFormatter?: (v: number) => string;
  /** How many slices show before the rest fold into "Other" (the product rule is six). */
  maxSlices?: number;
  /** Where the folded "Other" slice opens; it has no single predicate, so it is plain text by default. */
  otherHref?: string;
  /** `auto` falls back to bars when the largest slices are too close to compare by eye. */
  layout?: 'auto' | 'donut' | 'bars';
  className?: string;
}

interface Shown extends DonutSlice {
  hex: string;
  pct: number;
  other?: boolean;
}

/** The largest slices are "close" when the top three sit within twelve percent of each other: a ring cannot show which is bigger, bars can. */
export function slicesAreClose(values: number[]): boolean {
  const top = [...values].sort((a, b) => b - a).slice(0, 3);
  if (top.length < 3 || top[0]! <= 0) return false;
  return (top[0]! - top[2]!) / top[0]! <= 0.12;
}

/** At most `max` slices: the first `max - 1` as they come, the rest folded into one "Other" slice in the de-emphasis gray. */
export function foldSlices(slices: DonutSlice[], max: number): (DonutSlice & { other?: boolean; folded?: number })[] {
  if (slices.length <= max) return slices;
  const kept = slices.slice(0, max - 1);
  const rest = slices.slice(max - 1);
  return [...kept, { key: '__other', label: `Other (${rest.length})`, value: rest.reduce((n, s) => n + s.value, 0), other: true, folded: rest.length }];
}

interface TipPayload { payload?: Shown }

function DonutTooltip({ active, payload, valueFormatter }: { active?: boolean; payload?: TipPayload[]; valueFormatter: (v: number) => string }) {
  const s = payload?.[0]?.payload;
  if (!active || !s) return null;
  return (
    <div className="rounded-lg border border-default bg-white shadow-raised px-3 py-2 text-[12px] min-w-[140px]">
      <div className="flex items-center justify-between gap-4">
        <span className="inline-flex items-center gap-1.5 text-muted"><span className="h-2 w-2 rounded-full" style={{ background: s.hex }} />{s.label}</span>
        <span className="font-medium text-default tnum">{valueFormatter(s.value)}</span>
      </div>
      <div className="text-subtle tnum mt-0.5">{s.pct}% of total{s.href ? ' · open the list' : ''}</div>
    </div>
  );
}

/**
 * Part-of-whole chart: a ring with the total in the centre and a legend that
 * always prints every slice with its value and share in the text tokens. At
 * most six slices then "Other"; colours come from the categorical slots in a
 * fixed order (or the category's own option colour); a slice or legend row
 * with an `href` is a door into the list it was counted on. When the largest
 * slices are too close to read, the same data renders as bars instead.
 */
export function DonutChart({ slices, centerLabel = 'total', size = 168, emptyText = 'Nothing to show', valueFormatter = (v) => fmtNumber(v), maxSlices = MAX_SLICES, otherHref, layout = 'auto', className }: DonutChartProps) {
  const t = useChartTheme();
  const navigate = useNavigate();
  const shown = useMemo<Shown[]>(() => {
    const folded = foldSlices(slices.filter((s) => s.value > 0), maxSlices);
    const total = folded.reduce((n, s) => n + s.value, 0);
    return folded.map((s, i) => ({ ...s, href: s.other ? otherHref : s.href, hex: s.other ? t.deemphasis : optionHex(s.color, t.dark, t.series[Math.min(i, t.series.length - 1)]!), pct: total ? Math.round((s.value / total) * 100) : 0 }));
  }, [slices, maxSlices, otherHref, t]);
  const total = shown.reduce((n, s) => n + s.value, 0);
  if (!shown.length || total === 0) return <div className="text-[13px] text-subtle py-6 text-center">{emptyText}</div>;
  const bars = layout === 'bars' || (layout === 'auto' && slicesAreClose(shown.map((s) => s.value)));
  if (bars) {
    return (
      <div className={className}>
        <div className="text-[12px] text-subtle mb-2 tnum">{valueFormatter(total)} {centerLabel}</div>
        <BreakdownBar items={shown.map((s) => ({ label: s.label, value: s.value, hex: s.hex, href: s.href }))} />
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col sm:flex-row items-center gap-5', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }} data-testid="donut">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={shown}
              dataKey="value"
              nameKey="label"
              innerRadius="66%"
              outerRadius="100%"
              paddingAngle={shown.length > 1 ? 2 : 0}
              stroke={t.surface}
              strokeWidth={2}
              isAnimationActive={false}
              onClick={(_: unknown, index: number) => {
                const href = shown[index]?.href;
                if (href) navigate(href);
              }}
            >
              {shown.map((s) => (
                <Cell key={s.key} fill={s.hex} cursor={s.href ? 'pointer' : undefined} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip valueFormatter={valueFormatter} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[22px] leading-none font-semibold tracking-[-0.03em] tnum text-default">{valueFormatter(total)}</span>
          <span className="text-[11px] text-subtle mt-1 max-w-[70%] text-center truncate">{centerLabel}</span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 w-full flex flex-col gap-1 text-[12.5px]" aria-label="Legend">
        {shown.map((s) => {
          const row = (
            <>
              <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: s.hex }} aria-hidden />
              <span className={cn('truncate min-w-0 flex-1', s.other ? 'text-muted' : 'text-default')}>{s.label}</span>
              <span className="tnum text-default font-medium shrink-0">{valueFormatter(s.value)}</span>
              <span className="tnum text-subtle w-9 text-right shrink-0">{s.pct}%</span>
            </>
          );
          const cls = 'flex items-center gap-2 rounded-md px-1.5 -mx-1.5 py-0.5';
          return <li key={s.key}>{s.href ? <Link to={s.href} className={cn(cls, 'hover:bg-surface-2')}>{row}</Link> : <div className={cls}>{row}</div>}</li>;
        })}
      </ul>
    </div>
  );
}
