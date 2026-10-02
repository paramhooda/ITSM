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

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;

/** Plain-language label for the cron patterns the scheduler accepts; falls back to the expression. */
export function cronLabel(cron: string | null | undefined): string {
  if (!cron) return 'Manual only';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const everyN = (f: string) => (/^\*\/\d+$/.test(f) ? Number(f.slice(2)) : null);
  if (everyN(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${everyN(m)} minutes`;
  if (m === '0' && everyN(h) && dom === '*' && mon === '*' && dow === '*') return `Every ${everyN(h)} hours`;
  if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
    if (dom === '*' && mon === '*' && dow === '*') return `Daily at ${hhmm(h, m)} UTC`;
    if (dom === '*' && mon === '*' && /^\d$/.test(dow)) return `Weekly on ${DAYS[Number(dow)] ?? dow} at ${hhmm(h, m)} UTC`;
    if (dom === '*' && mon === '*' && dow === '1-5') return `Weekdays at ${hhmm(h, m)} UTC`;
    if (/^\d+$/.test(dom) && mon === '*' && dow === '*') return `Monthly on day ${dom} at ${hhmm(h, m)} UTC`;
  }
  return cron;
}
