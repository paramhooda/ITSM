import { useQuery } from '@tanstack/react-query';
import { ErrorBlock, Badge } from '@/components/ui';
import { get } from '@/api/client';
import { fmtDuration, fmtNumber } from '@/lib/format';
import { KpiGrid } from './KpiGrid';
import { BreakdownBar } from './BreakdownBar';
import { TicketMiniTable } from './TicketMiniTable';
import { Panel, KpiSkeleton, Stat, Updated, RowList } from './Panel';
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
  series: { day: string; opened: number; incidents: number; security: number; resolved: number; breaches: number }[];
}

export function SocDashboard() {
  const q = useQuery({ queryKey: ['dashboards', 'soc'], queryFn: () => get<Soc>('/dashboards/soc'), refetchInterval: 60_000, placeholderData: (p) => p });
  const d = q.data;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d) return <KpiSkeleton />;
  const t = d.totals;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between -mt-2">
        <span className="text-[12.5px] text-muted">Security operations · refreshes every minute</span>
        <Updated at={d.generatedAt} fetching={q.isFetching} />
      </div>
      <KpiGrid
        items={[
          { label: 'Open security incidents', value: fmtNumber(t.open), hint: `${fmtNumber(t.openedToday)} opened today`, spark: d.series.map((s) => s.security), sparkLabel: 'Security incidents opened per day, last 14 days', onClick: () => (window.location.href = '/tickets?domain=soc&open=true') },
          { label: 'Critical / high', value: fmtNumber(t.criticalHigh), tone: t.criticalHigh > 0 ? 'bad' : 'good', hint: `${fmtNumber(t.escalated)} escalated` },
          { label: 'SLA at risk', value: fmtNumber(t.atRisk + t.breached), tone: t.breached > 0 ? 'bad' : t.atRisk > 0 ? 'warn' : 'good', hint: `${fmtNumber(t.breached)} breached · ${fmtNumber(t.unassigned)} unassigned`, spark: d.series.map((s) => s.breaches), sparkLabel: 'SLA breaches per day, last 14 days' },
          { label: 'SIEM events · 24h', value: fmtNumber(d.siemEvents24h.total), hint: `${fmtNumber(d.siemEvents24h.ticketsCreated)} became tickets`, onClick: () => (window.location.href = '/integrations') },
        ]}
      />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Open by severity" subtitle="Security severity of open incidents">
          <BreakdownBar items={d.bySeverity.map((s) => ({ label: s.label, value: s.count, secondary: s.breached, color: s.color, href: s.id ? `/tickets?domain=soc&open=true&securitySeverityId=${s.id}` : undefined }))} emptyText="No open security incidents" />
          <div className="mt-4 pt-4 border-t border-default grid grid-cols-2 gap-3">
            <Stat label="Resolved · 30d" value={fmtNumber(d.mttrSecurity30d.resolved)} />
            <Stat label="Mean time to resolve" value={fmtDuration(d.mttrSecurity30d.mttrMinutes)} />
          </div>
        </Panel>
        <Panel title="Recent security incidents" subtitle="Newest first" to="/tickets?domain=soc" className="xl:col-span-2" padded={false}>
          <div className="px-5">
            <TicketMiniTable rows={d.recent} max={8} columns={['customer', 'severity', 'status', 'sla', 'assignee']} empty="No security incidents recorded" />
          </div>
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Panel title="Escalations" subtitle="Open incidents escalated beyond level 1" padded={false}>
          <div className="px-5">
            <TicketMiniTable rows={d.escalations.items} max={6} columns={['customer', 'severity', 'sla', 'assignee']} empty="No active escalations" />
          </div>
        </Panel>
        <Panel title="By customer" subtitle="Open security incidents per customer">
          <RowList
            empty="No open security incidents"
            dense
            items={d.byCustomer.slice(0, 6).map((c) => ({
              key: c.id,
              href: `/tickets?domain=soc&open=true&customerId=${c.id}`,
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
      </div>
    </div>
  );
}
