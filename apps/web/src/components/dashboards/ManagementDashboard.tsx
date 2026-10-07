import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, ErrorBlock, Select } from '@/components/ui';
import { Inbox, ShieldCheck, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { get } from '@/api/client';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDuration, fmtNumber, fmtPct } from '@/lib/format';
import { truncate } from '@/lib/utils';
import { fmtRating, ratingTone } from '@/components/surveys/api';
import { ticketListPath, type TicketListLink } from '@itsm/shared';
import { RatingBadge } from '@/components/surveys/RatingBadge';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { SlaGauge } from './SlaGauge';
import { EntitlementAlerts, type EntitlementAlert } from './EntitlementAlerts';
import { ExpiringContracts, type ExpiringContract } from './ExpiringContracts';
import { Panel, Skeleton, KpiSkeleton, Stat, Segmented, RowList } from './Panel';
import type { Delta } from './types';

interface Management {
  period: { days: number; from: string; to: string };
  kpis: Record<string, number | null>;
  series: { day: string; opened: number; resolved: number; closed: number; breaches: number; outOfScope: number; mttrMinutes: number | null; resolutionMet: number; resolutionBreached: number; compliancePct: number | null }[];
  byService: { id: string | null; name: string; tickets: number; resolved: number; breaches: number; out_of_scope: number }[];
  byCustomer: { id: string; name: string; code: string; tickets: number; resolved: number; out_of_scope: number; major: number; slaMet: number; slaBreached: number; compliancePct: number | null }[];
  outOfScopeByCustomer: { id: string; name: string; code: string; out_of_scope: number; unknown_scope: number; minutes: number }[];
  entitlementAlerts: EntitlementAlert[];
  expiringContracts: ExpiringContract[];
  expiringContractsTotal: number;
  trends: Record<string, Delta>;
  /** Customer satisfaction in the period: the figures, the weekly average and the lowest-rated tickets. */
  csat?: {
    avg: number | null;
    satisfiedPct: number | null;
    responseRate: number | null;
    responses: number;
    sent: number;
    low: number;
    series: { week: string; responses: number; avg: number | null }[];
    lowest: { ticketId: string; number: string; title: string; customerName: string | null; rating: number; comment: string | null; answeredAt: string; assigneeName: string | null }[];
    previous: { avg: number | null; responses: number };
    trendAvg: Delta | null;
  };
}

const tail = <T,>(arr: T[], n: number) => arr.slice(Math.max(0, arr.length - n));

type AttentionSort = 'breaches' | 'major' | 'scope';

