import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui';
import { fmtDateTime, fmtDuration, relativeTime } from '@/lib/format';
import { RUN_COLORS, DIFF_COLORS, FINDING_STATUS_COLORS, runDuration, type DiscoveryRun } from './api';

export const RunStatusBadge = ({ status }: { status: string }) => <Badge color={RUN_COLORS[status] ?? 'slate'} dot>{status}</Badge>;
export const DiffBadge = ({ diff }: { diff: string }) => <Badge color={DIFF_COLORS[diff] ?? 'slate'}>{diff}</Badge>;
export const FindingStatusBadge = ({ status }: { status: string }) => <Badge color={FINDING_STATUS_COLORS[status] ?? 'slate'} dot>{status}</Badge>;

/** "508 scanned · 311 responsive · 3 new" from a run's stats. */
export function runSummary(r: DiscoveryRun) {
  const s = r.stats ?? {};
  const parts: string[] = [];
  if (s.hostsScanned !== undefined) parts.push(`${s.hostsScanned} scanned`);
  if (s.responsive !== undefined) parts.push(`${s.responsive} responsive`);
  const nw = r.findings?.new ?? s.newCis;
  const ch = r.findings?.changed ?? s.changed;
  if (nw !== undefined || ch !== undefined) parts.push(`${nw ?? 0} new · ${ch ?? 0} changed`);
  return parts.join(' · ') || '—';
}

export const runWhen = (r: DiscoveryRun) => (r.finishedAt ? `finished ${relativeTime(r.finishedAt)}` : r.startedAt ? `started ${relativeTime(r.startedAt)}` : `queued ${relativeTime(r.createdAt)}`);
export const runDurationText = (r: DiscoveryRun) => {
  const m = r.durationSec !== undefined && r.durationSec !== null ? Math.round(r.durationSec / 60) : runDuration(r);
  return m === null ? '—' : fmtDuration(m);
};
export const RunLink = ({ run }: { run: Pick<DiscoveryRun, 'id' | 'status' | 'startedAt' | 'createdAt'> }) => (
  <Link to={`/cmdb/discovery/runs/${run.id}`} className="font-mono text-xs text-brand-700 hover:underline" title={fmtDateTime(run.startedAt ?? run.createdAt)}>
    {run.id.slice(0, 8)}
  </Link>
);
