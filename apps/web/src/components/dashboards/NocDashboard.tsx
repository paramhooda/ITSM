import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ErrorBlock } from '@/components/ui';
import { Activity, Flame, Timer, UserX, PhoneCall, AlertTriangle, Gauge } from 'lucide-react';
import { get } from '@/api/client';
import { fmtNumber, relativeTime, fmtDuration, fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ticketListPath, type TicketListLink } from '@itsm/shared';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { TicketMiniTable } from './TicketMiniTable';
import { WorkloadList, type WorkloadItem } from './WorkloadList';
import { Panel, KpiSkeleton, Stat, Segmented } from './Panel';
import { OnCallPanel, type OnCallSummaryTeam } from './OnCallPanel';
import { STATUS_COLORS } from './chartTheme';
import { useLocalControl } from './localControls';
import { AgeingPanel, ArrivalsPanel, EventsPanel, flowPointHref, HEAT_VIEWS, EVENTS_VIEWS, type HeatView, type EventsView } from './DeskPanels';
import type { TicketRow, Breakdown } from './types';
import type { AgeBucket, Arrivals, NocStrip } from './overviewApi';

/** Open tickets by team or service with the shared SLA vocabulary (id so the row drills down). */
export interface NocLoadRow {
  id: string | null;
  name: string;
  open: number;
  breached: number;
  atRisk: number;
}

/** `GET /dashboards/noc` (mirrors apps/api/src/modules/dashboards/service.ts noc()). */
export interface Noc {
  generatedAt: string;
  period: { days: number; from: string; to: string };
  customerId: string | null;
  teamId: string | null;
  /** The NOC-type teams the hero's team control offers. */
  teams: { id: string; name: string; teamType: string }[];
  /** The tile numbers (the Overview's NOC strip reads exactly these). */
  totals: NocStrip;
  openIncidents: Breakdown[];
  criticalOpen: TicketRow[];
  slaAtRisk: { atRisk: number; breached: number; items: TicketRow[] };
  unassigned: { count: number; items: TicketRow[] };
  byCategory: Breakdown[];
  byTeam: NocLoadRow[];
  byService: NocLoadRow[];
  monitoringEvents24h: { total: number; ticketsCreated: number; bySeverity: { severity: string; count: number; ticketed: number }[] };
  monitoringEvents7d: { total: number; ticketsCreated: number; bySeverity: { severity: string; count: number; ticketed: number }[]; byDay: { day: string; count: number; ticketed: number }[] };
  engineerWorkload: WorkloadItem[];
  recentlyResolved: TicketRow[];
  aging: { bucket: string; count: number }[];
  /** The five-bucket backlog ageing with the created window each bar drills down with. */
  ageing: AgeBucket[];
  arrivals: Arrivals;
  /** Live and fenced like the tiles (domain, customer, team): opened, the incident share, resolved and breaches per day. */
  series: { day: string; opened: number; incidents: number; resolved: number; breaches: number }[];
  majorIncidents: { id: string; number: string; title: string; customerName: string; declaredAt: string; lastUpdateAt: string | null; nextUpdateDueAt: string | null; bridgeUrl: string | null; commander: string | null; overdue: boolean; children: number }[];
  onCall?: OnCallSummaryTeam[];
}

