import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { fmtDate } from '@/lib/format';
import type { Entitlement } from './types';
import { CONTRACT_STATUS_COLORS } from '@/lib/statusColors';

/** Status badge using the colour from the contract_status option list (falls back per status). */
export function ContractStatusBadge({ status, label, color }: { status: string; label?: string | null; color?: string | null }) {
  return (
    <Badge color={color ?? CONTRACT_STATUS_COLORS[status] ?? 'slate'} dot>
      {label ?? status}
    </Badge>
  );
}

/** "in 12 days" / "expired 3 days ago", coloured by urgency. */
export function ExpiryCountdown({ days, endDate, status, className }: { days: number; endDate?: string; status?: string; className?: string }) {
  if (status && ['terminated', 'renewed', 'draft'].includes(status)) return <span className={cn('text-subtle', className)}>{endDate ? fmtDate(endDate) : '—'}</span>;
  const tone = days < 0 ? 'text-red-600' : days <= 7 ? 'text-red-600' : days <= 30 ? 'text-amber-600' : days <= 90 ? 'text-amber-600/80' : 'text-muted';
  const text = days < 0 ? `expired ${Math.abs(days)}d ago` : days === 0 ? 'expires today' : `in ${days}d`;
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      {endDate && <span>{fmtDate(endDate)}</span>}
      <span className={cn('text-[11.5px] font-medium', tone)}>{text}</span>
    </span>
  );
}

export function ScopeBadge({ classification }: { classification: string }) {
  if (classification === 'out_of_scope') return <Badge color="red">Out of scope</Badge>;
  if (classification === 'in_scope') return <Badge color="green">In scope</Badge>;
  return <Badge color="slate">Unknown</Badge>;
}

export const PERIOD_LABELS: Record<string, string> = { contract: 'Contract term', yearly: 'Yearly', half_yearly: 'Half-yearly', quarterly: 'Quarterly', monthly: 'Monthly' };

export const entitlementTone = (e: Pick<Entitlement, 'utilization'>) => (e.utilization.exhausted ? 'bad' : e.utilization.overThreshold ? 'warn' : 'good');

export function DocTick({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[13px]', ok ? 'text-emerald-600' : 'text-red-600')}>
      <span className={cn('h-4 w-4 rounded-full flex items-center justify-center text-[10px] font-bold', ok ? 'bg-emerald-100' : 'bg-red-100')}>{ok ? '✓' : '✕'}</span>
      {label}
    </span>
  );
}

/** Small horizontal bar list (open tickets by priority etc.). */
export function MiniBars({ rows, max }: { rows: { label: string; count: number; color?: string | null }[]; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.count));
  const colors: Record<string, string> = { red: 'bg-red-500', orange: 'bg-orange-500', amber: 'bg-amber-500', yellow: 'bg-yellow-400', green: 'bg-emerald-500', blue: 'bg-blue-500', sky: 'bg-sky-500', slate: 'bg-slate-400', gray: 'bg-gray-400' };
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-[12.5px]">
          <span className="w-24 truncate text-muted">{r.label}</span>
          <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
            <div className={cn('h-full rounded-full', colors[r.color ?? ''] ?? 'bg-brand-500')} style={{ width: `${Math.round((r.count / top) * 100)}%` }} />
          </div>
          <span className="w-6 text-right tabular-nums">{r.count}</span>
        </div>
      ))}
      {rows.length === 0 && <div className="text-xs text-subtle">No open tickets</div>}
    </div>
  );
}
