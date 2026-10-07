import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { fmtDate, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SEVERITY_COLORS } from '@/lib/statusColors';
import { ticketListPath, type TicketListLink } from '@itsm/shared';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { HeatmapGrid } from './HeatmapGrid';
import { Panel, Segmented, Stat } from './Panel';
import { STATUS_COLORS } from './chartTheme';
import type { AgeBucket, Arrivals } from './overviewApi';

/**
 * The panels the Overview and the dedicated dashboards share: backlog ageing,
 * when tickets arrive, monitoring or SIEM events and a small rate table. Every
 * bar and cell is a door into the ticket list with the predicates its number
 * was counted with (`link` carries the dashboard's scope: customer, domain,
 * team); the local controls are owned by the caller so their state lives in
 * the URL under the dashboard's own key.
 */

// ---------------------------------------------------------------- backlog ageing

export type AgeingView = 'all' | 'breached';
export const AGEING_VIEWS: readonly AgeingView[] = ['all', 'breached'];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

/** The five-bucket backlog: within SLA and breached stacked per bucket, each segment opening the bucket's exact created window with its SLA state. */
export function AgeingPanel({ ageing, link, view = 'all', onView, title = 'Backlog ageing', className, footer }: { ageing: AgeBucket[]; link: TicketListLink; view?: AgeingView; onView?: (v: AgeingView) => void; title?: string; className?: string; footer?: ReactNode }) {
  const open = ageing.reduce((n, a) => n + a.count, 0);
  const breached = ageing.reduce((n, a) => n + a.breached, 0);
  const old = ageing.filter((a) => a.bucket === '7-30 days' || a.bucket === '> 30 days').reduce((n, a) => n + a.count, 0);
  const data = ageing.map((a) => ({ bucket: a.bucket, withinSla: a.count - a.breached, breached: a.breached, createdFrom: a.createdFrom, createdTo: a.createdTo }));
  const window = (p: Record<string, unknown>) => ({ createdFrom: (p.createdFrom as string | null) ?? null, createdTo: (p.createdTo as string | null) ?? null });
  const subtitle = open === 0 ? 'Nothing open' : `${fmtNumber(open)} open · ${fmtNumber(breached)} breached · ${fmtNumber(old)} older than a week`;
  return (
    <Panel title={title} subtitle={subtitle} to={ticketListPath(link)} toLabel="All open" className={className} action={onView ? <Segmented size="sm" options={[{ value: 'all', label: 'All open' }, { value: 'breached', label: 'Breached' }]} value={view} onChange={onView} /> : undefined}>
      <TrendChart
        data={open ? data : []}
        x="bucket"
        kind="bar"
        stacked
        height={190}
        xFormatter={(v) => v}
        xInterval={0}
        series={view === 'breached' ? [{ key: 'breached', label: 'Breached', color: STATUS_COLORS.critical }] : [{ key: 'withinSla', label: 'Within SLA' }, { key: 'breached', label: 'Breached', color: STATUS_COLORS.critical }]}
        pointHref={(p, key) => ticketListPath({ ...link, ...window(p), sla: key === 'breached' ? 'breached' : ['ok', 'at_risk'] })}
      />
      {footer}
    </Panel>
  );
}

// ---------------------------------------------------------------- when tickets arrive

export type HeatView = 'week' | 'pattern';
export const HEAT_VIEWS: readonly HeatView[] = ['week', 'pattern'];

/** Weekday-by-hour arrivals: the trailing week (one exact hour window per cell, each a door) or the whole period's pattern (no links). */
export function ArrivalsPanel({ arrivals, link, view = 'week', onView, title = 'When tickets arrive', className }: { arrivals: Arrivals; link: TicketListLink; view?: HeatView; onView?: (v: HeatView) => void; title?: string; className?: string }) {
  const week = view === 'week';
  const src = week ? arrivals.week : arrivals.pattern;
  const total = src.cells.reduce((n, c) => n + c.value, 0);
  const cells = week
    ? arrivals.week.cells.map((c) => ({ row: c.row, col: c.col, value: c.value, href: ticketListPath({ ...link, status: 'any', createdFrom: c.createdFrom, createdTo: c.createdTo }), title: `${fmtDate(c.day)} (${c.row}) ${c.col}:00 · ${fmtNumber(c.value)} ${c.value === 1 ? 'ticket' : 'tickets'}` }))
    : arrivals.pattern.cells.map((c) => ({ row: c.row, col: c.col, value: c.value }));
  const subtitle = week ? `${fmtNumber(total)} opened ${fmtDate(arrivals.week.from)} – ${fmtDate(arrivals.week.to)} · ${arrivals.timezone} · a cell opens that hour's tickets` : `${fmtNumber(total)} opened ${fmtDate(arrivals.pattern.from)} – ${fmtDate(arrivals.pattern.to)}, summed by weekday and hour · ${arrivals.timezone}`;
  // The drill-down window is the trailing seven days of the period, or the whole period when it is shorter.
  const weekDays = Math.round((Date.parse(`${arrivals.week.to}T00:00:00Z`) - Date.parse(`${arrivals.week.from}T00:00:00Z`)) / 86_400_000) + 1;
  return (
    <Panel title={title} subtitle={subtitle} className={className} action={onView ? <Segmented size="sm" options={[{ value: 'week', label: weekDays === 1 ? 'Today' : `Last ${weekDays} days` }, { value: 'pattern', label: 'Pattern' }]} value={view} onChange={onView} /> : undefined}>
      <HeatmapGrid cells={cells} rows={WEEKDAYS} cols={HOURS} unit="tickets" emptyText="No tickets arrived in this window" />
    </Panel>
  );
}

