import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ErrorBlock, Badge } from '@/components/ui';
import { Wrench, UserX, Timer, CalendarCheck } from 'lucide-react';
import { get } from '@/api/client';
import { fmtDate, fmtDateTime, fmtNumber } from '@/lib/format';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { DonutChart } from './DonutChart';
import { SlaGauge } from './SlaGauge';
import { TicketMiniTable } from './TicketMiniTable';
import { EntitlementAlerts, type EntitlementAlert } from './EntitlementAlerts';
import { Panel, KpiSkeleton, Skeleton, Segmented, Stat, RowList } from './Panel';
import { STATUS_COLORS } from './chartTheme';
import { useLocalControl } from './localControls';
import { useLookups } from '@/hooks/useLookups';
import { AgeingPanel, RateTable } from './DeskPanels';
import type { TicketRow } from './types';
import type { AgeBucket, AmcStrip } from './overviewApi';
import { VISIT_STATUS_COLORS, PM_STATUS_COLORS } from '@/lib/statusColors';
import { fmtRating, ratingTone } from '@/components/surveys/api';
import { ticketListPath, type TicketListLink } from '@itsm/shared';

/** `GET /dashboards/amc` (mirrors apps/api/src/modules/dashboards/service.ts amc()). */
export interface Amc {
  generatedAt: string;
  customerId: string | null;
  /** The tile numbers (the Overview's AMC strip reads exactly these). */
  kpis: AmcStrip;
  /** Open AMC tickets by customer and by site (ids so each row drills down; a site row links with its customer and `siteId`). */
  byCustomer: { id: string; name: string; code: string; open: number; breached: number; atRisk: number; dueToday: number }[];
  bySite: { id: string | null; name: string; customerId: string; customerName: string; open: number; breached: number; atRisk: number }[];
  visitsByEngineer: { id: string; name: string; scheduled: number; inProgress: number; completedInPeriod: number }[];
  ageing: AgeBucket[];
  queue: { items: TicketRow[]; counts: { all: number; unassigned: number; dueToday: number; breached: number; awaitingCustomer: number } };
  visits: { id: string; number: string; title: string; status: string; scheduled_start: string | null; customer_name: string | null; site_name: string | null; engineer: string | null; ticket_number: string | null; ticket_id: string | null }[];
  maintenance: { id: string; program_id: string; program: string; customer_name: string | null; site: string | null; due_date: string; status: string; overdue: boolean; engineer: string | null }[];
  entitlements: EntitlementAlert[];
  period: { days: number; from: string; to: string };
  /** Site visits and PM occurrences completed per day over the period. */
  series: { day: string; visitsCompleted: number; pmCompleted: number }[];
  /** The window the two status donuts count over (the last 30 and the next 30 days); a slice links with it. */
  window: { from: string; to: string };
  /** Fixed lifecycle order from the API; zero rows are dropped before rendering. */
  visitsByStatus: { status: string; count: number }[];
  pmByStatus: { status: string; count: number }[];
  sla30d: { met: number; breached: number; compliancePct: number | null };
  /** Customer satisfaction on AMC tickets rated in the period. */
  csat30d?: { avg: number | null; responses: number; satisfiedPct: number | null };
}

type QueueView = 'all' | 'unassigned' | 'dueToday' | 'breached' | 'awaitingCustomer';
type WorkView = 'both' | 'visits' | 'pm';
type LoadBy = 'customer' | 'site';
const QUEUE_VIEWS: readonly QueueView[] = ['all', 'unassigned', 'dueToday', 'breached', 'awaitingCustomer'];
const WORK_VIEWS: readonly WorkView[] = ['both', 'visits', 'pm'];
const LOAD_BY: readonly LoadBy[] = ['customer', 'site'];

const statusLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
/** Status slices keep their lifecycle order and their own status colour (never the slice position); each opens the module's list filtered to that status over the donut's window. */
const statusSlices = (rows: { status: string; count: number }[], colors: Record<string, string>, href: (status: string) => string) =>
  rows.filter((r) => r.count > 0).map((r) => ({ key: r.status, label: statusLabel(r.status), value: r.count, color: colors[r.status] ?? 'slate', href: href(r.status) }));
/** A module list path (`/field/visits`, `/maintenance`) with the keys those pages read; empty values are left out. */
const modulePath = (base: string, params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const q = p.toString();
  return q ? `${base}?${q}` : base;
};

