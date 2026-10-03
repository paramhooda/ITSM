import { useQuery } from '@tanstack/react-query';
import { ErrorBlock, Badge } from '@/components/ui';
import { ShieldAlert, Siren, Timer, Radio } from 'lucide-react';
import { get } from '@/api/client';
import { fmtDuration, fmtNumber } from '@/lib/format';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { TicketMiniTable } from './TicketMiniTable';
import { Panel, KpiSkeleton, Skeleton, Stat, Updated, RowList } from './Panel';
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
  period: { days: number; from: string; to: string };
  /** Security-domain tickets opened, resolved and SLA-breached per day, last 30 days. */
  series: { day: string; opened: number; resolved: number; breaches: number }[];
}

export function SocDashboard({ days = 30 }: { days?: number }) {
  const q = useQuery({ queryKey: ['dashboards', 'soc', days], queryFn: () => get<Soc>('/dashboards/soc', { days }), refetchInterval: 60_000, placeholderData: (p) => p });
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
  const recent = d.series.slice(-14);
  const flow = d.series.some((s) => s.opened || s.resolved) ? d.series : [];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between -mt-2">
        <span className="text-[12.5px] text-muted">Security operations · refreshes every minute</span>
        <Updated at={d.generatedAt} fetching={q.isFetching} />
      </div>
      <KpiGrid
        items={[
          { label: 'Open security incidents', value: fmtNumber(t.open), icon: <ShieldAlert className="h-4 w-4" />, hint: `${fmtNumber(t.openedToday)} opened today`, spark: recent.map((s) => s.opened), sparkLabel: 'Security incidents opened per day, last 14 days', onClick: () => (window.location.href = '/tickets?domain=soc&open=true') },
          { label: 'Critical / high', value: fmtNumber(t.criticalHigh), icon: <Siren className="h-4 w-4" />, tone: t.criticalHigh > 0 ? 'bad' : 'good', hint: `${fmtNumber(t.escalated)} escalated` },
          { label: 'SLA at risk', value: fmtNumber(t.atRisk + t.breached), icon: <Timer className="h-4 w-4" />, tone: t.breached > 0 ? 'bad' : t.atRisk > 0 ? 'warn' : 'good', hint: `${fmtNumber(t.breached)} breached · ${fmtNumber(t.unassigned)} unassigned`, spark: recent.map((s) => s.breaches), sparkLabel: 'Security SLA breaches per day, last 14 days' },
          { label: 'SIEM events · 24h', value: fmtNumber(d.siemEvents24h.total), icon: <Radio className="h-4 w-4" />, hint: `${fmtNumber(d.siemEvents24h.ticketsCreated)} became tickets`, onClick: () => (window.location.href = '/admin/integrations') },
        ]}
      />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Security incident flow" subtitle={`Opened and resolved per day, last ${days} days`} className="xl:col-span-2" to="/tickets?domain=soc" toLabel="All security incidents">
          <TrendChart data={flow} x="day" kind="area" series={[{ key: 'opened', label: 'Opened' }, { key: 'resolved', label: 'Resolved', color: '#0f9d6f' }]} height={220} />
        </Panel>
        <Panel title="Open by severity" subtitle="Security severity of open incidents">
          <BreakdownBar items={d.bySeverity.map((s) => ({ label: s.label, value: s.count, secondary: s.breached, color: s.color, href: s.id ? `/tickets?domain=soc&open=true&securitySeverityId=${s.id}` : undefined }))} emptyText="No open security incidents" />
          <div className="mt-4 pt-4 border-t border-default grid grid-cols-2 gap-3">
            <Stat label="Resolved · 30d" value={fmtNumber(d.mttrSecurity30d.resolved)} />
            <Stat label="Mean time to resolve" value={fmtDuration(d.mttrSecurity30d.mttrMinutes)} />
          </div>
        </Panel>
      </div>
      <Panel title="Recent security incidents" subtitle="Newest first" to="/tickets?domain=soc" padded={false}>
        <div className="px-5">
          <TicketMiniTable rows={d.recent} max={8} columns={['customer', 'severity', 'status', 'sla', 'assignee']} empty="No security incidents recorded" />
        </div>
      </Panel>
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