// ---------------------------------------------------------------- monitoring and SIEM events

export type EventsView = '24h' | '7d';
export const EVENTS_VIEWS: readonly EventsView[] = ['24h', '7d'];

export interface EventsBucket {
  total: number;
  ticketsCreated: number;
  bySeverity: { severity: string; count: number; ticketed: number }[];
}
export interface EventsWeek extends EventsBucket {
  byDay: { day: string; count: number; ticketed: number }[];
}

/** Events from a monitoring or SIEM source: the last 24 hours by severity, or the last 7 days per day; each number is an event count, not a ticket, so it opens the event feed. */
export function EventsPanel({ title, source, last24h, last7d, view = '24h', onView, className }: { title: string; source: string; last24h: EventsBucket; last7d: EventsWeek; view?: EventsView; onView?: (v: EventsView) => void; className?: string }) {
  const can = useAuthStore((s) => s.can);
  const feed = can('integrations:events') || can('integrations:manage') ? '/admin/integrations' : undefined;
  const d = view === '24h' ? last24h : last7d;
  const rate = d.total ? `${Math.round((d.ticketsCreated / d.total) * 100)}%` : '—';
  return (
    <Panel title={title} subtitle={`${source} events received in the last ${view === '24h' ? '24 hours' : '7 days'}, and how many became tickets`} to={feed} toLabel="Event feed" className={className} action={onView ? <Segmented size="sm" options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7 days' }]} value={view} onChange={onView} /> : undefined}>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Stat label="Events" value={fmtNumber(d.total)} />
        <Stat label="Became tickets" value={fmtNumber(d.ticketsCreated)} />
        <Stat label="Ticket rate" value={rate} />
      </div>
      {view === '7d' ? (
        <TrendChart data={last7d.byDay.some((x) => x.count) ? last7d.byDay : []} x="day" kind="bar" height={150} series={[{ key: 'count', label: 'Events' }, { key: 'ticketed', label: 'Became tickets' }]} />
      ) : (
        <BreakdownBar items={d.bySeverity.map((s) => ({ label: s.severity.charAt(0).toUpperCase() + s.severity.slice(1), value: s.count, secondary: s.ticketed, secondaryLabel: 'became tickets', color: SEVERITY_COLORS[s.severity] ?? 'slate' }))} emptyText={`No ${source} events in the last 24 hours`} dense />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- rate table

export interface RateCell {
  value: ReactNode;
  /** The list this figure opens (only a count of tickets is a door). */
  href?: string;
  tone?: 'default' | 'bad' | 'muted';
}
export interface RateRow {
  key: string;
  label: ReactNode;
  /** Option colour name for the label badge (a priority, a severity). */
  color?: string | null;
  cells: RateCell[];
}

/** A compact numbers table (responsiveness by priority or severity): the first column names the row, every other cell is right-aligned, and a cell with an `href` opens the list it was counted on. */
export function RateTable({ columns, rows, empty = 'Nothing in this period', minWidth = 460, className }: { columns: string[]; rows: RateRow[]; empty?: string; /** The table scrolls sideways below this width (a seven-column table needs 460 px; a four-column one less). */ minWidth?: number; className?: string }) {
  if (!rows.length) return <div className="text-[13px] text-subtle py-6 text-center">{empty}</div>;
  return (
    <div className={cn('overflow-x-auto -mx-5', className)}>
      <table className={cn('table [&_td]:py-1.5 [&_th]:py-1.5', minWidth === 0 && 'w-full [&_td]:px-2 [&_th]:px-2')} style={minWidth ? { minWidth } : undefined}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c} className={cn(i > 0 && 'text-right', i === 0 ? 'pl-5' : i === columns.length - 1 && 'pr-5')}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="pl-5 whitespace-nowrap">{r.color ? <Badge color={r.color} dot>{r.label}</Badge> : <span className="text-[12.5px] font-medium text-default">{r.label}</span>}</td>
              {r.cells.map((c, i) => {
                const cls = cn('tnum text-[12.5px]', c.tone === 'bad' ? 'text-red-600 font-medium' : c.tone === 'muted' ? 'text-subtle' : 'text-default');
                return (
                  <td key={i} className={cn('text-right whitespace-nowrap', i === r.cells.length - 1 && 'pr-5')}>
                    {c.href ? <Link to={c.href} className={cn(cls, 'hover:underline underline-offset-2')}>{c.value}</Link> : <span className={cls}>{c.value}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- daily flow drill-down

/** The list a bar of a daily flow chart opens: that day as the created range for an "opened" series, as the resolved range for "resolved"; nothing for a series without a list predicate (breaches). */
export function flowPointHref(link: TicketListLink, kinds: Record<string, 'created' | 'resolved' | null>) {
  return (point: Record<string, unknown>, seriesKey: string): string | undefined => {
    const day = typeof point.day === 'string' ? point.day : undefined;
    const kind = kinds[seriesKey];
    if (!day || !kind) return undefined;
    return kind === 'created' ? ticketListPath({ ...link, status: 'any', createdFrom: day, createdTo: day }) : ticketListPath({ ...link, status: 'any', resolvedFrom: day, resolvedTo: day });
  };
}