export function ManagementDashboard({ days, customerId }: { days: number; customerId: string }) {
  // Local chart filters: client-side views of data already on the page (the period and scope are global).
  const [flowView, setFlowView] = useState<'flow' | 'breaches'>('flow');
  const [attentionSort, setAttentionSort] = useState<AttentionSort>('breaches');
  const [allServices, setAllServices] = useState(false);
  const q = useQuery({ queryKey: ['dashboards', 'management', days, customerId], queryFn: () => get<Management>('/dashboards/management', { days, customerId: customerId || undefined }), placeholderData: (p) => p, staleTime: 30_000 });
  const d = q.data;
  const k = d?.kpis ?? {};
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d) return <KpiSkeleton />;
  const compliance = k.slaCompliancePct;
  const needsAttention = [...d.byCustomer].filter((c) => c.slaBreached > 0 || c.out_of_scope > 0 || c.major > 0).sort((a, b) => b.slaBreached - a.slaBreached || b.major - a.major || b.out_of_scope - a.out_of_scope).slice(0, 5);
  // Sorted copy for the local control; computed after the early returns, so no hook here.
  const attentionRows = [...needsAttention].sort((a, b) => (attentionSort === 'major' ? b.major - a.major || b.slaBreached - a.slaBreached : attentionSort === 'scope' ? b.out_of_scope - a.out_of_scope || b.slaBreached - a.slaBreached : b.slaBreached - a.slaBreached || b.major - a.major));
  // Every number that links carries the predicates it was counted with (scope, SLA state, the period as a date range).
  const scope: TicketListLink = { customerId: customerId || null };
  const open: TicketListLink = { ...scope, status: 'open' };
  const inPeriod: TicketListLink = { ...scope, status: 'any', createdFrom: d.period.from, createdTo: d.period.to };
  const sparkDays = Math.min(d.series.length, days <= 7 ? 7 : 14);
  const recent = tail(d.series, sparkDays);
  const complianceTone = compliance === null ? 'default' : (compliance ?? 0) >= 95 ? 'good' : (compliance ?? 0) >= 85 ? 'warn' : 'bad';
  return (
    <div className="flex flex-col gap-6">
      <KpiGrid
        items={[
          {
            label: 'Open tickets',
            value: fmtNumber(k.openNow),
            icon: <Inbox className="h-4 w-4" />,
            hint: `${fmtNumber(k.openedToday)} opened today · ${fmtNumber(k.resolvedToday)} resolved`,
            spark: recent.map((s) => s.opened),
            sparkLabel: `Tickets opened per day, last ${sparkDays} days`,
            to: ticketListPath(open),
          },
          {
            label: `SLA compliance · ${days}d`,
            value: fmtPct(compliance, 1),
            icon: <ShieldCheck className="h-4 w-4" />,
            delta: d.trends.slaCompliancePct,
            tone: complianceTone,
            hint: `${fmtNumber(k.resolutionMet)} met · ${fmtNumber(k.resolutionBreached)} breached`,
            spark: recent.map((s) => s.compliancePct),
            sparkLabel: `Daily resolution SLA compliance, last ${sparkDays} days`,
          },
          {
            label: 'Breached SLAs · open now',
            value: fmtNumber(k.breachedOpen),
            icon: <AlertTriangle className="h-4 w-4" />,
            tone: (k.breachedOpen ?? 0) > 0 ? 'bad' : 'good',
            delta: d.trends.breaches,
            lowerIsBetter: true,
            hint: `${fmtNumber(k.slaBreaches)} in period`,
            spark: recent.map((s) => s.breaches),
            sparkLabel: `SLA breaches per day, last ${sparkDays} days`,
            to: ticketListPath({ ...open, sla: 'breached' }),
          },
          {
            label: `Resolved · ${days}d`,
            value: fmtNumber(k.ticketsResolved),
            icon: <CheckCircle2 className="h-4 w-4" />,
            delta: d.trends.resolved,
            hint: `${fmtDuration(k.mttrMinutes)} mean time to resolve`,
            spark: recent.map((s) => s.resolved),
            sparkLabel: `Tickets resolved per day, last ${sparkDays} days`,
            to: ticketListPath({ ...scope, status: 'any', resolvedFrom: d.period.from, resolvedTo: d.period.to }),
          },
        ]}
      />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel className="xl:col-span-2 rise-in rise-in-2" title="Ticket flow" subtitle={`${flowView === 'flow' ? 'Opened and resolved' : 'SLA breaches'} per day, ${d.period.from} to ${d.period.to}`} to={`/reports?tab=run&report=ticket_volume`} toLabel="Ticket volume report" action={<Segmented size="sm" options={[{ value: 'flow', label: 'Flow' }, { value: 'breaches', label: 'Breaches' }]} value={flowView} onChange={setFlowView} />}>
          {flowView === 'flow' ? (
            <TrendChart data={d.series} x="day" kind="area" series={[{ key: 'opened', label: 'Opened' }, { key: 'resolved', label: 'Resolved', color: '#0f9d6f' }]} height={250} />
          ) : (
            <TrendChart data={d.series} x="day" kind="bar" series={[{ key: 'breaches', label: 'SLA breaches', color: '#dc2626' }]} height={250} />
          )}
        </Panel>
        <Panel className="rise-in rise-in-3" title="Service levels" subtitle="Resolution targets in the period" to={`/reports?tab=run&report=sla_performance`} toLabel="SLA report">
          <SlaGauge pct={compliance} met={k.resolutionMet ?? 0} breached={k.resolutionBreached ?? 0} />
          <div className="mt-5 pt-4 border-t border-default grid grid-cols-2 gap-x-4 gap-y-4">
            <Stat label="Mean time to resolve" value={fmtDuration(k.mttrMinutes)} />
            <Stat label="First response" value={fmtDuration(k.firstResponseMinutes)} />
            <Stat label="Major incidents" value={fmtNumber(k.majorIncidents)} tone={(k.majorOpen ?? 0) > 0 ? 'bad' : 'default'} />
            <Stat label="Out of scope" value={fmtNumber(k.outOfScopeCount)} tone={(k.outOfScopeCount ?? 0) > 0 ? 'warn' : 'default'} />
            <Stat label="AMC utilization" value={fmtPct(k.amcUtilizationPct)} />
            <Stat label="PM on time" value={fmtPct(k.pmOnTimePct)} tone={(k.pmMissed ?? 0) > 0 ? 'warn' : 'default'} />
            <Stat label="Known errors open" value={fmtNumber(k.knownErrorsOpen)} tone={(k.knownErrorsOpen ?? 0) > 0 ? 'warn' : 'default'} />
            <Stat label="Known errors published" value={fmtNumber(k.knownErrorsPublished)} />
            <Stat label="Customer satisfaction" value={fmtRating(k.csatAvg)} tone={ratingTone(k.csatAvg)} />
            <Stat label="Survey response rate" value={fmtPct(k.csatResponseRate)} />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Panel className="rise-in rise-in-3" title="Needs attention" subtitle="Customers with breaches, major incidents or out-of-scope work" to={`/reports?tab=run&report=sla_performance`} toLabel="SLA report" padded action={<Segmented size="sm" options={[{ value: 'breaches', label: 'Breaches' }, { value: 'major', label: 'Major' }, { value: 'scope', label: 'Out of scope' }]} value={attentionSort} onChange={setAttentionSort} />}>
          <RowList
            empty="No customer needs attention right now"
            items={attentionRows.map((c) => ({
              key: c.id,
              href: `/customers/${c.id}`,
              primary: c.name,
              secondary: `${fmtNumber(c.tickets)} tickets · ${fmtNumber(c.major)} major · ${fmtNumber(c.out_of_scope)} out of scope`,
              right: (
                <span className="inline-flex items-center gap-2">
                  {c.slaBreached > 0 && <span className="text-red-600 font-medium">{c.slaBreached} breached</span>}
                  {c.compliancePct !== null && <Badge color={c.compliancePct >= 95 ? 'green' : c.compliancePct >= 85 ? 'amber' : 'red'}>{c.compliancePct}%</Badge>}
                </span>
              ),
            }))}
          />
        </Panel>
        <Panel className="rise-in rise-in-3" title="Service health" subtitle="Tickets by service in the period, breaches in red" to="/services" toLabel="Service catalog" action={d.byService.length > 6 ? <Segmented size="sm" options={[{ value: 'top', label: 'Top 6' }, { value: 'all', label: `All ${d.byService.length}` }]} value={allServices ? 'all' : 'top'} onChange={(v) => setAllServices(v === 'all')} /> : undefined}>
          <BreakdownBar items={d.byService.slice(0, allServices ? undefined : 6).map((s) => ({ label: s.name, value: s.tickets, secondary: s.breaches, href: s.id ? ticketListPath({ ...inPeriod, serviceId: s.id }) : undefined }))} emptyText="No tickets in this period" />
        </Panel>
        <Panel className="rise-in rise-in-4" title="Expiring contracts" subtitle={`${fmtNumber(d.expiringContractsTotal)} ending within 90 days · ${fmtNumber(k.contractsActive)} active`} to="/contracts?expiringWithinDays=90">
          <ExpiringContracts items={d.expiringContracts.slice(0, 5)} />
        </Panel>
        <Panel className="rise-in rise-in-4" title="Entitlements near limit" subtitle="AMC visits and hours over their warning threshold" to="/reports?tab=run&report=amc_utilization" toLabel="Utilization report">
          <EntitlementAlerts items={d.entitlementAlerts.slice(0, 5)} />
        </Panel>
        {d.csat && (
          <Panel className="rise-in rise-in-4 xl:col-span-2" title="Customer satisfaction" subtitle={`Average rating per week and the lowest-rated tickets · ${fmtNumber(d.csat.responses)} ${d.csat.responses === 1 ? 'response' : 'responses'} from ${fmtNumber(d.csat.sent)} surveys, ${fmtPct(d.csat.satisfiedPct)} satisfied`} to="/reports/csat" toLabel="Customer satisfaction">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <TrendChart data={d.csat.series.some((p) => p.responses) ? d.csat.series : []} x="week" kind="line" series={[{ key: 'avg', label: 'Average rating', color: '#0f9d6f' }]} height={200} yDomain={[1, 5]} yTicks={[1, 2, 3, 4, 5]} yFormatter={(v) => String(v)} valueFormatter={(v) => `${v.toFixed(1)}/5`} />
              <RowList
                dense
                empty="No ratings in this period"
                items={d.csat.lowest.map((l) => ({ key: l.ticketId, href: `/tickets/${l.ticketId}`, primary: `${l.number} · ${l.title}`, secondary: `${l.customerName ?? ''}${l.assigneeName ? ` · ${l.assigneeName}` : ''}${l.comment ? ` · “${truncate(l.comment, 90)}”` : ''}`, right: <RatingBadge rating={l.rating} /> }))}
              />
            </div>
          </Panel>
        )}
      </div>
      <div className="text-[12px] text-subtle">
        Looking for more? <Link to="/reports" className="text-default font-medium hover:underline">Reports</Link> cover incidents, SLA, AMC utilization, out-of-scope activity and more.
      </div>
    </div>
  );
}
export { Skeleton as ManagementSkeleton };
