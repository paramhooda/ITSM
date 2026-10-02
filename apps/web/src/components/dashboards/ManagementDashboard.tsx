import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, Select, LoadingBlock, ErrorBlock, Badge } from '@/components/ui';
import { get } from '@/api/client';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDuration, fmtNumber, fmtPct } from '@/lib/format';
import { cn } from '@/lib/utils';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { SlaGauge } from './SlaGauge';
import { EntitlementAlerts, type EntitlementAlert } from './EntitlementAlerts';
import { ExpiringContracts, type ExpiringContract } from './ExpiringContracts';
import { STATUS_COLORS } from './chartTheme';
import type { Delta } from './types';

interface Management {
  period: { days: number; from: string; to: string };
  kpis: Record<string, number | null>;
  series: { day: string; opened: number; resolved: number; closed: number; breaches: number; outOfScope: number; mttrMinutes: number | null }[];
  byService: { id: string | null; name: string; tickets: number; resolved: number; breaches: number; out_of_scope: number }[];
  byCustomer: { id: string; name: string; code: string; tickets: number; resolved: number; out_of_scope: number; major: number; slaMet: number; slaBreached: number; compliancePct: number | null }[];
  outOfScopeByCustomer: { id: string; name: string; code: string; out_of_scope: number; unknown_scope: number; minutes: number }[];
  entitlementAlerts: EntitlementAlert[];
  expiringContracts: ExpiringContract[];
  expiringContractsTotal: number;
  trends: Record<string, Delta>;
}

