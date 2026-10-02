import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Star, CalendarClock, FileSignature, Layers, ArrowRight, ShieldCheck } from 'lucide-react';
import { get } from '@/api/client';
import { Button, Badge, ErrorBlock, EmptyState, Card, PageHeader } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { KpiSkeleton, Panel } from '@/components/dashboards/Panel';
import { SlaGauge } from '@/components/dashboards/SlaGauge';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useAuthStore } from '@/stores/auth';
import { formatDuration } from '@/components/admin/DurationInput';
import { fmtNumber, fmtPct, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usageSummary, type SlaPolicy, type Compliance } from './types';
import { PRIORITY_LEVEL_COLORS } from '@/lib/statusColors';

export const useSlaPolicies = () => useQuery({ queryKey: ['sla', 'policies'], queryFn: () => get<{ items: SlaPolicy[] }>('/sla/policies') });

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/** Service levels: the SLA policies the MSP commits to, and how contracts map onto them. */
export default function ServiceLevelsPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const canEdit = can('admin:config');
  const q = useSlaPolicies();
  const compliance = useQuery({ queryKey: ['sla', 'compliance', 'overview'], queryFn: () => get<Compliance>('/sla/compliance', { from: daysAgo(30), groupBy: 'metric' }), enabled: can('tickets:read') || can('dashboards:management') || can('reports:run') });
  const items = q.data?.items ?? [];
  const totals = useMemo(() => ({
    policies: items.length,
    active: items.filter((p) => p.isActive).length,
    contracts: items.reduce((n, p) => n + p.usage.contracts + p.usage.contractServices, 0),
    services: items.reduce((n, p) => n + p.usage.services, 0),
  }), [items]);
  const c = compliance.data?.totals;
  const tone = c?.compliancePct === null || c?.compliancePct === undefined ? 'default' : c.compliancePct >= 95 ? 'good' : c.compliancePct >= 85 ? 'warn' : 'bad';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Service levels" subtitle="Define the response and resolution targets you commit to, then map each contract to a policy." actions={canEdit ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/sla/new')}>New policy</Button> : undefined} />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      {q.isLoading && <KpiSkeleton />}
      {q.data && (
        <div className="flex flex-col gap-6">
          <InsightBand
            id="sla"
            summary={`${fmtNumber(totals.policies)} policies · compliance ${fmtPct(c?.compliancePct ?? null, 1)} over 30 days`}
            kpis={[
              { label: 'SLA policies', value: fmtNumber(totals.policies), hint: `${fmtNumber(totals.active)} active`, icon: <ShieldCheck className="h-4 w-4" /> },
              { label: 'Contracts mapped', value: fmtNumber(totals.contracts), hint: 'contract and service-level mappings', icon: <FileSignature className="h-4 w-4" />, onClick: () => navigate('/contracts') },
              { label: 'Services with a default', value: fmtNumber(totals.services), hint: 'policy applied when a contract sets none', icon: <Layers className="h-4 w-4" />, onClick: () => navigate('/services') },
              { label: 'Compliance · 30 days', value: fmtPct(c?.compliancePct ?? null, 1), tone, hint: c ? `${fmtNumber(c.met)} met · ${fmtNumber(c.breached)} breached · ${fmtNumber(c.overdueRunning)} overdue now` : 'All metrics, all customers', icon: <CalendarClock className="h-4 w-4" /> },
            ]}
            panels={
              compliance.data && (
                <>
                  <Panel title="Compliance by metric" subtitle="Last 30 days · met vs breached per SLA metric">
                    <BreakdownBar dense items={compliance.data.groups.map((g) => ({ label: titleCase(g.label), value: g.met + g.breached, secondary: g.breached, secondaryLabel: 'breached', color: g.compliancePct === null ? null : g.compliancePct >= 95 ? 'green' : g.compliancePct >= 85 ? 'amber' : 'red' }))} emptyText="No SLA clocks completed in the last 30 days" />
                  </Panel>
                  <Panel title="Overall compliance" subtitle="Share of SLA clocks met in the last 30 days">
                    <div className="flex items-center justify-center py-2">
                      <SlaGauge pct={c?.compliancePct ?? null} met={c?.met} breached={c?.breached} label="Compliance" />
                    </div>
                  </Panel>
                </>
              )
            }
          />

          {items.length === 0 ? (
            <Card>
              <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No SLA policies yet" description="Create a policy with targets per priority, then map contracts to it." action={canEdit && <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/sla/new')}>New policy</Button>} />
            </Card>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
              {items.map((p, i) => (
                <PolicyCard key={p.id} policy={p} className={cn('rise-in', `rise-in-${Math.min(4, i + 1)}`)} />
              ))}
            </div>
          )}
          <div className="text-[12px] text-subtle">
            Policy selection order when a ticket is created: catalog item → contract service → contract → service default → platform default. Calendars and holidays are managed under <Link to="/admin/calendars" className="text-default font-medium hover:underline">Administration</Link>.
          </div>
        </div>
      )}
    </div>
  );
}

function PolicyCard({ policy: p, className }: { policy: SlaPolicy; className?: string }) {
  const rows = (p.targetSummary ?? []).filter((r) => r.response !== null || r.resolution !== null);
  return (
    <Link to={`/sla/${p.id}`} className={cn('card flex flex-col hover:border-strong hover:shadow-raised transition-[box-shadow,border-color]', !p.isActive && 'opacity-60', className)}>
      <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] truncate">{p.name}</h2>
            {p.isDefault && <Badge color="amber"><Star className="h-3 w-3" /> default</Badge>}
            {!p.isActive && <Badge color="gray">inactive</Badge>}
          </div>
          <div className="text-[12.5px] text-muted mt-0.5 truncate">
            {p.calendarIs24x7 ? '24x7 clock' : p.calendarName ?? 'Platform default calendar'}
            {p.holidayCalendarName ? ` · ${p.holidayCalendarName}` : ''}
            {p.description ? ` · ${p.description}` : ''}
          </div>
        </div>
        <span className="text-muted inline-flex items-center gap-1 text-[12.5px] font-medium shrink-0">Open <ArrowRight className="h-3.5 w-3.5" /></span>
      </div>
      <div className="px-5 pb-4">
        {rows.length === 0 ? (
          <div className="text-[12.5px] text-subtle py-3">No incident targets defined yet.</div>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-muted">
                <th className="text-left font-medium py-1.5 w-28">Incidents</th>
                <th className="text-right font-medium py-1.5">Respond</th>
                <th className="text-right font-medium py-1.5">Resolve</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.priorityLabel} className="border-t border-default">
                  <td className="py-1.5"><Badge color={PRIORITY_LEVEL_COLORS[r.priorityLevel ?? 0] ?? 'slate'}>{r.priorityLabel}</Badge></td>
                  <td className="py-1.5 text-right tnum text-secondary">{r.response !== null ? formatDuration(r.response) : '—'}</td>
                  <td className="py-1.5 text-right tnum text-secondary">{r.resolution !== null ? formatDuration(r.resolution) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="mt-auto px-5 py-3 border-t border-default bg-[#fafafa] rounded-b-[12px] flex items-center justify-between gap-3 text-[12.5px]">
        <span className="text-muted truncate">{usageSummary(p.usage)}</span>
        <span className="text-subtle tnum shrink-0">{p.targets.length} targets</span>
      </div>
    </Link>
  );
}

export type { SlaPolicy, SlaTarget, SlaPolicyUsage } from './types';
export { usageSummary } from './types';
