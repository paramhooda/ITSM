import { KNOWN_ERROR_STATUS_LABELS } from '@itsm/shared';
import { Badge } from '@/components/ui';
import { KNOWN_ERROR_STATUS_COLORS, statusColor } from '@/lib/statusColors';
import { PORTAL_KE_STATUS_LABELS } from './api';

/** The known-error lifecycle as a badge; `portal` switches to the customer-facing labels. */
export function KeStatusBadge({ status, portal, className }: { status: string | null | undefined; portal?: boolean; className?: string }) {
  if (!status) return null;
  const labels: Record<string, string> = portal ? PORTAL_KE_STATUS_LABELS : KNOWN_ERROR_STATUS_LABELS;
  return (
    <Badge color={statusColor(KNOWN_ERROR_STATUS_COLORS, status)} dot className={className}>
      {labels[status] ?? status}
    </Badge>
  );
}
