import { PauseCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtDuration, fmtDateTime } from '@/lib/format';
import type { SlaCompact } from './types';

export function slaTone(s: { breached: boolean; pctConsumed: number; state: string } | null | undefined): 'bad' | 'warn' | 'good' | 'neutral' {
  if (!s) return 'neutral';
  if (s.breached || s.state === 'breached') return 'bad';
  if (s.pctConsumed >= 75) return 'warn';
  return 'good';
}

const TONE_TEXT = { bad: 'text-red-600', warn: 'text-amber-600', good: 'text-emerald-600', neutral: 'text-subtle' };

/** Compact SLA cell for lists: remaining time coloured by consumption, "Breached", paused or "—". */
export function SlaIndicator({ sla, className }: { sla: SlaCompact | null | undefined; className?: string }) {
  if (!sla) return <span className={cn('text-subtle text-xs', className)}>—</span>;
  const tone = slaTone(sla);
  const metric = sla.metric.charAt(0).toUpperCase() + sla.metric.slice(1);
  if (sla.state === 'met') {
    return (
      <span className={cn('inline-flex items-center gap-1 text-xs', TONE_TEXT.good, className)} title={`${metric} met`}>
        <CheckCircle2 className="h-3.5 w-3.5" /> Met
      </span>
    );
  }
  if (sla.state === 'cancelled') return <span className={cn('text-subtle text-xs', className)}>—</span>;
  if (sla.breached || sla.state === 'breached') {
    return (
      <span className={cn('inline-flex items-center gap-1 text-xs font-medium', TONE_TEXT.bad, className)} title={`${metric} breached · due ${fmtDateTime(sla.dueAt)}`}>
        <AlertTriangle className="h-3.5 w-3.5" /> Breached {sla.remainingMinutes < 0 ? `(${fmtDuration(-sla.remainingMinutes)} over)` : ''}
      </span>
    );
  }
  if (sla.paused) {
    return (
      <span className={cn('inline-flex items-center gap-1 text-xs text-muted', className)} title={`${metric} paused · ${fmtDuration(sla.remainingMinutes)} left`}>
        <PauseCircle className="h-3.5 w-3.5" /> Paused
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium tabular-nums', TONE_TEXT[tone], className)} title={`${metric} · ${Math.round(sla.pctConsumed)}% consumed · due ${fmtDateTime(sla.dueAt)}`}>
      <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'bad' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-emerald-500')} />
      {fmtDuration(sla.remainingMinutes)}
    </span>
  );
}
