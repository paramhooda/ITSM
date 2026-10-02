import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, LoadingBlock, ErrorBlock } from '@/components/ui';
import { get } from '@/api/client';
import { fmtDuration, fmtNumber, relativeTime } from '@/lib/format';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { TicketMiniTable } from './TicketMiniTable';
import { WorkloadList, type WorkloadItem } from './WorkloadList';
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
}

export function NocDashboard() {
  const q = useQuery({ queryKey: ['dashboards', 'noc'], queryFn: () => get<Noc>('/dashboards/noc'), refetchInterval: 60_000, placeholderData: (p) => p });
  const d = q.data;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d) return <LoadingBlock />;
  const t = d.totals;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between text-[12px] text-subtle">
        <span>Live operations view · refreshes every minute</span>
        <span>Updated {relativeTime(d.generatedAt)}</span>
      </div>
      <KpiGrid
        items={[
          { label: 'Open tickets', value: fmtNumber(t.open), hint: `${fmtNumber(t.openIncidents)} incidents`, onClick: () => (window.location.href = '/tickets?open=true') },
          { label: 'SLA breached', value: fmtNumber(t.breached), tone: t.breached > 0 ? 'bad' : 'good', hint: 'open tickets' },
          { label: 'SLA at risk', value: fmtNumber(t.atRisk), tone: t.atRisk > 0 ? 'warn' : 'good', hint: 'warning threshold passed' },
          { label: 'Unassigned', value: fmtNumber(t.unassigned), tone: t.unassigned > 0 ? 'warn' : 'default' },
          { label: 'Major / escalated', value: `${fmtNumber(t.major)} / ${fmtNumber(t.escalated)}`, tone: t.major > 0 ? 'bad' : 'default' },
          { label: 'Today', value: `${fmtNumber(t.openedToday)} / ${fmtNumber(t.resolvedToday)}`, hint: `opened / resolved · MTTR ${fmtDuration(t.mttrTodayMinutes)}` },
        ]}
      />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Open incidents by priority" actions={<span className="text-[11px] text-subtle">count (breached)</span>}>
          <BreakdownBar items={d.openIncidents.map((p) => ({ label: p.label, value: p.count, secondary: p.breached, color: p.color, href: p.id ? `/tickets?type=incident&open=true&priorityId=${p.id}` : undefined }))} emptyText="No open incidents" />
        </Card>
        <Card title="Ticket aging (open)">
          <TrendChart data={d.aging} x="bucket" kind="bar" series={[{ key: 'count', label: 'Open tickets' }]} height={180} xFormatter={(v) => v} />
        </Card>
        <Card title="Monitoring events (24h)" actions={<Link to="/integrations" className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">Events</Link>}>
          <KpiGrid columns={3} items={[{ label: 'PRTG events', value: fmtNumber(d.monitoringEvents24h.total) }, { label: 'Tickets created', value: fmtNumber(d.monitoringEvents24h.ticketsCreated) }, { label: 'Ticket rate', value: d.monitoringEvents24h.total ? `${Math.round((d.monitoringEvents24h.ticketsCreated / d.monitoringEvents24h.total) * 100)}%` : '—' }]} />
          <div className="mt-3">
            <BreakdownBar dense items={d.monitoringEvents24h.bySeverity.map((s) => ({ label: s.severity, value: s.count, secondary: s.ticketed, secondaryLabel: 'ticketed' }))} emptyText="No events received in the last 24 hours" />
          </div>
        </Card>
      </div>
      <Card title={`Critical and major open tickets (${d.criticalOpen.length})`}>
        <TicketMiniTable rows={d.criticalOpen} columns={['customer', 'priority', 'ci', 'status', 'sla', 'assignee', 'age']} empty="No P1/P2 or major tickets open" />
      </Card>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title={`SLA at risk and breached (${d.slaAtRisk.atRisk + d.slaAtRisk.breached})`} actions={<Link to="/tickets?open=true&slaState=breached" className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">All breached</Link>}>
          <TicketMiniTable rows={d.slaAtRisk.items} columns={['customer', 'priority', 'sla', 'assignee']} empty="All open tickets are within SLA" />
        </Card>
        <Card title={`Unassigned (${d.unassigned.count})`} actions={<Link to="/tickets?open=true&unassigned=true" className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">Queue</Link>}>
          <TicketMiniTable rows={d.unassigned.items} columns={['customer', 'priority', 'category', 'age']} empty="Nothing waiting for assignment" />
        </Card>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Open by category (NOC)">
          <BreakdownBar items={d.byCategory.map((c) => ({ label: c.label, value: c.count, secondary: c.breached, href: c.id ? `/tickets?open=true&categoryId=${c.id}` : undefined }))} emptyText="No open NOC tickets" />
        </Card>
        <Card title="Engineer workload" actions={<span className="text-[11px] text-subtle">NOC · infrastructure · network</span>}>
          <WorkloadList items={d.engineerWorkload} />
        </Card>
        <Card title="Recently resolved">
          <TicketMiniTable rows={d.recentlyResolved} columns={['customer', 'priority', 'resolved']} empty="Nothing resolved yet" />
        </Card>
      </div>
    </div>
  );
}
