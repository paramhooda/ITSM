import { Badge } from '@/components/ui';
import type { Severity } from './types';
import { SEVERITY_COLORS, EVENT_STATUS_COLORS } from '@/lib/statusColors';

export { SEVERITY_COLORS };
export const SEVERITY_LABELS: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

export function SeverityBadge({ severity, className }: { severity?: Severity | string | null; className?: string }) {
  if (!severity) return <span className="text-subtle">—</span>;
  return (
    <Badge color={SEVERITY_COLORS[severity] ?? 'slate'} dot className={className}>
      {SEVERITY_LABELS[severity] ?? severity}
    </Badge>
  );
}

const STATUS_COLORS = EVENT_STATUS_COLORS;

export function EventStatusBadge({ status, className }: { status?: string | null; className?: string }) {
  if (!status) return <span className="text-subtle">—</span>;
  return <Badge color={STATUS_COLORS[status] ?? 'slate'} className={className}>{status}</Badge>;
}
