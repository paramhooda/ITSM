import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, ArrowUpRight as ArrowOut, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Delta } from './types';

export type Tone = 'default' | 'good' | 'warn' | 'bad' | 'accent';

export interface KpiItem {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  /** Period-over-period change; `lowerIsBetter` flips the colouring. */
  delta?: Delta | null;
  lowerIsBetter?: boolean;
  /** Small trend behind the number (oldest → newest). */
  spark?: (number | null)[];
  sparkLabel?: string;
  icon?: ReactNode;
  /** Quick filter on the page's own list: toggles a condition in place (pair with `active`); the page never scrolls. */
  onClick?: () => void;
  /** Link tile: opens the list that holds the matching records (overview pages and dashboards). */
  to?: string;
  /** The tile's condition is in effect: ring and brand border, so the band and the breadcrumb agree. */
  active?: boolean;
}

const TONE_TEXT: Record<Tone, string> = { default: 'text-default', good: 'text-emerald-600', warn: 'text-amber-600', bad: 'text-red-600', accent: 'text-brand-600' };
const TONE_HEX: Record<Tone, string> = { default: '#2563eb', good: '#16a34a', warn: '#f59e0b', bad: '#dc2626', accent: '#2563eb' };
/** Tinted square behind a tile icon: the one touch of colour on neutral tiles. */
const TONE_CHIP: Record<Tone, string> = { default: 'bg-brand-50 text-brand-600', good: 'bg-emerald-50 text-emerald-600', warn: 'bg-amber-50 text-amber-600', bad: 'bg-red-50 text-red-600', accent: 'bg-violet-50 text-violet-600' };

export function DeltaBadge({ delta, lowerIsBetter, compact }: { delta?: Delta | null; lowerIsBetter?: boolean; compact?: boolean }) {
  if (!delta || delta.deltaPct === null) return <span className="text-subtle inline-flex items-center gap-1 text-[12px]"><Minus className="h-3 w-3" />{!compact && 'no prior data'}</span>;
  const up = delta.deltaPct > 0;
  const flat = delta.deltaPct === 0;
  const good = lowerIsBetter ? !up : up;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-0.5 rounded-md px-1.5 py-px text-[11.5px] font-medium tnum border border-current/10', flat ? 'bg-zinc-100 text-zinc-600' : good ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')} title={`Previous period: ${delta.previous ?? '—'}`}>
      <Icon className="h-3 w-3" />
      {Math.abs(delta.deltaPct)}%
    </span>
  );
}

/** Tiny area sparkline: 1.5px stroke, soft gradient fill, end marker. */
export function Sparkline({ data, color = '#2563eb', width = 96, height = 36, className, ariaLabel }: { data: (number | null)[]; color?: string; width?: number; height?: number; className?: string; ariaLabel?: string }) {
  const id = useId().replace(/:/g, '');
  const pts = data.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null && Number.isFinite(p[1]));
  if (pts.length < 2) return <div className={cn('shrink-0', className)} style={{ width, height }} aria-hidden />;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 3;
  const sx = (x: number) => pad + ((x - minX) / Math.max(1, maxX - minX)) * (width - pad * 2);
  const sy = (y: number) => (maxY === minY ? height / 2 : pad + (1 - (y - minY) / (maxY - minY)) * (height - pad * 2));
  const coords = pts.map(([x, y]) => [sx(x), sy(y)] as const);
  // Smooth cubic path through the points (Catmull–Rom → Bézier).
  let d = `M${coords[0]![0].toFixed(1)},${coords[0]![1].toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i - 1] ?? coords[i]!, p1 = coords[i]!, p2 = coords[i + 1]!, p3 = coords[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const last = coords[coords.length - 1]!;
  const area = `${d} L${last[0].toFixed(1)},${height} L${coords[0]![0].toFixed(1)},${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn('shrink-0 overflow-visible', className)} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel} aria-hidden={!ariaLabel}>
      <defs>
        <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sp-${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.6} fill={color} stroke="#fff" strokeWidth={1.5} />
    </svg>
  );
}

export function KpiTile({ label, value, hint, tone = 'default', delta, lowerIsBetter, spark, sparkLabel, icon, onClick, to, active, className }: KpiItem & { className?: string }) {
  const isLink = !!to;
  const clickable = isLink || !!onClick;
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-muted font-medium truncate">{label}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          {isLink && <ArrowOut className="h-3.5 w-3.5 text-subtle opacity-0 -translate-x-0.5 translate-y-0.5 transition-all group-hover:opacity-100 group-hover:translate-x-0 group-hover:translate-y-0" aria-hidden />}
          {icon && <span className={cn('inline-flex h-7 w-7 items-center justify-center rounded-lg border border-current/10', TONE_CHIP[tone])}>{icon}</span>}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        {/* The number never truncates; on a narrow tile the sparkline shrinks first (the SVG scales with its viewBox). */}
        <div className={cn('text-[30px] leading-none font-semibold tracking-[-0.03em] tnum shrink-0 whitespace-nowrap', TONE_TEXT[tone])}>{value}</div>
        {spark && spark.length > 1 && (
          <span className="flex-1 min-w-[40px] max-w-[96px] [&>svg]:w-full [&>svg]:h-auto">
            <Sparkline data={spark} color={TONE_HEX[tone]} ariaLabel={sparkLabel} />
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[12px] text-subtle min-h-[18px] -mt-1">
        {delta !== undefined && <DeltaBadge delta={delta} lowerIsBetter={lowerIsBetter} compact />}
        {hint && <span className="truncate">{hint}</span>}
      </div>
    </>
  );
  const cls = cn(
    'card p-5 flex flex-col gap-3 min-w-0 relative text-left',
    clickable && 'group cursor-pointer hover:border-strong hover:shadow-raised transition-[box-shadow,border-color]',
    active && 'border-brand-400 ring-2 ring-brand-500/25 hover:border-brand-500',
    className,
  );
  if (isLink) return <Link to={to!} className={cls} title={typeof hint === 'string' ? hint : undefined}>{body}</Link>;
  if (clickable) return <button type="button" className={cls} onClick={onClick} aria-pressed={active} data-active={active || undefined}>{body}</button>;
  return <div className={cls}>{body}</div>;
}

/** Hero row of at most four KPIs; the number is the chart, the sparkline is the context. */
export function KpiGrid({ items, columns = 4 }: { items: KpiItem[]; columns?: 2 | 3 | 4 | 5 }) {
  const cols = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4', 5: 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5' }[columns];
  return (
    <div className={cn('grid grid-cols-1 gap-4', cols)}>
      {items.map((k, i) => (
        <KpiTile key={i} {...k} className={cn('rise-in', `rise-in-${Math.min(4, i + 1)}`)} />
      ))}
    </div>
  );
}
