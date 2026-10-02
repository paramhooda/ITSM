import { PauseCircle, CheckCircle2, AlertTriangle, XCircle, Clock } from 'lucide-react';
import { ProgressBar } from '@/components/ui';
import { cn } from '@/lib/utils';
import { Panel } from './Panel';
import { fmtDateTime, fmtDuration, relativeTime } from '@/lib/format';
import type { SlaMetricSummary } from './types';
import { slaTone } from './SlaIndicator';

function MetricRow({ m }: { m: SlaMetricSummary }) {
  const tone = m.state === 'met' ? 'good' : m.state === 'cancelled' ? 'neutral' : slaTone(m);
  const pct = Math.min(100, Math.max(0, m.pctConsumed));
  const open = (m.state === 'running' || m.state === 'paused' || m.state === 'breached') && !m.completedAt;
  let statusText: React.ReactNode;
  if (m.state === 'met') statusText = <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Met in {fmtDuration(m.elapsedMinutes)}</span>;
  else if (m.state === 'cancelled') statusText = <span className="text-subtle inline-flex items-center gap-1"><XCircle className="h-3.5 w-3.5" /> Cancelled</span>;
  else if (m.breached) statusText = <span className="text-red-600 dark:text-red-400 inline-flex items-center gap-1 font-medium"><AlertTriangle className="h-3.5 w-3.5" /> Breached{m.completedAt ? ` (${fmtDuration(m.elapsedMinutes)})` : m.remainingMinutes < 0 ? ` · ${fmtDuration(-m.remainingMinutes)} over` : ''}</span>;
  else if (m.state === 'paused') statusText = <span className="text-muted inline-flex items-center gap-1"><PauseCircle className="h-3.5 w-3.5" /> Paused · {fmtDuration(m.remainingMinutes)} left</span>;
  else statusText = <span className={cn('inline-flex items-center gap-1', tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}><Clock className="h-3.5 w-3.5" /> {fmtDuration(m.remainingMinutes)} left</span>;
  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between text-[12.5px]">
        <span className="font-medium">{m.label}</span>
        <span className="text-subtle tabular-nums">{fmtDuration(m.elapsedMinutes)} / {fmtDuration(m.targetMinutes)}</span>
      </div>
      <ProgressBar pct={pct} tone={m.state === 'met' ? 'good' : m.state === 'cancelled' ? 'neutral' : tone === 'neutral' ? 'neutral' : tone} className="my-1" />
      <div className="flex items-center justify-between text-[11.5px]">
        <span>{statusText}</span>
        <span className="text-subtle" title={fmtDateTime(m.dueAt)}>
          {open ? `due ${relativeTime(m.dueAt)}` : m.completedAt ? fmtDateTime(m.completedAt) : ''}
        </span>
      </div>
      {m.pausedMinutes > 0 && <div className="text-[11px] text-subtle mt-0.5">{fmtDuration(m.pausedMinutes)} paused{m.calendarTime ? '' : ' · business hours'}</div>}
      {m.pausedMinutes === 0 && !m.calendarTime && <div className="text-[11px] text-subtle mt-0.5">business hours</div>}
    </div>
  );
}

/** Right-panel SLA card: one progress row per metric. */
export function SlaCard({ slas, policyName, className }: { slas: SlaMetricSummary[]; policyName?: string | null; className?: string }) {
  return (
    <Panel title="SLA" actions={policyName ? <span className="text-[11.5px] text-subtle truncate max-w-[160px]" title={policyName}>{policyName}</span> : undefined} className={className}>
      {slas.length === 0 ? (
        <div className="text-[12.5px] text-muted">No SLA targets apply.</div>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {slas.map((m) => (
            <MetricRow key={m.id} m={m} />
          ))}
        </div>
      )}
    </Panel>
  );
}
