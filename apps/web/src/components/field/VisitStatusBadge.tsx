import { Badge } from '@/components/ui';
import { STATUS_COLORS, STATUS_LABELS, type VisitStatus } from './types';

export function VisitStatusBadge({ status, className }: { status: VisitStatus | string; className?: string }) {
  const s = status as VisitStatus;
  return (
    <Badge color={STATUS_COLORS[s] ?? 'slate'} className={className} dot>
      {STATUS_LABELS[s] ?? status}
    </Badge>
  );
}

/** Small star rating display (customer acknowledgement). */
export function Rating({ value }: { value: number | null | undefined }) {
  if (!value) return <span className="text-subtle">—</span>;
  return (
    <span className="text-amber-500 tracking-tight" aria-label={`${value} of 5`}>
      {'★'.repeat(value)}
      <span className="text-subtle">{'★'.repeat(5 - value)}</span>
    </span>
  );
}
