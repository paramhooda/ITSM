import { Link } from 'react-router-dom';
import { Select } from '@/components/ui';
import { fmtDate, fmtDuration, fmtNumber, fmtPct } from '@/lib/format';
import { PRIORITY_LEVEL_COLORS } from '@/lib/statusColors';
import { ticketListPath, type TicketListLink } from '@itsm/shared';
import { Panel, Segmented, Stat, RowList } from './Panel';
import { TrendChart } from './TrendChart';
import { DonutChart } from './DonutChart';
import { BreakdownBar } from './BreakdownBar';
import { STATUS_COLORS } from './chartTheme';
import { useLocalControl } from './localControls';
import { AgeingPanel, ArrivalsPanel, RateTable, flowPointHref, AGEING_VIEWS, HEAT_VIEWS, type AgeingView, type HeatView } from './DeskPanels';
import type { Overview, OverviewDesk as Desk, LoadDimension } from './overviewApi';

/**
 * The desk's health on the Overview (present only with tickets:read): ticket
 * flow, open by type, backlog ageing, when tickets arrive, who carries the
 * load, response by priority and change outcomes. Every number is counted
 * live under the person's fence and links to the ticket list with the same
 * predicates; the control in a panel header lives in the URL (`flow=`, `age=`,
 * `heat=`, `by=`) and changes that panel alone.
 */

const TYPE_PLURAL: Record<string, string> = { incident: 'Incidents', request: 'Requests', problem: 'Problems', change: 'Changes' };

type FlowView = 'flow' | 'breaches' | 'compliance';
const FLOW_VIEWS: readonly FlowView[] = ['flow', 'breaches', 'compliance'];
const LOAD_DIMENSIONS: readonly LoadDimension[] = ['team', 'engineer', 'service', 'customer', 'category'];
/** The API returns every row, largest first; the panel lists this many and folds the rest into one "Other" row that is the true remainder. */
const LOAD_FOLD = 10;
const LOAD_LABEL: Record<LoadDimension, string> = { team: 'Team', engineer: 'Engineer', service: 'Service', customer: 'Customer', category: 'Category' };
const LOAD_NOUN: Record<LoadDimension, string> = { team: 'the team that carries them', engineer: 'the engineer they are assigned to', service: 'the service they concern', customer: 'the customer who raised them', category: 'their category' };

/** The list a "who carries the load" row opens: the open list narrowed to that row's record. */
const loadKey = (by: LoadDimension, id: string): Partial<TicketListLink> =>
  by === 'team' ? { teamId: id } : by === 'engineer' ? { assignee: id } : by === 'service' ? { serviceId: id } : by === 'customer' ? { customerId: id } : { categoryId: id };

export function TicketFlowPanel({ d, scope, className }: { d: Overview; scope: TicketListLink; className?: string }) {
  const desk = d.desk!;
  const [view, setView] = useLocalControl<FlowView>('flow', 'flow', FLOW_VIEWS);
  const series = desk.series;
  const live = series.some((s) => s.opened || s.resolved || s.breaches);
  const subtitle = { flow: 'Opened and resolved per day; a bar opens that day’s tickets', breaches: 'SLA clocks breached per day', compliance: 'Resolution clocks met per day, as a share of those that ended' }[view];
  return (
    <Panel title="Ticket flow" subtitle={`${subtitle} · ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}`} className={className} to="/reports?tab=run&report=ticket_volume" toLabel="Ticket volume report" action={<Segmented size="sm" options={[{ value: 'flow', label: 'Flow' }, { value: 'breaches', label: 'Breaches' }, { value: 'compliance', label: 'Compliance' }]} value={view} onChange={setView} />}>
      {view === 'flow' && <TrendChart data={live ? series : []} x="day" kind="bar" height={240} series={[{ key: 'opened', label: 'Opened' }, { key: 'resolved', label: 'Resolved', color: STATUS_COLORS.good }]} pointHref={flowPointHref(scope, { opened: 'created', resolved: 'resolved' })} />}
      {view === 'breaches' && <TrendChart data={live ? series : []} x="day" kind="bar" height={240} series={[{ key: 'breaches', label: 'SLA breaches', color: STATUS_COLORS.critical }]} />}
      {view === 'compliance' && <TrendChart data={live ? series : []} x="day" kind="line" height={240} series={[{ key: 'compliancePct', label: 'Compliance' }]} yDomain={[0, 100]} yTicks={[0, 25, 50, 75, 100]} valueFormatter={(v) => `${v}%`} />}
    </Panel>
  );
}

