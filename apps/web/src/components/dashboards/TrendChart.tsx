import { useId, useMemo } from 'react';
import { ResponsiveContainer, LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useChartTheme } from './chartTheme';
import { EmptyState } from '@/components/ui';

export interface Series {
  key: string;
  label: string;
  /** Explicit colour (e.g. a status colour); defaults to the categorical slot by index. */
  color?: string;
}

export interface TrendChartProps {
  data: Record<string, unknown>[];
  x: string;
  series: Series[];
  kind?: 'line' | 'area' | 'bar';
  height?: number;
  stacked?: boolean;
  valueFormatter?: (v: number) => string;
  xFormatter?: (v: string) => string;
  /** Hide the legend for a single series (the title names it). */
  title?: string;
  /** Fixed value scale (a 1-5 rating, a percentage) instead of the automatic one; `yTicks` pins the tick values. */
  yDomain?: [number, number];
  yTicks?: number[];
  /** Axis tick labels when they must be shorter than the tooltip's `valueFormatter` (the axis is 44 px wide). */
  yFormatter?: (v: number) => string;
}

const shortDay = (v: string) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v.slice(5) : String(v));
const longDay = (v: string) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : String(v));

interface TipPayload { name?: string; value?: number | string; color?: string; dataKey?: string }

function ChartTooltip({ active, payload, label, valueFormatter }: { active?: boolean; payload?: TipPayload[]; label?: string | number; valueFormatter?: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-default bg-white shadow-raised px-3 py-2 text-[12px] min-w-[150px]">
      <div className="font-medium text-default mb-1.5">{longDay(String(label ?? ''))}</div>
      <div className="flex flex-col gap-1">
        {payload.map((p) => (
          <div key={String(p.dataKey)} className="flex items-center justify-between gap-4">
            <span className="inline-flex items-center gap-1.5 text-muted"><span className="h-2 w-2 rounded-full" style={{ background: p.color }} />{p.name}</span>
            <span className="font-medium text-default tnum">{valueFormatter ? valueFormatter(Number(p.value)) : String(p.value ?? '—')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One-axis time series / categorical chart (recharts): gradient areas, crosshair tooltip, quiet grid. */
export function TrendChart({ data, x, series, kind = 'area', height = 220, stacked, valueFormatter, xFormatter = shortDay, title, yDomain, yTicks, yFormatter }: TrendChartProps) {
  const t = useChartTheme();
  const uid = useId().replace(/:/g, '');
  const colored = useMemo(() => series.map((s, i) => ({ ...s, color: s.color ?? t.series[i % t.series.length] })), [series, t]);
  if (!data.length) return <EmptyState title="No data" description="Nothing recorded for this period." />;
  const common = { data, margin: { top: 10, right: 8, left: -14, bottom: 0 } };
  const axisProps = { stroke: t.axis, tick: { fill: t.text, fontSize: 11 }, tickLine: false as const, axisLine: false as const };
  const tooltip = <Tooltip cursor={{ stroke: t.axis, strokeWidth: 1, strokeDasharray: '3 3', fill: 'rgba(9,9,11,0.03)' }} content={<ChartTooltip valueFormatter={valueFormatter} />} />;
  const legend = colored.length > 1 ? <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 12, color: t.text, paddingTop: 10 }} /> : null;
  const grid = <CartesianGrid stroke={t.grid} vertical={false} />;
  const xAxis = <XAxis dataKey={x} {...axisProps} tickFormatter={xFormatter} interval="preserveStartEnd" minTickGap={28} dy={6} />;
  const yAxis = <YAxis {...axisProps} allowDecimals={false} width={44} domain={yDomain} ticks={yTicks} tickFormatter={(v: number) => (yFormatter ? yFormatter(v) : valueFormatter ? valueFormatter(v) : String(v))} />;
  return (
    <div>
      {title && <div className="text-[12.5px] font-medium text-muted mb-1">{title}</div>}
      <ResponsiveContainer width="100%" height={height}>
        {kind === 'bar' ? (
          <BarChart {...common} barCategoryGap="24%" barGap={3}>
            {grid}{xAxis}{yAxis}{tooltip}{legend}
            {colored.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} stackId={stacked ? 'a' : undefined} maxBarSize={26} isAnimationActive={false} />)}
          </BarChart>
        ) : kind === 'area' ? (
          <AreaChart {...common}>
            <defs>
              {colored.map((s) => (
                <linearGradient key={s.key} id={`g-${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.24} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            {grid}{xAxis}{yAxis}{tooltip}{legend}
            {colored.map((s) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} fill={`url(#g-${uid}-${s.key})`} strokeWidth={2} stackId={stacked ? 'a' : undefined} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: t.surface }} isAnimationActive={false} />)}
          </AreaChart>
        ) : (
          <LineChart {...common}>
            {grid}{xAxis}{yAxis}{tooltip}{legend}
            {colored.map((s) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={data.length <= 31 ? { r: 2.5, strokeWidth: 0, fill: s.color } : false} activeDot={{ r: 4, strokeWidth: 2, stroke: t.surface }} isAnimationActive={false} />)}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