/** Active major incidents: who commands them and whether the stakeholders are owed an update. */
function MajorIncidentsPanel({ items }: { items: Noc['majorIncidents'] }) {
  return (
    <Panel title="Major incidents in progress" subtitle={items.length ? 'Bridge, commander and update cadence per incident' : 'None declared'} to="/operations/major-incidents" toLabel="Incident command" padded={false} className={items.length ? 'border-red-200' : undefined}>
      {items.length === 0 ? (
        <div className="px-5 pb-4 text-[12.5px] text-muted">No major incident is open. Declare one from an incident's actions menu when an outage needs a bridge and regular stakeholder updates.</div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {items.map((m) => {
            const due = m.nextUpdateDueAt ? Math.round((new Date(m.nextUpdateDueAt).getTime() - Date.now()) / 60_000) : null;
            return (
              <li key={m.id} className="px-5 py-2.5 flex items-center gap-3 text-[13px]">
                <span className="h-6 w-6 rounded-full bg-red-100 text-red-700 flex items-center justify-center shrink-0"><Flame className="h-3.5 w-3.5" /></span>
                <Link to={`/tickets/${m.id}?tab=major`} className="font-mono text-[12.5px] text-brand-700 hover:underline whitespace-nowrap">{m.number}</Link>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" title={m.title}>{m.title}</span>
                  <span className="block text-[11.5px] text-muted truncate">{m.customerName} · {m.commander ? `commander ${m.commander}` : 'no commander'}{m.children ? ` · ${m.children} child${m.children === 1 ? '' : 'ren'}` : ''}</span>
                </span>
                <span className={cn('text-[11.5px] whitespace-nowrap inline-flex items-center gap-1', m.overdue ? 'text-red-600 font-medium' : 'text-muted')}>
                  {m.overdue && <AlertTriangle className="h-3 w-3" />}
                  {due === null ? `declared ${relativeTime(m.declaredAt)}` : due < 0 ? `update ${fmtDuration(-due)} overdue` : `next update in ${fmtDuration(due)}`}
                </span>
                {m.bridgeUrl && (
                  <a href={m.bridgeUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 h-7 px-2 rounded-md bg-red-600 text-white text-[12px] font-medium hover:bg-red-700 whitespace-nowrap"><PhoneCall className="h-3 w-3" /> Bridge</a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export interface NocScope {
  days: number;
  customerId: string;
  /** One NOC team, or empty for every team. */
  teamId?: string;
}

/** The NOC payload for the scope; the page (hero team list, Updated stamp) and the dashboard share one query. */
export function useNocDashboard({ days, customerId, teamId = '' }: NocScope) {
  return useQuery({ queryKey: ['dashboards', 'noc', days, customerId, teamId], queryFn: () => get<Noc>('/dashboards/noc', { days, customerId: customerId || undefined, teamId: teamId || undefined }), refetchInterval: 60_000, placeholderData: (p) => p });
}

type CritView = 'all' | 'p1' | 'major';
type RiskOrder = 'deadline' | 'priority';
type EngView = 'top' | 'all';
type ByView = 'category' | 'team' | 'service';
const CRIT_VIEWS: readonly CritView[] = ['all', 'p1', 'major'];
const RISK_ORDERS: readonly RiskOrder[] = ['deadline', 'priority'];
const ENG_VIEWS: readonly EngView[] = ['top', 'all'];
const BY_VIEWS: readonly ByView[] = ['category', 'team', 'service'];

/**
 * Network operations: every panel follows the hero's period, customer scope
 * and team; every tile, bar, cell and row is a door into the ticket list with
 * the same predicates (customer, every domain but security, the team, the
 * state); the controls in a panel header live in the URL (`crit=`, `risk=`,
 * `eng=`, `by=`, `events=`, `heat=`) and change that panel alone.
 */
export function NocDashboard({ days = 30, customerId = '', teamId = '' }: { days?: number; customerId?: string; teamId?: string }) {
  const [criticalView, setCriticalView] = useLocalControl<CritView>('crit', 'all', CRIT_VIEWS);
  const [riskOrder, setRiskOrder] = useLocalControl<RiskOrder>('risk', 'deadline', RISK_ORDERS);
  const [engView, setEngView] = useLocalControl<EngView>('eng', 'top', ENG_VIEWS);
  const [by, setBy] = useLocalControl<ByView>('by', 'category', BY_VIEWS);
  const [eventsView, setEventsView] = useLocalControl<EventsView>('events', '24h', EVENTS_VIEWS);
  const [heatView, setHeatView] = useLocalControl<HeatView>('heat', 'week', HEAT_VIEWS);
  const q = useNocDashboard({ days, customerId, teamId });
  const d = q.data;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d) return <KpiSkeleton count={5} />;
  const t = d.totals;
  const critical = d.openIncidents.filter((p) => (p.level ?? 99) <= 2);
  const p1p2 = critical.reduce((s, p) => s + p.count, 0);
  const criticalIds = critical.map((p) => p.id).filter((id): id is string => !!id);
  // Every link carries what the number was counted with: the customer scope, every domain but security, the team when one is chosen, open status.
  const scope: TicketListLink = { customerId: customerId || null, domain: 'not_soc', teamId: teamId || null };
  const open: TicketListLink = { ...scope, status: 'open' };
  const incidents: TicketListLink = { ...open, type: 'incident' };
  const criticalRows = criticalView === 'p1' ? d.criticalOpen.filter((r) => r.priority_level === 1) : criticalView === 'major' ? d.criticalOpen.filter((r) => r.is_major) : d.criticalOpen;
  const riskRows = riskOrder === 'priority' ? [...d.slaAtRisk.items].sort((a, b) => (a.priority_level ?? 99) - (b.priority_level ?? 99) || (a.sla?.remainingMinutes ?? 0) - (b.sla?.remainingMinutes ?? 0)) : d.slaAtRisk.items;
  const flow = d.series.some((s) => s.opened || s.resolved) ? d.series : [];
  const byRows: { id: string | null; label: string; open: number; breached: number; key: Partial<TicketListLink> }[] =
    by === 'category'
      ? d.byCategory.map((c) => ({ id: c.id ?? null, label: c.label, open: c.count, breached: c.breached ?? 0, key: { categoryId: c.id ?? undefined } }))
      : by === 'team'
        ? d.byTeam.map((r) => ({ id: r.id, label: r.name, open: r.open, breached: r.breached, key: { teamId: r.id ?? undefined } }))
        : d.byService.map((r) => ({ id: r.id, label: r.name, open: r.open, breached: r.breached, key: { serviceId: r.id ?? undefined } }));
  const byNoun = { category: 'NOC category', team: 'the team that carries them', service: 'the service they concern' }[by];
  return (
    <div className="flex flex-col gap-6">
      <KpiGrid
        items={[
          { label: 'Open incidents', value: fmtNumber(t.openIncidents), icon: <Activity className="h-4 w-4" />, hint: `${fmtNumber(t.openedToday)} opened · ${fmtNumber(t.resolvedToday)} resolved today`, spark: d.series.map((s) => s.incidents), sparkLabel: `Incidents opened per day, last ${days} days`, to: ticketListPath(incidents) },
          { label: 'P1 / P2 open', value: fmtNumber(p1p2), icon: <Flame className="h-4 w-4" />, tone: p1p2 > 0 ? 'bad' : 'good', hint: `${fmtNumber(t.major)} major · ${fmtNumber(t.escalated)} escalated`, to: criticalIds.length ? ticketListPath({ ...incidents, priorityIds: criticalIds }) : undefined },
          { label: 'SLA at risk', value: fmtNumber(t.atRisk), icon: <Timer className="h-4 w-4" />, tone: t.atRisk > 0 ? 'warn' : 'good', hint: `${fmtNumber(t.breached)} already breached`, spark: d.series.map((s) => s.breaches), sparkLabel: `SLA breaches per day, last ${days} days`, to: ticketListPath({ ...open, sla: 'at_risk' }) },
          { label: 'Likely to breach', value: fmtNumber(t.highRisk ?? 0), icon: <Gauge className="h-4 w-4" />, tone: (t.highRisk ?? 0) > 0 ? 'warn' : 'good', hint: `${fmtNumber(t.mediumRisk ?? 0)} medium risk · ${fmtNumber(t.unhappy ?? 0)} unhappy customers`, to: ticketListPath({ ...open, breachRisk: 'high' }) },
          { label: 'Unassigned', value: fmtNumber(t.unassigned), icon: <UserX className="h-4 w-4" />, tone: t.unassigned > 0 ? 'warn' : 'default', hint: 'waiting for an owner', to: ticketListPath({ ...open, assignee: 'unassigned' }) },
        ]}
        columns={5}
      />
      {(d.majorIncidents?.length ?? 0) > 0 && <MajorIncidentsPanel items={d.majorIncidents} />}
      <Panel title="Critical and major incidents" subtitle="P1, P2 and major tickets ordered by priority" to={criticalIds.length ? ticketListPath({ ...incidents, priorityIds: criticalIds }) : ticketListPath(incidents)} toLabel={criticalIds.length ? 'All P1 / P2' : 'All incidents'} padded={false} action={<Segmented size="sm" options={[{ value: 'all', label: 'All' }, { value: 'p1', label: 'P1' }, { value: 'major', label: 'Major' }]} value={criticalView} onChange={setCriticalView} />}>
        <div className="px-5">
          <TicketMiniTable rows={criticalRows} max={8} columns={['customer', 'priority', 'ci', 'status', 'sla', 'assignee']} empty={criticalView === 'all' ? 'No P1/P2 or major incidents open' : criticalView === 'p1' ? 'No P1 incidents open' : 'No major incidents open'} />
        </div>
      </Panel>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Incident flow" subtitle={`Incidents opened and tickets resolved per day, ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}; a bar opens that day's tickets`} className="xl:col-span-2" to={ticketListPath({ ...scope, status: 'any', createdFrom: d.period.from, createdTo: d.period.to })} toLabel="Opened in the period">
          <TrendChart data={flow} x="day" kind="bar" height={230} series={[{ key: 'incidents', label: 'Incidents opened' }, { key: 'resolved', label: 'Resolved', color: STATUS_COLORS.good }]} pointHref={flowPointHref(scope, { incidents: 'created', resolved: 'resolved' })} />
        </Panel>
        <AgeingPanel
          ageing={d.ageing}
          link={open}
          footer={
            <div className="mt-4 pt-4 border-t border-default grid grid-cols-3 gap-3">
              <Stat label="Resolved today" value={fmtNumber(t.resolvedToday)} />
              <Stat label="MTTR today" value={fmtDuration(t.mttrTodayMinutes)} />
              <Stat label="Known errors" value={fmtNumber(t.knownErrorsOpen)} tone={(t.knownErrorsOpen ?? 0) > 0 ? 'warn' : 'default'} />
            </div>
          }
        />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="At risk or breached" subtitle={riskOrder === 'deadline' ? 'Soonest SLA deadline first' : 'Highest priority first'} to={ticketListPath({ ...open, sla: ['breached', 'at_risk'] })} toLabel="All at risk or breached" padded={false} action={<Segmented size="sm" options={[{ value: 'deadline', label: 'Deadline' }, { value: 'priority', label: 'Priority' }]} value={riskOrder} onChange={setRiskOrder} />}>
          <div className="px-5">
            <TicketMiniTable rows={riskRows} max={6} columns={['customer', 'priority', 'sla']} empty="Every open ticket is within SLA" />
          </div>
        </Panel>
        <Panel title="Engineer load" subtitle={`Open tickets per engineer in ${teamId ? 'the team' : 'NOC, infrastructure and network teams'}; a row opens their list`} action={d.engineerWorkload.length > 8 ? <Segmented size="sm" options={[{ value: 'top', label: 'Top 8' }, { value: 'all', label: `All ${d.engineerWorkload.length}` }]} value={engView} onChange={setEngView} /> : undefined}>
          <WorkloadList items={engView === 'all' ? d.engineerWorkload : d.engineerWorkload.slice(0, 8)} link={open} />
        </Panel>
        <Panel title="Open by" subtitle={`Open tickets by ${byNoun}, breached in red${byRows.length > 11 ? ' · the ten largest, the rest as Other' : ''}`} to={ticketListPath(open)} toLabel="All open" action={<Segmented size="sm" options={[{ value: 'category', label: 'Category' }, { value: 'team', label: 'Team' }, { value: 'service', label: 'Service' }]} value={by} onChange={setBy} />}>
          <BreakdownBar dense foldAfter={10} items={byRows.map((r) => ({ label: r.label, value: r.open, secondary: r.breached, secondaryLabel: 'breached', href: r.id ? ticketListPath({ ...open, ...r.key }) : undefined }))} emptyText="No open tickets" />
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <ArrivalsPanel arrivals={d.arrivals} link={scope} view={heatView} onView={setHeatView} className="xl:col-span-2" />
        <EventsPanel title="Monitoring events" source="PRTG" last24h={d.monitoringEvents24h} last7d={d.monitoringEvents7d} view={eventsView} onView={setEventsView} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <OnCallPanel items={d.onCall ?? []} />
        <Panel title="Recently resolved" subtitle="The last ten resolved, with the time to resolve" to={ticketListPath({ ...scope, status: 'any', resolvedFrom: d.period.from, resolvedTo: d.period.to })} toLabel="Resolved in the period" padded={false} className="xl:col-span-2">
          <div className="px-5">
            <TicketMiniTable rows={d.recentlyResolved} max={6} columns={['customer', 'priority', 'assignee', 'resolved']} empty="Nothing resolved yet" />
          </div>
        </Panel>
      </div>
    </div>
  );
}
