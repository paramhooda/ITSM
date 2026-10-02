import { useId } from 'react';
import { STATUS_COLORS, useChartTheme } from './chartTheme';
import { cn } from '@/lib/utils';

const LIGHTER: Record<string, string> = { [STATUS_COLORS.good]: '#4ade80', [STATUS_COLORS.warning]: '#fcd34d', [STATUS_COLORS.critical]: '#f87171' };

/** Compliance ring: a single hero number with met/breached beneath. */
export function SlaGauge({ pct, met, breached, label = 'SLA compliance', size = 128, target = 95, stroke = 11 }: { pct: number | null | undefined; met?: number; breached?: number; label?: string; size?: number; target?: number; stroke?: number }) {
  const t = useChartTheme();
  const id = useId().replace(/:/g, '');
  const r = (size - stroke - 2) / 2;
  const c = 2 * Math.PI * r;
  const v = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  const color = pct === null || pct === undefined ? t.axis : v >= target ? STATUS_COLORS.good : v >= target - 10 ? STATUS_COLORS.warning : STATUS_COLORS.critical;
  const light = LIGHTER[color] ?? color;
  return (
    <div className="flex items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${pct ?? 'n/a'}%`} className="shrink-0">
        <defs>
          <linearGradient id={`ring-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={light} />
            <stop offset="100%" stopColor={color} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.grid} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#ring-${id})`} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray 600ms cubic-bezier(0.2,0.8,0.2,1)' }} />
        <text x="50%" y="47%" dominantBaseline="middle" textAnchor="middle" fontSize={size / 4.4} fontWeight={600} letterSpacing="-0.03em" fill="currentColor">{pct === null || pct === undefined ? '—' : `${Math.round(v * 10) / 10}%`}</text>
        <text x="50%" y="66%" dominantBaseline="middle" textAnchor="middle" fontSize={10.5} fill={t.text}>target {target}%</text>
      </svg>
      <div className="text-[12.5px] min-w-0">
        <div className="font-medium text-default">{label}</div>
        {met !== undefined && (
          <div className="mt-1.5 flex flex-col gap-1 tnum">
            <span className="inline-flex items-center gap-1.5 text-secondary"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS.good }} />{met} met</span>
            <span className={cn('inline-flex items-center gap-1.5', (breached ?? 0) > 0 ? 'text-red-700' : 'text-secondary')}><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS.critical }} />{breached ?? 0} breached</span>
          </div>
        )}
      </div>
    </div>
  );
}