export function ManagementDashboard({ days, customerId, onDays, onCustomer }: { days: number; customerId: string; onDays: (d: number) => void; onCustomer: (id: string) => void }) {
  const customers = useCustomersLookup();
  const q = useQuery({ queryKey: ['dashboards', 'management', days, customerId], queryFn: () => get<Management>('/dashboards/management', { days, customerId: customerId || undefined }), placeholderData: (p) => p, staleTime: 30_000 });
  const d = q.data;
  const k = d?.kpis ?? {};
  const resMet = d?.series.reduce((s, r) => s + r.resolved, 0) ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-default overflow-hidden">
          {[7, 30, 90].map((n) => (
            <button key={n} onClick={() => onDays(n)} className={cn('px-3 py-1.5 text-[12.5px] font-medium', days === n ? 'bg-brand-600 text-white' : 'bg-surface text-muted hover:bg-surface-2')}>
              {n} days
            </button>
          ))}
        </div>
        <Select className="w-64" value={customerId} onChange={(e) => onCustomer(e.target.value)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} />
        {d && <span className="text-[12px] text-subtle">{d.period.from} to {d.period.to}{q.isFetching ? ' · refreshing…' : ''}</span>}
      </div>
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      {!d && q.isPending && <LoadingBlock />}
      {d && (
        <>
          <KpiGrid
            items={[
              { label: 'Open now', value: fmtNumber(k.openNow), hint: `${fmtNumber(k.openedToday)} opened today · ${fmtNumber(k.resolvedToday)} resolved`, tone: (k.breachedOpen ?? 0) > 0 ? 'warn' : 'default' },
              { label: 'Opened', value: fmtNumber(k.ticketsOpened), delta: d.trends.opened, lowerIsBetter: true },
              { label: 'Resolved', value: fmtNumber(k.ticketsResolved), delta: d.trends.resolved },
              { label: 'SLA compliance', value: fmtPct(k.slaCompliancePct, 1), delta: d.trends.slaCompliancePct, tone: k.slaCompliancePct === null ? 'default' : (k.slaCompliancePct ?? 0) >= 95 ? 'good' : (k.slaCompliancePct ?? 0) >= 85 ? 'warn' : 'bad' },
              { label: 'SLA breaches', value: fmtNumber(k.slaBreaches), delta: d.trends.breaches, lowerIsBetter: true, tone: (k.slaBreaches ?? 0) > 0 ? 'bad' : 'good' },
              { label: 'MTTR', value: fmtDuration(k.mttrMinutes), delta: d.trends.mttrMinutes, lowerIsBetter: true },
              { label: 'First response', value: fmtDuration(k.firstResponseMinutes), hint: 'average' },
              { label: 'Major incidents', value: fmtNumber(k.majorIncidents), delta: d.trends.majorIncidents, lowerIsBetter: true, tone: (k.majorOpen ?? 0) > 0 ? 'bad' : 'default' },
              { label: 'Out of scope', value: fmtNumber(k.outOfScopeCount), delta: d.trends.outOfScope, lowerIsBetter: true },
              { label: 'AMC utilization', value: fmtPct(k.amcUtilizationPct), hint: `${fmtNumber(k.entitlementsOverThreshold)} over threshold · ${fmtNumber(k.entitlementsExhausted)} exhausted`, tone: (k.entitlementsExhausted ?? 0) > 0 ? 'warn' : 'default' },
              { label: 'PM on time', value: fmtPct(k.pmOnTimePct), hint: `${fmtNumber(k.pmMissed)} missed · ${fmtNumber(k.pmOverdue)} overdue`, tone: (k.pmMissed ?? 0) > 0 ? 'warn' : 'default' },
              { label: 'Contracts', value: fmtNumber(k.contractsActive), hint: `${fmtNumber(k.customersActive)} customers · ${fmtNumber(k.contractsExpiring90d)} expiring in 90d`, tone: (k.contractsExpiring90d ?? 0) > 0 ? 'warn' : 'default' },
            ]}
          />
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <Card title="Opened, resolved and SLA breaches per day" className="xl:col-span-2">
              <TrendChart data={d.series} x="day" kind={days <= 30 ? 'bar' : 'line'} series={[{ key: 'opened', label: 'Opened' }, { key: 'resolved', label: 'Resolved' }, { key: 'breaches', label: 'SLA breaches', color: STATUS_COLORS.critical }]} height={240} />
            </Card>
            <Card title="Resolution SLA">
              <SlaGauge pct={k.slaCompliancePct} met={resMet ? undefined : undefined} label="Resolution compliance" />
              <div className="mt-4">
                <TrendChart data={d.series} x="day" kind="line" series={[{ key: 'mttrMinutes', label: 'MTTR (min)' }]} height={120} valueFormatter={(v) => fmtDuration(v)} title="Mean time to resolve" />
              </div>
            </Card>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            <Card title="Top services" actions={<span className="text-[11px] text-subtle">tickets (breaches)</span>}>
              <BreakdownBar items={d.byService.map((s) => ({ label: s.name, value: s.tickets, secondary: s.breaches, href: s.id ? `/tickets?serviceId=${s.id}` : undefined }))} />
            </Card>
            <Card title="Top customers by volume" padded={false}>
              <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
                <thead><tr><th>Customer</th><th className="text-right">Tickets</th><th className="text-right">Major</th><th className="text-right">SLA</th></tr></thead>
                <tbody>
                  {d.byCustomer.length === 0 && <tr><td colSpan={4} className="text-center text-subtle py-4">No tickets in this period</td></tr>}
                  {d.byCustomer.map((c) => (
                    <tr key={c.id}>
                      <td><Link to={`/customers/${c.id}`} className="hover:underline">{c.name}</Link> <span className="text-subtle font-mono text-[11px]">{c.code}</span></td>
                      <td className="text-right tabular-nums">{c.tickets}</td>
                      <td className="text-right tabular-nums">{c.major || '—'}</td>
                      <td className="text-right">{c.compliancePct === null ? <span className="text-subtle">—</span> : <Badge color={c.compliancePct >= 95 ? 'green' : c.compliancePct >= 85 ? 'amber' : 'red'}>{c.compliancePct}%</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Out-of-scope activity by customer" actions={<Link to="/reports?tab=run&report=out_of_scope_activity" className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">Report</Link>}>
              <BreakdownBar items={d.outOfScopeByCustomer.map((c) => ({ label: c.name, value: c.out_of_scope, secondary: c.unknown_scope, secondaryLabel: 'unknown scope', href: `/customers/${c.id}` }))} emptyText="No out-of-scope tickets" />
            </Card>
            <Card title="Entitlement alerts" actions={<Link to="/reports?tab=run&report=amc_utilization" className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">Utilization report</Link>}>
              <EntitlementAlerts items={d.entitlementAlerts} />
            </Card>
            <Card title={`Contracts expiring in 90 days (${d.expiringContractsTotal})`} actions={<Link to="/contracts?expiringWithinDays=90" className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">All</Link>}>
              <ExpiringContracts items={d.expiringContracts} />
            </Card>
            <Card title="Delivery effort">
              <KpiGrid columns={3} items={[{ label: 'Site visits', value: fmtNumber(k.visitsCompleted) }, { label: 'Engineering hours', value: fmtNumber(k.engineeringHours, 1) }, { label: 'Closed', value: fmtNumber(k.ticketsClosed) }]} />
              <div className="mt-3">
                <TrendChart data={d.series} x="day" kind="bar" series={[{ key: 'outOfScope', label: 'Out of scope' }]} height={110} title="Out-of-scope tickets per day" />
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
