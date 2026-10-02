import { Badge } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { COVERAGE_COLORS, LIFECYCLE_COLORS } from '@/lib/statusColors';

export interface Coverage { status: 'none' | 'active' | 'expiring' | 'expired'; days: number | null; end: string | null }

const COLORS: Record<Coverage['status'], string> = COVERAGE_COLORS as Record<Coverage['status'], string>;

/** Warranty / AMC coverage badge: colour by status, with the end date and remaining days. */
export function CoverageBadge({ coverage, end, showDate = true }: { coverage?: Coverage | null; end?: string | null; showDate?: boolean }) {
  const c = coverage ?? computeCoverage(end);
  if (c.status === 'none') return <span className="text-subtle">—</span>;
  const label = c.status === 'expired' ? `Expired ${Math.abs(c.days ?? 0)}d ago` : c.status === 'expiring' ? `${c.days}d left` : 'Active';
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {showDate && <span className="text-[13px]">{fmtDate(c.end)}</span>}
      <Badge color={COLORS[c.status]} dot>{label}</Badge>
    </span>
  );
}

export function computeCoverage(end?: string | null, window = 90): Coverage {
  if (!end) return { status: 'none', days: null, end: null };
  const days = Math.round((new Date(end + 'T00:00:00').getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  return { status: days < 0 ? 'expired' : days <= window ? 'expiring' : 'active', days, end };
}

export { LIFECYCLE_COLORS };
export function LifecycleBadge({ stage }: { stage?: string | null }) {
  return <Badge color={LIFECYCLE_COLORS[stage ?? ''] ?? 'slate'}>{(stage ?? '—').replace(/_/g, ' ')}</Badge>;
}
