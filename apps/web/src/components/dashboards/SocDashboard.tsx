import { useQuery } from '@tanstack/react-query';
import { ErrorBlock, Badge } from '@/components/ui';
import { ShieldAlert, Siren, Timer, Radio } from 'lucide-react';
import { get } from '@/api/client';
import { fmtDate, fmtDuration, fmtNumber } from '@/lib/format';
import { ticketListPath, type TicketListLink } from '@itsm/shared';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { DonutChart } from './DonutChart';
import { TicketMiniTable } from './TicketMiniTable';
import { Panel, KpiSkeleton, Skeleton, RowList, Segmented } from './Panel';
import { OnCallPanel, type OnCallSummaryTeam } from './OnCallPanel';
import { STATUS_COLORS, optionHex, useChartTheme } from './chartTheme';
import { useLocalControl } from './localControls';
import { AgeingPanel, ArrivalsPanel, EventsPanel, RateTable, flowPointHref, HEAT_VIEWS, EVENTS_VIEWS, type HeatView, type EventsView } from './DeskPanels';
import type { TicketRow, Breakdown } from './types';
import type { AgeBucket, Arrivals, SocStrip } from './overviewApi';

/** `GET /dashboards/soc` (mirrors apps/api/src/modules/dashboards/service.ts soc()). */
export interface Soc {
  generatedAt: string;
  customerId: string | null;
  /** The tile numbers (the Overview's SOC strip reads exactly these); the critical/high tile links with `criticalHighSeverityIds`. */
  totals: SocStrip;
  criticalHighSeverityIds: string[];
  /** Every security severity, active ones first then by level (retired ones too, so a ticket that still carries one lands in a key): the keys of `seriesBySeverity`. */
  severities: { id: string; key: string; label: string; color: string | null; level: number; isActive: boolean }[];
  /** Security tickets opened per day by severity key (plus `unclassified`). */
  seriesBySeverity: ({ day: string } & Record<string, number | string>)[];
  /** Opened, resolved, MTTA, MTTR and breaches per severity over the period (ids so the rows drill down). */
  responsivenessBySeverity: { id: string | null; label: string; key: string | null; color: string | null; level: number; opened: number; resolved: number; mttaMinutes: number | null; mttrMinutes: number | null; breached: number }[];
  siemEvents7d: { total: number; ticketsCreated: number; bySeverity: { severity: string; count: number; ticketed: number }[]; byDay: { day: string; count: number; ticketed: number }[] };
  ageing: AgeBucket[];
  arrivals: Arrivals;
  bySeverity: Breakdown[];
  byCategory: Breakdown[];
  byCustomer: { id: string; name: string; code: string; open: number; critical_high: number; breached: number }[];
  slaStatus: { atRisk: number; breached: number; items: TicketRow[] };
  escalations: { count: number; items: TicketRow[] };
  siemEvents24h: { total: number; ticketsCreated: number; bySeverity: { severity: string; count: number; ticketed: number }[] };
  recent: TicketRow[];
  mttrSecurity30d: { resolved: number; opened: number; mttrMinutes: number | null; responseMinutes: number | null };
  period: { days: number; from: string; to: string };
  /** Security-domain tickets opened, resolved and SLA-breached per day over the period. */
  series: { day: string; opened: number; resolved: number; breaches: number }[];
  onCall?: OnCallSummaryTeam[];
}

/** The SOC payload for the scope; the page (Updated stamp) and the dashboard share one query. `enabled` is false without soc:read. */
export function useSocDashboard({ days, customerId }: { days: number; customerId: string }, enabled = true) {
  return useQuery({ queryKey: ['dashboards', 'soc', days, customerId], queryFn: () => get<Soc>('/dashboards/soc', { days, customerId: customerId || undefined }), refetchInterval: 60_000, placeholderData: (p) => p, enabled });
}

type FlowView = 'flow' | 'severity' | 'breaches';
type CustView = 'top' | 'all';
const FLOW_VIEWS: readonly FlowView[] = ['flow', 'severity', 'breaches'];
const CUST_VIEWS: readonly CustView[] = ['top', 'all'];

/**
 * Security operations: the security domain only, under the hero's period and
 * customer scope. Every tile, bar, slice and row opens the ticket list with the
 * same predicates (customer, the security domain, the severity, the state);
 * the controls in a panel header live in the URL (`flow=`, `cust=`, `events=`,
 * `heat=`) and change that panel alone.
 */