export function OpenByTypePanel({ desk, open, className }: { desk: Desk; open: TicketListLink; className?: string }) {
  const breached = desk.byType.filter((t) => t.breached > 0);
  return (
    <Panel title="Open by type" subtitle="Open tickets now; a slice opens the list" to={ticketListPath(open)} toLabel="All open" className={className}>
      <DonutChart size={150} centerLabel="open" emptyText="No open tickets" slices={desk.byType.map((t) => ({ key: t.type, label: TYPE_PLURAL[t.type] ?? t.type, value: t.count, href: ticketListPath({ ...open, type: t.type as TicketListLink['type'] }) }))} />
      {breached.length > 0 && (
        <div className="mt-4 pt-3 border-t border-default text-[12px] text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Breached:</span>
          {breached.map((t) => (
            <Link key={t.type} to={ticketListPath({ ...open, type: t.type as TicketListLink['type'], sla: 'breached' })} className="text-red-600 font-medium tnum hover:underline">
              {fmtNumber(t.breached)} {(TYPE_PLURAL[t.type] ?? t.type).toLowerCase()}
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function OverviewAgeingPanel({ desk, open, className }: { desk: Desk; open: TicketListLink; className?: string }) {
  const [view, setView] = useLocalControl<AgeingView>('age', 'all', AGEING_VIEWS);
  return <AgeingPanel ageing={desk.ageing} link={open} view={view} onView={setView} className={className} />;
}

export function OverviewArrivalsPanel({ desk, scope, className }: { desk: Desk; scope: TicketListLink; className?: string }) {
  const [view, setView] = useLocalControl<HeatView>('heat', 'week', HEAT_VIEWS);
  return <ArrivalsPanel arrivals={desk.arrivals} link={scope} view={view} onView={setView} className={className} />;
}

export function LoadPanel({ desk, open, className }: { desk: Desk; open: TicketListLink; className?: string }) {
  const [by, setBy] = useLocalControl<LoadDimension>('by', 'team', LOAD_DIMENSIONS);
  const rows = desk.breakdowns[by] ?? [];
  const total = rows.reduce((n, r) => n + r.open, 0);
  return (
    <Panel title="Who carries the load" subtitle={`Open tickets by ${LOAD_NOUN[by]}, breached in red${rows.length > LOAD_FOLD + 1 ? ` · the ${LOAD_FOLD} largest, the rest as Other` : ''}`} to={ticketListPath(open)} toLabel="All open" className={className} action={<Select className="h-8 py-0 text-[12.5px] w-36" value={by} onChange={(e) => setBy(e.target.value as LoadDimension)} options={LOAD_DIMENSIONS.map((k) => ({ value: k, label: `By ${LOAD_LABEL[k].toLowerCase()}` }))} aria-label="Group open tickets by" />}>
      <BreakdownBar
        dense
        emptyText="No open tickets"
        foldAfter={LOAD_FOLD}
        items={rows.map((r) => ({ label: r.label, value: r.open, secondary: r.breached, secondaryLabel: 'breached', href: r.id ? ticketListPath({ ...open, ...loadKey(by, r.id) }) : undefined }))}
        max={Math.max(1, ...rows.map((r) => r.open))}
      />
      {total > 0 && <div className="mt-3 text-[11.5px] text-subtle tnum">{fmtNumber(total)} open across {rows.length} {rows.length === 1 ? 'row' : 'rows'}; a row without a record (no team, unassigned) and the Other row are not doors.</div>}
    </Panel>
  );
}

export function ResponseByPriorityPanel({ d, scope, className }: { d: Overview; scope: TicketListLink; className?: string }) {
  const desk = d.desk!;
  const period = { createdFrom: d.period.from, createdTo: d.period.to };
  const resolved = { resolvedFrom: d.period.from, resolvedTo: d.period.to };
  const rows = desk.byPriority.filter((r) => r.opened > 0 || r.resolved > 0);
  return (
    <Panel title="Response by priority" subtitle={`Tickets opened or resolved ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}: time to first response and to resolve, first-contact resolution and reopens`} to="/reports?tab=run&report=sla_performance" toLabel="SLA report" className={className}>
      <RateTable
        columns={['Priority', 'Opened', 'Resolved', 'First response', 'Resolution', 'First contact', 'Reopened']}
        empty="No tickets opened or resolved in this period"
        rows={rows.map((r) => ({
          key: r.id ?? r.priority,
          label: r.priority,
          color: PRIORITY_LEVEL_COLORS[r.level] ?? null,
          cells: [
            { value: fmtNumber(r.opened), href: r.id ? ticketListPath({ ...scope, status: 'any', priorityIds: [r.id], ...period }) : undefined },
            { value: fmtNumber(r.resolved), href: r.id ? ticketListPath({ ...scope, status: 'any', priorityIds: [r.id], ...resolved }) : undefined },
            { value: fmtDuration(r.mttaMinutes), tone: r.mttaMinutes === null ? 'muted' : 'default' },
            { value: fmtDuration(r.mttrMinutes), tone: r.mttrMinutes === null ? 'muted' : 'default' },
            { value: fmtPct(r.fcrPct), tone: r.fcrPct === null ? 'muted' : 'default' },
            { value: fmtPct(r.reopenPct), tone: r.reopenPct === null ? 'muted' : (r.reopenPct ?? 0) > 10 ? 'bad' : 'default' },
          ],
        }))}
      />
    </Panel>
  );
}

export function ChangesPanel({ d, open, className }: { d: Overview; open: TicketListLink; className?: string }) {
  const c = d.desk!.changes;
  const o = c.outcomes;
  const slices = [
    { key: 'implemented', label: 'Implemented', value: o.implemented, color: 'green' },
    { key: 'failed', label: 'Failed', value: o.failed, color: 'red' },
    { key: 'backedOut', label: 'Backed out', value: o.backedOut, color: 'orange' },
  ];
  return (
    <Panel title="Changes" subtitle={`Open changes now and the outcome of changes that ended ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}`} to="/operations/change-calendar" toLabel="Change calendar" className={className}>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Link to={ticketListPath({ ...open, type: 'change' })} className="block rounded-lg -mx-1 px-1 hover:bg-surface-2 transition-colors"><Stat label="Open changes" value={fmtNumber(c.open)} /></Link>
        <Stat label="Success rate" value={fmtPct(o.successPct)} tone={o.successPct === null ? 'default' : o.successPct >= 95 ? 'good' : o.successPct >= 85 ? 'warn' : 'bad'} />
        <Stat label="Emergency" value={fmtNumber(o.emergency)} tone={o.emergency > 0 ? 'warn' : 'default'} />
      </div>
      <DonutChart size={120} centerLabel="ended" emptyText="No change ended in this period" slices={slices} layout="donut" />
      {o.failedList.length > 0 && (
        <div className="mt-4 pt-3 border-t border-default">
          <div className="text-[12px] text-muted mb-1">Failed or backed out</div>
          <RowList dense items={o.failedList.slice(0, 3).map((f) => ({ key: f.number, primary: `${f.number} · ${f.title}`, secondary: `${f.changeType} change${f.assignee ? ` · ${f.assignee}` : ''}`, right: f.outcome }))} />
        </div>
      )}
    </Panel>
  );
}
