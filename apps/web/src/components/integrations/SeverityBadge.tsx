import { Badge } from '@/components/ui';
import type { Severity } from './types';

export const SEVERITY_COLORS: Record<string, string> = { critical: 'red', high: 'orange', medium: 'amber', low: 'blue', info: 'slate' };
export const SEVERITY_LABELS: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

export function SeverityBadge({ severity, className }: { severity?: Severity | string | null; className?: string }) {
  if (!severity) return <span className="text-subtle">—</span>;
  return (
    <Badge color={SEVERITY_COLORS[severity] ?? 'slate'} dot className={className}>
      {SEVERITY_LABELS[severity] ?? severity}
    </Badge>
  );
}

const STATUS_COLORS: Record<string, string> = { open: 'red', resolved: 'green', acknowledged: 'purple', info: 'slate' };

export function EventStatusBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-subtle">—</span>;
  return <Badge color={STATUS_COLORS[status] ?? 'slate'}>{status}</Badge>;
}