export function SocDashboard({ days = 30, customerId = '' }: { days?: number; customerId?: string }) {
  const [flowView, setFlowView] = useLocalControl<FlowView>('flow', 'flow', FLOW_VIEWS);
  const [custView, setCustView] = useLocalControl<CustView>('cust', 'top', CUST_VIEWS);
  const [eventsView, setEventsView] = useLocalControl<EventsView>('events', '24h', EVENTS_VIEWS);
  const [heatView, setHeatView] = useLocalControl<HeatView>('heat', 'week', HEAT_VIEWS);
  const theme = useChartTheme();
  const q = useSocDashboard({ days, customerId });
  const d = q.data;
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
  const t = d.totals;
  // Every link carries the customer scope and the security domain; critical/high is the severities at level 1 and 2.
  const scope: TicketListLink = { customerId: customerId || null, domain: 'soc' };
  const soc: TicketListLink = { ...scope, status: 'any' };
  const open: TicketListLink = { ...scope, status: 'open' };
  const criticalIds = t.criticalHighSeverityIds;
  const recent = d.series.slice(-14);
  const flow = d.series.some((s) => s.opened || s.resolved) ? d.series : [];
  const period = { createdFrom: d.period.from, createdTo: d.period.to };
  const resolvedIn = { resolvedFrom: d.period.from, resolvedTo: d.period.to };
  const sevById = new Map(d.severities.map((s) => [s.key, s]));
  // A severity bar opens that day's tickets of that severity; "unclassified" has no id and no door.
  const severityHref = (point: Record<string, unknown>, key: string) => {
    const sev = sevById.get(key);
    const day = typeof point.day === 'string' ? point.day : undefined;
    return sev && day ? ticketListPath({ ...soc, severityIds: [sev.id], createdFrom: day, createdTo: day }) : undefined;
  };
  const flowSubtitle = { flow: 'Opened and resolved per day; a bar opens that day’s incidents', severity: 'Opened per day, stacked by severity; a bar opens that day’s incidents of that severity', breaches: 'SLA clocks breached per day' }[flowView];
  const customers = custView === 'all' ? d.byCustomer : d.byCustomer.slice(0, 6);
  return (
    <div className="flex flex-col gap-6">
      <KpiGrid
        items={[
          { label: 'Open security incidents', value: fmtNumber(t.open), icon: <ShieldAlert className="h-4 w-4" />, hint: `${fmtNumber(t.openedToday)} opened today · ${fmtNumber(t.unassigned)} unassigned`, spark: recent.map((s) => s.opened), sparkLabel: 'Security incidents opened per day, last 14 days', to: ticketListPath(open) },
          { label: 'Critical / high', value: fmtNumber(t.criticalHigh), icon: <Siren className="h-4 w-4" />, tone: t.criticalHigh > 0 ? 'bad' : 'good', hint: `${fmtNumber(t.escalated)} escalated`, to: criticalIds.length ? ticketListPath({ ...open, severityIds: criticalIds }) : undefined },
          { label: 'SLA at risk', value: fmtNumber(t.atRisk + t.breached), icon: <Timer className="h-4 w-4" />, tone: t.breached > 0 ? 'bad' : t.atRisk > 0 ? 'warn' : 'good', hint: `${fmtNumber(t.breached)} breached · ${fmtNumber(t.atRisk)} at risk`, spark: recent.map((s) => s.breaches), sparkLabel: 'Security SLA breaches per day, last 14 days', to: ticketListPath({ ...open, sla: ['at_risk', 'breached'] }) },
          { label: 'SIEM events · 24h', value: fmtNumber(d.siemEvents24h.total), icon: <Radio className="h-4 w-4" />, hint: `${fmtNumber(d.siemEvents24h.ticketsCreated)} became tickets` },
        ]}
      />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Security incident flow" subtitle={`${flowSubtitle} · ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}`} className="xl:col-span-2" to={ticketListPath({ ...soc, ...period })} toLabel="Opened in the period" action={<Segmented size="sm" options={[{ value: 'flow', label: 'Flow' }, { value: 'severity', label: 'By severity' }, { value: 'breaches', label: 'Breaches' }]} value={flowView} onChange={setFlowView} />}>
          {flowView === 'flow' && <TrendChart data={flow} x="day" kind="bar" height={230} series={[{ key: 'opened', label: 'Opened' }, { key: 'resolved', label: 'Resolved', color: STATUS_COLORS.good }]} pointHref={flowPointHref(scope, { opened: 'created', resolved: 'resolved' })} />}
          {flowView === 'severity' && <TrendChart data={flow.length ? d.seriesBySeverity : []} x="day" kind="bar" stacked height={230} series={[...d.severities.map((s, i) => ({ key: s.key, label: s.label, color: optionHex(s.color, theme.dark, theme.series[Math.min(i, theme.series.length - 1)]!) })), { key: 'unclassified', label: 'Unclassified', color: theme.deemphasis }]} pointHref={severityHref} />}
          {flowView === 'breaches' && <TrendChart data={d.series.some((s) => s.breaches) ? d.series : []} x="day" kind="bar" height={230} series={[{ key: 'breaches', label: 'SLA breaches', color: STATUS_COLORS.critical }]} />}
        </Panel>
        <Panel title="Open by severity" subtitle="Open security incidents now; a slice opens the list" to={ticketListPath(open)} toLabel="All open">
          <DonutChart size={140} centerLabel="open" emptyText="No open security incidents" slices={d.bySeverity.map((s) => ({ key: s.id ?? s.label, label: s.label, value: s.count, color: s.color, href: s.id ? ticketListPath({ ...open, severityIds: [s.id] }) : undefined }))} />
        </Panel>
      </div>
      <Panel title="Response by severity" subtitle={`Security incidents opened or resolved ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}: time to first response and to resolve, and the breaches among them`} to={ticketListPath({ ...soc, ...resolvedIn })} toLabel="Resolved in the period">
        <RateTable
          columns={['Severity', 'Opened', 'Resolved', 'First response', 'Resolution', 'Breached']}
          empty="No security incidents opened or resolved in this period"
          rows={d.responsivenessBySeverity
            .filter((r) => r.opened > 0 || r.resolved > 0)
            .map((r) => ({
              key: r.id ?? r.label,
              label: r.label,
              color: r.color,
              cells: [
                { value: fmtNumber(r.opened), href: r.id ? ticketListPath({ ...soc, severityIds: [r.id], ...period }) : undefined },
                { value: fmtNumber(r.resolved), href: r.id ? ticketListPath({ ...soc, severityIds: [r.id], ...resolvedIn }) : undefined },
                { value: fmtDuration(r.mttaMinutes), tone: r.mttaMinutes === null ? 'muted' : 'default' },
                { value: fmtDuration(r.mttrMinutes), tone: r.mttrMinutes === null ? 'muted' : 'default' },
                { value: fmtNumber(r.breached), tone: r.breached > 0 ? 'bad' : 'muted', href: r.id ? ticketListPath({ ...soc, severityIds: [r.id], sla: 'breached', ...period }) : undefined },
              ],
            }))}
        />
      </Panel>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Recent security incidents" subtitle="Newest first" to={ticketListPath(soc)} toLabel="All security incidents" padded={false} className="xl:col-span-2">
          <div className="px-5">
            <TicketMiniTable rows={d.recent} max={8} columns={['customer', 'severity', 'status', 'sla', 'assignee']} empty="No security incidents recorded" />
          </div>
        </Panel>
        <Panel title="Escalations" subtitle={`${fmtNumber(d.escalations.count)} open ${d.escalations.count === 1 ? 'incident' : 'incidents'} escalated beyond level 1`}>
          <RowList
            dense
            empty="No active escalations"
            items={d.escalations.items.slice(0, 6).map((t) => ({
              key: t.id,
              href: `/tickets/${t.id}`,
              leading: <Badge color={t.severity_color ?? 'slate'}>{t.severity ?? 'Unclassified'}</Badge>,
              primary: `${t.number} · ${t.title}`,
              secondary: `${t.customer_name ?? ''}${t.assignee ? ` · ${t.assignee}` : ' · unassigned'}`,
              right: <Badge color="orange">Esc {t.escalation_level}</Badge>,
            }))}
          />
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <ArrivalsPanel arrivals={d.arrivals} link={scope} view={heatView} onView={setHeatView} className="xl:col-span-2" title="When security incidents arrive" />
        <AgeingPanel ageing={d.ageing} link={open} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <EventsPanel title="SIEM events" source="SIEM" last24h={d.siemEvents24h} last7d={d.siemEvents7d} view={eventsView} onView={setEventsView} />
        <Panel title="By customer" subtitle="Open security incidents per customer; a row opens their list" action={d.byCustomer.length > 6 ? <Segmented size="sm" options={[{ value: 'top', label: 'Top 6' }, { value: 'all', label: `All ${d.byCustomer.length}` }]} value={custView} onChange={setCustView} /> : undefined}>
          <RowList
            empty="No open security incidents"
            dense
            items={customers.map((c) => ({
              key: c.id,
              href: ticketListPath({ ...open, customerId: c.id }),
              primary: c.name,
              secondary: `${fmtNumber(c.critical_high)} critical/high`,
              right: (
                <span className="inline-flex items-center gap-2">
                  {c.breached > 0 && <Badge color="red">{c.breached} breached</Badge>}
                  <span className="text-default font-medium">{fmtNumber(c.open)}</span>
                </span>
              ),
            }))}
          />
        </Panel>
        <OnCallPanel items={d.onCall ?? []} />
      </div>
    </div>
  );
}
