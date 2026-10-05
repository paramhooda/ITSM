import { Badge, ProgressBar } from '@/components/ui';
import { fmtDate, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { COMPLIANCE_COLORS, LICENCE_STATUS_COLORS, INSTALL_SOURCE_COLORS } from '@/lib/statusColors';
import { POSITION_LABELS, STATUS_LABELS, SOURCE_LABELS, LICENCE_METRIC_LABELS, SEAT_UNITS, daysLeftText, daysLeftClass } from './api';

/** Compliance position of a title at one customer. */
export function PositionBadge({ position }: { position?: string | null }) {
  if (!position) return <span className="text-subtle">—</span>;
  return <Badge color={COMPLIANCE_COLORS[position] ?? 'slate'} dot>{POSITION_LABELS[position] ?? position}</Badge>;
}

/** Live state of a licence term (computed by the API from the dates). */
export function LicenceStatusBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-subtle">—</span>;
  return <Badge color={LICENCE_STATUS_COLORS[status] ?? 'slate'} dot>{STATUS_LABELS[status] ?? status}</Badge>;
}

/** How an installation was recorded. */
export function SourceBadge({ source }: { source?: string | null }) {
  if (!source) return <span className="text-subtle">—</span>;
  return <Badge color={INSTALL_SOURCE_COLORS[source] ?? 'slate'}>{SOURCE_LABELS[source] ?? source}</Badge>;
}

export const metricLabel = (metric?: string | null) => (metric ? LICENCE_METRIC_LABELS[metric] ?? metric : '—');
export const seats = (n: number | null | undefined, metric?: string | null) => (n === null || n === undefined ? 'Unlimited' : `${fmtNumber(n)} ${SEAT_UNITS[metric ?? ''] ?? 'seats'}`);

const positionTone = (position?: string | null): 'good' | 'warn' | 'bad' | 'neutral' => (position === 'over_deployed' || position === 'unlicensed' ? 'bad' : position === 'under_deployed' ? 'warn' : position === 'unlimited' ? 'neutral' : 'good');

/** Installed against entitled as a bar with the percentage; a site licence shows the installed count only. */
export function UtilisationCell({ installed, entitled, pct, position, className }: { installed: number; entitled: number | null; pct: number | null; position?: string | null; className?: string }) {
  if (entitled === null) return <span className={cn('text-muted text-[12.5px]', className)}>{fmtNumber(installed)} installed · site licence</span>;
  return (
    <div className={cn('min-w-[120px]', className)}>
      <div className="flex items-center justify-between text-[11.5px] text-muted mb-1">
        <span className="tnum">{fmtNumber(installed)} / {fmtNumber(entitled)}</span>
        <span className={cn('tnum font-medium', position === 'over_deployed' || position === 'unlicensed' ? 'text-red-600' : position === 'under_deployed' ? 'text-amber-600' : 'text-default')}>{pct === null ? '—' : `${pct}%`}</span>
      </div>
      <ProgressBar pct={Math.min(100, pct ?? 0)} tone={positionTone(position)} />
    </div>
  );
}

/** The term of a licence: start → end with the countdown, or "perpetual" when there is no end date. */
export function TermCell({ startDate, endDate, daysLeft, status }: { startDate: string | null; endDate: string | null; daysLeft: number | null; status?: string | null }) {
  if (!endDate) return <span className="text-muted">{startDate ? `${fmtDate(startDate)} → ` : ''}<span className="text-subtle">no end date</span></span>;
  const renewed = status === 'renewed';
  return (
    <div className="leading-tight whitespace-nowrap">
      <div>{startDate ? `${fmtDate(startDate)} → ` : ''}{fmtDate(endDate)}</div>
      <div className={cn('text-[11.5px]', renewed ? 'text-subtle' : daysLeftClass(daysLeft))}>{renewed ? 'renewed' : daysLeftText(daysLeft, endDate)}</div>
    </div>
  );
}
