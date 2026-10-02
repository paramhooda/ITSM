import { useQuery } from '@tanstack/react-query';
import { ErrorBlock } from '@/components/ui';
import { get } from '@/api/client';
import { fmtNumber } from '@/lib/format';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { TicketMiniTable } from './TicketMiniTable';
import { WorkloadList, type WorkloadItem } from './WorkloadList';
import { Panel, KpiSkeleton, Stat, Updated } from './Panel';
import type { TicketRow, Breakdown } from './types';

interface Noc {
  generatedAt: string;
  totals: { open: number; openIncidents: number; breached: number; atRisk: number; unassigned: number; major: number; escalated: number; openedToday: number; resolvedToday: number; mttrTodayMinutes: number | null };
  openIncidents: Breakdown[];
  criticalOpen: TicketRow[];
  slaAtRisk: { atRisk: number; breached: number; items: TicketRow[] };
  unassigned: { count: number; items: TicketRow[] };
  byCategory: Breakdown[];
  monitoringEvents24h: { total: number; ticketsCreated: number; bySeverity: { severity: string; count: number; ticketed: number }[] };
  engineerWorkload: WorkloadItem[];
  recentlyResolved: TicketRow[];
  aging: { bucket: string; count: number }[];
  series: { day: string; opened: number; incidents: number; security: number; resolved: number; breaches: number }[];
}

export function NocDashboard() {
  const q = useQuery({ queryKey: ['dashboards', 'noc'], queryFn: () => get<Noc>('/dashboards/noc'), refetchInterval: 60_000, placeholderData: (p) => p });
  const d = q.data;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d) return <KpiSkeleton />;
  const t = d.totals;
  const p1p2 = d.openIncidents.filter((p) => (p.level ?? 99) <= 2).reduce((s, p) => s + p.count, 0);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between -mt-2">
        <span className="text-[12.5px] text-muted">Live view of infrastructure incidents · refreshes every minute</span>
        <Updated at={d.generatedAt} fetching={q.isFetching} />
      </div>
      <KpiGrid
        items={[
          { label: 'Open incidents', value: fmtNumber(t.openIncidents), hint: `${fmtNumber(t.openedToday)} opened · ${fmtNumber(t.resolvedToday)} resolved today`, spark: d.series.map((s) => s.incidents), sparkLabel: 'Incidents opened per day, last 14 days', onClick: () => (window.location.href = '/tickets?type=incident&open=true') },
          { label: 'P1 / P2 open', value: fmtNumber(p1p2), tone: p1p2 > 0 ? 'bad' : 'good', hint: `${fmtNumber(t.major)} major · ${fmtNumber(t.escalated)} escalated` },
          { label: 'SLA at risk', value: fmtNumber(t.atRisk), tone: t.atRisk > 0 ? 'warn' : 'good', hint: `${fmtNumber(t.breached)} already breached`, spark: d.series.map((s) => s.breaches), sparkLabel: 'SLA breaches per day, last 14 days', onClick: () => (window.location.href = '/tickets?open=true&slaState=breached') },
          { label: 'Unassigned', value: fmtNumber(t.unassigned), tone: t.unassigned > 0 ? 'warn' : 'default', hint: 'waiting for an owner', onClick: () => (window.location.href = '/tickets?open=true&unassigned=true') },
        ]}
      />
      <Panel title="Critical and major incidents" subtitle="P1, P2 and major tickets ordered by priority" to="/tickets?open=true&priorityId=&type=incident" toLabel="All incidents" padded={false}>
        <div className="px-5">
          <TicketMiniTable rows={d.criticalOpen} max={8} columns={['customer', 'priority', 'ci', 'status', 'sla', 'assignee']} empty="No P1/P2 or major incidents open" />
        </div>
      </Panel>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Ticket aging" subtitle="How long open tickets have been waiting" className="xl:col-span-1">
          <TrendChart data={d.aging} x="bucket" kind="bar" series={[{ key: 'count', label: 'Open tickets' }]} height={170} xFormatter={(v) => v} />
          <div className="mt-4 pt-4 border-t border-default grid grid-cols-3 gap-3">
            <Stat label="PRTG events · 24h" value={fmtNumber(d.monitoringEvents24h.total)} />
            <Stat label="Tickets from monitoring" value={fmtNumber(d.monitoringEvents24h.ticketsCreated)} />
            <Stat label="Ticket rate" value={d.monitoringEvents24h.total ? `${Math.round((d.monitoringEvents24h.ticketsCreated / d.monitoringEvents24h.total) * 100)}%` : '—'} />
          </div>
        </Panel>
        <Panel title="At risk or breached" subtitle="Soonest SLA deadline first" to="/tickets?open=true&slaState=breached" toLabel="All breached" padded={false}>
          <div className="px-5">
            <TicketMiniTable rows={d.slaAtRisk.items} max={6} columns={['customer', 'priority', 'sla']} empty="Every open ticket is within SLA" />
          </div>
        </Panel>
        <Panel title="Engineer load" subtitle="Open tickets per engineer in NOC, infrastructure and network teams">
          <WorkloadList items={d.engineerWorkload.slice(0, 8)} />
        </Panel>
      </div>
      <Panel title="Open by category" subtitle="NOC categories, breaches in red" to="/tickets?open=true" toLabel="All open">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <BreakdownBar items={d.byCategory.slice(0, 5).map((c) => ({ label: c.label, value: c.count, secondary: c.breached, href: c.id ? `/tickets?open=true&categoryId=${c.id}` : undefined }))} emptyText="No open NOC tickets" />
          <BreakdownBar items={d.byCategory.slice(5, 10).map((c) => ({ label: c.label, value: c.count, secondary: c.breached, href: c.id ? `/tickets?open=true&categoryId=${c.id}` : undefined }))} emptyText="" max={Math.max(1, ...d.byCategory.map((c) => c.count))} />
        </div>
      </Panel>
    </div>
  );
}
