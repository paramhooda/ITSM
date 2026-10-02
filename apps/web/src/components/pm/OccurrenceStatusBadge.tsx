import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { PM_STATUS_COLORS, PM_STATUS_LABELS, FREQUENCY_LABELS, type PmStatus, type PmFrequency } from './types';

export function OccurrenceStatusBadge({ status, overdue, className }: { status: PmStatus | string; overdue?: boolean; className?: string }) {
  const s = status as PmStatus;
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Badge color={PM_STATUS_COLORS[s] ?? 'slate'} dot>
        {PM_STATUS_LABELS[s] ?? status}
      </Badge>
      {overdue && <Badge color="red">Overdue</Badge>}
    </span>
  );
}

export function FrequencyBadge({ frequency, intervalDays }: { frequency: PmFrequency | string; intervalDays?: number | null }) {
  const f = frequency as PmFrequency;
  return <Badge color="slate">{f === 'custom' && intervalDays ? `Every ${intervalDays} days` : (FREQUENCY_LABELS[f] ?? frequency)}</Badge>;
}

/** "in 12 days" / "3 days overdue" / "today" coloured by urgency. */
export function DueIn({ days, status }: { days: number; status: PmStatus | string }) {
  if (status === 'completed' || status === 'cancelled' || status === 'missed') return <span className="text-subtle">—</span>;
  const tone = days < 0 ? 'text-red-600' : days <= 7 ? 'text-amber-600' : 'text-muted';
  const text = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'today' : `in ${days}d`;
  return <span className={cn('text-[12px] font-medium whitespace-nowrap', tone)}>{text}</span>;
}
