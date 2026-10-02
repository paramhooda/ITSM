import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { OptionLabel, TicketType } from './types';
import { TYPE_COLORS, TYPE_LABELS } from './types';
import { TICKET_CATEGORY_COLORS } from '@/lib/statusColors';


export function TicketStatusBadge({ status, className }: { status: OptionLabel | null | undefined; className?: string }) {
  if (!status) return <Badge color="slate" className={className}>—</Badge>;
  return (
    <Badge color={status.color ?? TICKET_CATEGORY_COLORS[status.category ?? ''] ?? 'slate'} className={className} dot>
      {status.label}
    </Badge>
  );
}

export function TypeBadge({ type, className, short }: { type: TicketType; className?: string; short?: boolean }) {
  const label = short ? { incident: 'INC', request: 'REQ', problem: 'PRB', change: 'CHG' }[type] : TYPE_LABELS[type];
  return (
    <Badge color={TYPE_COLORS[type]} className={cn('uppercase tracking-wide', className)}>
      {label}
    </Badge>
  );
}