/** The AMC payload for the scope; the page (Updated stamp) and the dashboard share one query. */
export function useAmcDashboard({ days, customerId }: { days: number; customerId: string }) {
  return useQuery({ queryKey: ['dashboards', 'amc', days, customerId], queryFn: () => get<Amc>('/dashboards/amc', { days, customerId: customerId || undefined }), refetchInterval: 120_000, placeholderData: (p) => p });
}

/**
 * AMC and field service: the AMC ticket queue first, then visits and
 * maintenance. Tiles and rows are doors into the ticket list (customer scope,
 * the AMC domain, open status, the site); the queue segment, the completed-work
 * view and the load-by control live in the URL (`queue=`, `work=`, `by=`) and
 * change their panel alone.
 */
export function AmcDashboard({ days = 30, customerId = '' }: { days?: number; customerId?: string }) {
  const q = useAmcDashboard({ days, customerId });
  const [filter, setFilter] = useLocalControl<QueueView>('queue', 'all', QUEUE_VIEWS);
  const [workView, setWorkView] = useLocalControl<WorkView>('work', 'both', WORK_VIEWS);
  const [loadBy, setLoadBy] = useLocalControl<LoadBy>('by', 'customer', LOAD_BY);
  const { options } = useLookups();
  const d = q.data;
  const rows = useMemo(() => {
    const items = d?.queue.items ?? [];
    switch (filter) {
      case 'unassigned':
        return items.filter((t) => !t.assignee_id);
      case 'dueToday':
        return items.filter((t) => t.due_today);
      case 'breached':
        return items.filter((t) => t.sla?.breached);
      case 'awaitingCustomer':
        return items.filter((t) => t.status_key === 'pending_customer');
      default:
        return items;
    }
  }, [d, filter]);
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d)
    return (
      <div className="flex flex-col gap-6">
        <KpiSkeleton />
        <div className="card p-5">
          <Skeleton rows={6} />
        </div>
      </div>
    );
  const k = d.kpis;
  const c = d.queue.counts;
  // Tiles are doors: each opens the list its number was counted on (the scope, the AMC domain, open status).
  const open: TicketListLink = { customerId: customerId || null, domain: 'amc', status: 'open' };
  const work = d.series.some((s) => s.visitsCompleted || s.pmCompleted) ? d.series : [];
  // The queue's "View all" follows the segment where the list has the predicate: unassigned, breached and awaiting customer (the pending-customer status); "due today" has none, so it opens all open.
  const pendingCustomer = options('ticket_status').find((o) => o.key === 'pending_customer')?.id;
  const queueLink = filter === 'unassigned' ? { ...open, assignee: 'unassigned' as const } : filter === 'breached' ? { ...open, sla: 'breached' as const } : filter === 'awaitingCustomer' && pendingCustomer ? { ...open, statusIds: [pendingCustomer] } : open;
  const queueLabel = filter === 'unassigned' ? 'All unassigned' : filter === 'breached' ? 'All breached' : filter === 'awaitingCustomer' && pendingCustomer ? 'All awaiting customer' : 'All open';
  const loadRows = loadBy === 'customer' ? d.byCustomer.map((r) => ({ key: r.id, label: r.name, open: r.open, breached: r.breached, href: ticketListPath({ customerId: r.id, domain: 'amc', status: 'open' }) })) : d.bySite.map((r) => ({ key: `${r.customerId}-${r.id ?? 'none'}`, label: customerId ? r.name : `${r.name} · ${r.customerName}`, open: r.open, breached: r.breached, href: r.id ? ticketListPath({ customerId: r.customerId, domain: 'amc', status: 'open', siteId: r.id }) : undefined }));
  // Visit and maintenance links carry the dashboard's customer scope and only keys those lists read (`engineerId`, `status`, `from`/`to` on the scheduled start or the planned date).
  const scopeCustomer = customerId || undefined;
  const engineerVisits = (id: string, status: string, window?: { from: string; to: string }) => modulePath('/field/visits', { customerId: scopeCustomer, engineerId: id, status, from: window?.from, to: window?.to });
  return (
    <div className="flex flex-col gap-6">
      <KpiGrid
        items={[
          { label: 'Open AMC tickets', icon: <Wrench className="h-4 w-4" />, value: fmtNumber(k.open), hint: `${fmtNumber(k.openedToday)} opened today · ${fmtNumber(k.resolvedThisWeek)} resolved this week`, to: ticketListPath(open) },
          { label: 'Unassigned', icon: <UserX className="h-4 w-4" />, value: fmtNumber(k.unassigned), tone: k.unassigned > 0 ? 'warn' : 'default', hint: 'waiting for an engineer', to: ticketListPath({ ...open, assignee: 'unassigned' }) },
          { label: 'SLA at risk', icon: <Timer className="h-4 w-4" />, value: fmtNumber(k.atRisk + k.breached), tone: k.breached > 0 ? 'bad' : k.atRisk > 0 ? 'warn' : 'good', hint: `${fmtNumber(k.breached)} breached · ${fmtNumber(k.dueToday)} due today`, to: ticketListPath({ ...open, sla: ['at_risk', 'breached'] }) },
          { label: 'Site visits this week', icon: <CalendarCheck className="h-4 w-4" />, value: fmtNumber(k.visitsThisWeek), hint: 'scheduled or in progress', to: modulePath('/field/visits', { customerId: scopeCustomer }) },
        ]}
      />
      <Panel
        title="AMC work queue"
        subtitle="Open tickets in the AMC domain, highest priority first; the segments narrow this list only"
        to={ticketListPath(queueLink)}
        toLabel={queueLabel}
        padded={false}
        action={
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: c.all },
              { value: 'unassigned', label: 'Unassigned', count: c.unassigned },
              { value: 'dueToday', label: 'Due today', count: c.dueToday },
              { value: 'breached', label: 'Breached', count: c.breached },
              { value: 'awaitingCustomer', label: 'Awaiting customer', count: c.awaitingCustomer },
            ]}
          />
        }
      >
        <div className="px-5">
          <TicketMiniTable rows={rows} max={25} columns={['customer', 'site', 'category', 'priority', 'status', 'sla', 'assignee', 'visit']} empty={filter === 'all' ? 'No open AMC tickets' : 'Nothing matches this segment'} />
        </div>
      </Panel>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Both series are completions, a state: the second takes the status "good" colour, paired with its legend label. */}
        <Panel title="Completed work" subtitle={`${workView === 'visits' ? 'Site visits' : workView === 'pm' ? 'Preventive maintenance' : 'Site visits and preventive maintenance'} completed per day, ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}`} className="xl:col-span-2" to="/reports?tab=run&report=amc_utilization" toLabel="Utilization report" action={<Segmented size="sm" options={[{ value: 'both', label: 'Both' }, { value: 'visits', label: 'Visits' }, { value: 'pm', label: 'Maintenance' }]} value={workView} onChange={setWorkView} />}>
          <TrendChart data={work} x="day" kind="bar" stacked={false} series={[...(workView !== 'pm' ? [{ key: 'visitsCompleted', label: 'Visits completed' }] : []), ...(workView !== 'visits' ? [{ key: 'pmCompleted', label: 'Maintenance completed', color: STATUS_COLORS.good }] : [])]} height={220} />
        </Panel>
        <Panel title={`Service levels · ${days} days`} subtitle="Resolution targets on AMC tickets opened in the period">
          <SlaGauge pct={d.sla30d.compliancePct} met={d.sla30d.met} breached={d.sla30d.breached} label="Targets met" />
          <div className="mt-5 pt-4 border-t border-default grid grid-cols-2 gap-x-4 gap-y-4">
            <Stat label="Resolved this week" value={fmtNumber(k.resolvedThisWeek)} />
            <Stat label="Awaiting customer" value={fmtNumber(k.awaitingCustomer)} tone={k.awaitingCustomer > 0 ? 'warn' : 'default'} />
            <Stat label="Customer satisfaction" value={fmtRating(d.csat30d?.avg)} tone={ratingTone(d.csat30d?.avg)} />
            <Stat label="Survey responses" value={fmtNumber(d.csat30d?.responses ?? 0)} />
          </div>
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="AMC load by" subtitle={`Open AMC tickets by ${loadBy === 'customer' ? 'customer' : 'site'}, breached in red; a row opens their list`} to={ticketListPath(open)} toLabel="All open" action={<Segmented size="sm" options={[{ value: 'customer', label: 'Customer' }, { value: 'site', label: 'Site' }]} value={loadBy} onChange={setLoadBy} />}>
          <BreakdownBar dense items={loadRows.map((r) => ({ label: r.label, value: r.open, secondary: r.breached, secondaryLabel: 'breached', href: r.href }))} emptyText="No open AMC tickets" />
        </Panel>
        <AgeingPanel ageing={d.ageing} link={open} />
        <Panel title="Visits by engineer" subtitle={`Still scheduled (overdue ones included), in progress now, and completed among the visits scheduled ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}; a number opens those visits`} to={modulePath('/field/visits', { customerId: scopeCustomer })} toLabel="Field service">
          <RateTable
            columns={['Engineer', 'Scheduled', 'Ongoing', 'Completed']}
            minWidth={0}
            empty="No engineer has visits in this window"
            rows={d.visitsByEngineer.map((e) => ({
              key: e.id,
              label: e.name,
              cells: [
                { value: fmtNumber(e.scheduled), href: engineerVisits(e.id, 'scheduled') },
                { value: fmtNumber(e.inProgress), href: engineerVisits(e.id, 'in_progress'), tone: e.inProgress > 0 ? 'default' : 'muted' },
                { value: fmtNumber(e.completedInPeriod), href: engineerVisits(e.id, 'completed', d.period) },
              ],
            }))}
          />
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Visits this week" subtitle="Scheduled and in-progress site visits" to={modulePath('/field/visits', { customerId: scopeCustomer })} toLabel="Field service">
          <RowList
            empty="No visits scheduled this week"
            dense
            items={d.visits.map((v) => ({
              key: v.id,
              href: `/field/${v.id}`,
              primary: (
                <span className="inline-flex items-center gap-2">
                  <span>{v.title}</span>
                  <Badge color={VISIT_STATUS_COLORS[v.status] ?? 'slate'}>{v.status.replace('_', ' ')}</Badge>
                </span>
              ),
              secondary: `${v.customer_name ?? ''}${v.site_name ? ` · ${v.site_name}` : ''}${v.engineer ? ` · ${v.engineer}` : ' · unassigned'}`,
              right: v.scheduled_start ? fmtDateTime(v.scheduled_start) : 'to schedule',
            }))}
          />
        </Panel>
        <Panel title="Maintenance due" subtitle="Preventive maintenance due within 14 days" to={modulePath('/maintenance', { customerId: scopeCustomer })} toLabel="Maintenance">
          <RowList
            empty="No maintenance due"
            dense
            items={d.maintenance.map((m) => ({
              key: m.id,
              // The maintenance schedule filters by program (`programId`), so the row opens the schedule narrowed to its program.
              href: modulePath('/maintenance', { customerId: scopeCustomer, programId: m.program_id }),
              primary: (
                <span className="inline-flex items-center gap-2">
                  <span>{m.program}</span>
                  {m.overdue ? <Badge color="red">overdue</Badge> : <Badge color={m.status === 'scheduled' ? 'blue' : 'slate'}>{m.status}</Badge>}
                </span>
              ),
              secondary: `${m.customer_name ?? ''}${m.site ? ` · ${m.site}` : ''}${m.engineer ? ` · ${m.engineer}` : ''}`,
              right: fmtDate(m.due_date),
            }))}
          />
        </Panel>
        <Panel title="Entitlements near limit" subtitle="Visits and hours at 80% or more" to="/reports?tab=run&report=amc_utilization" toLabel="Utilization report">
          <EntitlementAlerts items={d.entitlements} emptyText="All AMC entitlements have headroom" />
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Panel title="Visits by status" subtitle={`Scheduled ${fmtDate(d.window.from)} – ${fmtDate(d.window.to)}; a slice opens those visits`} to={modulePath('/field/visits', { customerId: scopeCustomer })} toLabel="Field service">
          <DonutChart size={130} centerLabel="visits" emptyText="No visits in this window" slices={statusSlices(d.visitsByStatus, VISIT_STATUS_COLORS, (status) => modulePath('/field/visits', { customerId: scopeCustomer, status, from: d.window.from, to: d.window.to }))} />
        </Panel>
        <Panel title="Preventive maintenance by status" subtitle={`Planned ${fmtDate(d.window.from)} – ${fmtDate(d.window.to)}; a slice opens those occurrences`} to={modulePath('/maintenance', { customerId: scopeCustomer })} toLabel="Maintenance">
          <DonutChart size={130} centerLabel="occurrences" emptyText="No maintenance in this window" slices={statusSlices(d.pmByStatus, PM_STATUS_COLORS, (status) => modulePath('/maintenance', { customerId: scopeCustomer, status, from: d.window.from, to: d.window.to }))} />
        </Panel>
      </div>
    </div>
  );
}
