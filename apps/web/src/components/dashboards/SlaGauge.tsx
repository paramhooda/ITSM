import { STATUS_COLORS, useChartTheme } from './chartTheme';
import { cn } from '@/lib/utils';

/** Compliance ring: a single hero number with met/breached beneath. */
export function SlaGauge({ pct, met, breached, label = 'SLA compliance', size = 112, target = 95 }: { pct: number | null | undefined; met?: number; breached?: number; label?: string; size?: number; target?: number }) {
  const t = useChartTheme();
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const v = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  const color = pct === null || pct === undefined ? t.axis : v >= target ? STATUS_COLORS.good : v >= target - 10 ? STATUS_COLORS.warning : STATUS_COLORS.critical;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${pct ?? 'n/a'}%`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.grid} strokeWidth={8} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={8} strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle" fontSize={size / 4.5} fontWeight={600} fill="currentColor">{pct === null || pct === undefined ? '—' : `${Math.round(v * 10) / 10}%`}</text>
      </svg>
      <div className="text-[12.5px]">
        <div className="font-medium">{label}</div>
        <div className="text-muted mt-1">Target {target}%</div>
        {met !== undefined && <div className={cn('mt-1 tabular-nums')}><span className="text-emerald-600 dark:text-emerald-400">{met} met</span> · <span className="text-red-600 dark:text-red-400">{breached ?? 0} breached</span></div>}
      </div>
    </div>
  );
}
