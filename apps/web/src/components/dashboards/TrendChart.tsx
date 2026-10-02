import { useMemo } from 'react';
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
}

const shortDay = (v: string) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v.slice(5) : String(v));

/** One-axis time series / categorical chart (recharts), theme aware, crosshair tooltip by default. */
export function TrendChart({ data, x, series, kind = 'line', height = 220, stacked, valueFormatter, xFormatter = shortDay, title }: TrendChartProps) {
  const t = useChartTheme();
  const colored = useMemo(() => series.map((s, i) => ({ ...s, color: s.color ?? t.series[i % t.series.length] })), [series, t]);
  if (!data.length) return <EmptyState title="No data" description="Nothing recorded for this period." />;
  const common = { data, margin: { top: 8, right: 8, left: -12, bottom: 0 } };
  const axisProps = { stroke: t.axis, tick: { fill: t.text, fontSize: 11 }, tickLine: false as const, axisLine: { stroke: t.grid } };
  const tooltip = (
    <Tooltip
      cursor={{ stroke: t.axis, strokeWidth: 1, fill: t.dark ? 'rgba(255,255,255,0.04)' : 'rgba(15,23,42,0.04)' }}
      contentStyle={{ background: t.tooltip.background, border: `1px solid ${t.tooltip.border}`, borderRadius: 8, color: t.tooltip.color, fontSize: 12, padding: '6px 10px' }}
      labelStyle={{ color: t.tooltip.color, fontWeight: 600, marginBottom: 2 }}
      itemStyle={{ color: t.tooltip.color, padding: 0 }}
      formatter={(v: unknown, name: unknown) => [valueFormatter ? valueFormatter(Number(v)) : String(v ?? '—'), String(name)]}
      labelFormatter={(l: unknown) => String(l)}
    />
  );
  const legend = colored.length > 1 ? <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: t.text, paddingTop: 6 }} /> : null;
  const grid = <CartesianGrid stroke={t.grid} vertical={false} />;
  const xAxis = <XAxis dataKey={x} {...axisProps} tickFormatter={xFormatter} interval="preserveStartEnd" minTickGap={24} />;
  const yAxis = <YAxis {...axisProps} allowDecimals={false} width={44} tickFormatter={(v: number) => (valueFormatter ? valueFormatter(v) : String(v))} />;
  return (
    <div>
      {title && <div className="text-[12.5px] font-medium text-muted mb-1">{title}</div>}
      <ResponsiveContainer width="100%" height={height}>
        {kind === 'bar' ? (
          <BarChart {...common} barCategoryGap="20%" barGap={2}>
            {grid}{xAxis}{yAxis}{tooltip}{legend}
            {colored.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} stackId={stacked ? 'a' : undefined} maxBarSize={28} isAnimationActive={false} />)}
          </BarChart>
        ) : kind === 'area' ? (
          <AreaChart {...common}>
            {grid}{xAxis}{yAxis}{tooltip}{legend}
            {colored.map((s) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} fill={s.color} fillOpacity={0.12} strokeWidth={2} stackId={stacked ? 'a' : undefined} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: t.surface }} isAnimationActive={false} />)}
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
