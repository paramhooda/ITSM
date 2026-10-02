import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, LoadingBlock, ErrorBlock } from '@/components/ui';
import { get } from '@/api/client';
import { fmtDuration, fmtNumber, relativeTime } from '@/lib/format';
import { KpiGrid } from './KpiGrid';
import { BreakdownBar } from './BreakdownBar';
import { TicketMiniTable } from './TicketMiniTable';
import type { TicketRow, Breakdown } from './types';

interface Soc {
  generatedAt: string;
  totals: { open: number; breached: number; atRisk: number; escalated: number; unassigned: number; openedToday: number; criticalHigh: number };
  bySeverity: Breakdown[];
  byCategory: Breakdown[];
  byCustomer: { id: string; name: string; code: string; open: number; critical_high: number; breached: number }[];
  slaStatus: { atRisk: number; breached: number; items: TicketRow[] };
  escalations: { count: number; items: TicketRow[] };
  siemEvents24h: { total: number; ticketsCreated: number; bySeverity: { severity: string; count: number; ticketed: number }[] };
  recent: TicketRow[];
  mttrSecurity30d: { resolved: number; opened: number; mttrMinutes: number | null; responseMinutes: number | null };
}

export function SocDashboard() {
  const q = useQuery({ queryKey: ['dashboards', 'soc'], queryFn: () => get<Soc>('/dashboards/soc'), refetchInterval: 60_000, placeholderData: (p) => p });
  const d = q.data;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d) return <LoadingBlock />;
  const t = d.totals;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between text-[12px] text-subtle">
        <span>Security operations · refreshes every minute</span>
        <span>Updated {relativeTime(d.generatedAt)}</span>
      </div>
      <KpiGrid
        items={[
          { label: 'Open security tickets', value: fmtNumber(t.open), hint: `${fmtNumber(t.openedToday)} opened today` },
          { label: 'Critical / high', value: fmtNumber(t.criticalHigh), tone: t.criticalHigh > 0 ? 'bad' : 'good' },
          { label: 'SLA breached', value: fmtNumber(t.breached), tone: t.breached > 0 ? 'bad' : 'good', hint: `${fmtNumber(t.atRisk)} at risk` },
          { label: 'Escalated', value: fmtNumber(t.escalated), tone: t.escalated > 0 ? 'warn' : 'default' },
          { label: 'Unassigned', value: fmtNumber(t.unassigned), tone: t.unassigned > 0 ? 'warn' : 'default' },
          { label: 'MTTR (30d)', value: fmtDuration(d.mttrSecurity30d.mttrMinutes), hint: `${fmtNumber(d.mttrSecurity30d.resolved)} resolved · response ${fmtDuration(d.mttrSecurity30d.responseMinutes)}` },
        ]}
      />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Open by severity" actions={<span className="text-[11px] text-subtle">count (breached)</span>}>
          <BreakdownBar items={d.bySeverity.map((s) => ({ label: s.label, value: s.count, secondary: s.breached, color: s.color, href: s.id ? `/tickets?domain=soc&open=true&securitySeverityId=${s.id}` : undefined }))} emptyText="No open security tickets" />
        </Card>
        <Card title="Open by category (SOC)">
          <BreakdownBar items={d.byCategory.map((c) => ({ label: c.label, value: c.count, href: c.id ? `/tickets?domain=soc&open=true&categoryId=${c.id}` : undefined }))} emptyText="No open security tickets" />
        </Card>
        <Card title="SIEM events (24h)" actions={<Link to="/integrations" className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">Events</Link>}>
          <KpiGrid columns={3} items={[{ label: 'FortiSIEM events', value: fmtNumber(d.siemEvents24h.total) }, { label: 'Tickets created', value: fmtNumber(d.siemEvents24h.ticketsCreated) }, { label: 'Ticket rate', value: d.siemEvents24h.total ? `${Math.round((d.siemEvents24h.ticketsCreated / d.siemEvents24h.total) * 100)}%` : '—' }]} />
          <div className="mt-3">
            <BreakdownBar dense items={d.siemEvents24h.bySeverity.map((s) => ({ label: s.severity, value: s.count, secondary: s.ticketed, secondaryLabel: 'ticketed' }))} emptyText="No events received in the last 24 hours" />
          </div>
        </Card>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title={`SLA at risk and breached (${d.slaStatus.atRisk + d.slaStatus.breached})`}>
          <TicketMiniTable rows={d.slaStatus.items} columns={['customer', 'severity', 'sla', 'assignee']} empty="All open security tickets are within SLA" />
        </Card>
        <Card title={`Escalations (${d.escalations.count})`}>
          <TicketMiniTable rows={d.escalations.items} columns={['customer', 'severity', 'status', 'assignee', 'age']} empty="No escalated security tickets" />
        </Card>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Open security tickets by customer">
          <BreakdownBar items={d.byCustomer.map((c) => ({ label: c.name, value: c.open, secondary: c.breached, href: `/customers/${c.id}` }))} emptyText="No open security tickets" />
        </Card>
        <Card title="Recent security tickets" className="lg:col-span-2">
          <TicketMiniTable rows={d.recent} columns={['customer', 'severity', 'status', 'assignee', 'age']} empty="No security tickets yet" />
        </Card>
      </div>
    </div>
  );
}
