import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Star, CalendarClock, FileSignature, Layers, ShieldCheck, Settings2, ChevronDown, Pencil } from 'lucide-react';
import { SLA_METRICS, TICKET_TYPES } from '@itsm/shared';
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
import { useSlaPolicies, usageSummary, slaAdminPath, METRIC_LABEL, type SlaPolicy, type Compliance } from '@/components/sla/api';
import { PRIORITY_LEVEL_COLORS } from '@/lib/statusColors';

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/**
 * Service levels: a browse view of the SLA policies the MSP commits to and how
 * contracts map onto them. Policies are managed under Administration.
 */
export default function ServiceLevelsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
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
  const focus = params.get('policy');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Service levels" subtitle="The response and resolution targets you commit to, and how each contract maps to a policy." actions={canEdit ? <Button variant="outline" icon={<Settings2 className="h-4 w-4" />} onClick={() => navigate('/admin/sla')}>Manage in Administration</Button> : undefined} />
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
              <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No SLA policies yet" description="Create a policy with targets per priority, then map contracts to it." action={canEdit && <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate(slaAdminPath(null))}>New policy</Button>} />
            </Card>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
              {items.map((p, i) => (
                <PolicyCard key={p.id} policy={p} canEdit={canEdit} initiallyOpen={focus === p.id} className={cn('rise-in', `rise-in-${Math.min(4, i + 1)}`)} />
              ))}
            </div>
          )}
          <div className="text-[12px] text-subtle">
            Policy selection order when a ticket is created: catalog item → contract service → contract → service default → platform default. Policies, calendars and holidays are managed under <Link to="/admin/sla" className="text-default font-medium hover:underline">Administration</Link>.
          </div>
        </div>
      )}
    </div>
  );
}

/** One policy: incident targets up front; click to expand every target, pause statuses and usage. */
function PolicyCard({ policy: p, canEdit, initiallyOpen, className }: { policy: SlaPolicy; canEdit: boolean; initiallyOpen: boolean; className?: string }) {
  const [open, setOpen] = useState(initiallyOpen);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (initiallyOpen) {
      setOpen(true);
      ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [initiallyOpen]);
  const rows = (p.targetSummary ?? []).filter((r) => r.response !== null || r.resolution !== null);
  const byType = useMemo(() => {
    const groups = new Map<string, SlaPolicy['targets']>();
    for (const t of p.targets) groups.set(t.ticketType, [...(groups.get(t.ticketType) ?? []), t]);
    return TICKET_TYPES.filter((t) => groups.has(t)).map((t) => ({ type: t, targets: groups.get(t)! }));
  }, [p.targets]);
  return (
    <div ref={ref} className={cn('card flex flex-col transition-[box-shadow,border-color]', open ? 'border-strong shadow-raised' : 'hover:border-strong hover:shadow-raised', !p.isActive && 'opacity-70', className)}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-left px-5 pt-4 pb-3 flex items-start justify-between gap-3 w-full" aria-expanded={open}>
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
        <span className="text-muted inline-flex items-center gap-1 text-[12.5px] font-medium shrink-0">{open ? 'Less' : 'Details'} <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} /></span>
      </button>
      <div className="px-5 pb-4">
        {!open ? (
          rows.length === 0 ? (
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
          )
        ) : (
          <div className="flex flex-col gap-4">
            {byType.length === 0 && <div className="text-[12.5px] text-subtle py-1">No targets defined yet.</div>}
            {byType.map(({ type, targets }) => {
              const priorities = [...new Map(targets.map((t) => [t.priorityId ?? 'any', { id: t.priorityId, label: t.priorityLabel ?? 'Any priority', level: t.priorityLevel ?? null }])).values()].sort((a, b) => (a.level ?? 99) - (b.level ?? 99));
              const cell = (priorityId: string | null, metric: string) => targets.find((t) => (t.priorityId ?? null) === priorityId && t.metric === metric);
              return (
                <div key={type}>
                  <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-1">{titleCase(type)}</div>
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="text-muted">
                        <th className="text-left font-medium py-1 w-28">Priority</th>
                        {SLA_METRICS.map((m) => <th key={m} className="text-right font-medium py-1">{METRIC_LABEL[m]}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {priorities.map((pr) => (
                        <tr key={pr.id ?? 'any'} className="border-t border-default">
                          <td className="py-1">{pr.id ? <Badge color={PRIORITY_LEVEL_COLORS[pr.level ?? 0] ?? 'slate'}>{pr.label}</Badge> : <span className="text-muted">Any priority</span>}</td>
                          {SLA_METRICS.map((m) => {
                            const t = cell(pr.id, m);
                            return (
                              <td key={m} className="py-1 text-right tnum text-secondary whitespace-nowrap">
                                {t ? <span title={`warn at ${t.warnPct}%${t.calendarTime ? ' · 24x7 clock' : ''}`}>{formatDuration(t.minutes)}{t.calendarTime && <span className="text-subtle text-[11px]"> 24x7</span>}</span> : '—'}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]">
              <dt className="text-muted">Pauses in</dt>
              <dd>{p.pauseStatuses.length ? p.pauseStatuses.map((s) => s.label).join(', ') : <span className="text-subtle">Default pause statuses only</span>}</dd>
              <dt className="text-muted">Contracts</dt>
              <dd className="tnum">{p.usage.contracts} at contract level · {p.usage.contractServices} per service</dd>
              <dt className="text-muted">Services · catalog items</dt>
              <dd className="tnum">{p.usage.services} · {p.usage.catalogItems}</dd>
              <dt className="text-muted">Tickets</dt>
              <dd className="tnum">{p.usage.tickets}</dd>
            </dl>
          </div>
        )}
      </div>
      <div className="mt-auto px-5 py-3 border-t border-default bg-[#fafafa] rounded-b-[12px] flex items-center justify-between gap-3 text-[12.5px]">
        <span className="text-muted truncate">{usageSummary(p.usage)}</span>
        {canEdit ? (
          <Link to={slaAdminPath(p.id)} className="inline-flex items-center gap-1 text-default font-medium hover:underline shrink-0"><Pencil className="h-3 w-3" /> Edit in Administration</Link>
        ) : (
          <span className="text-subtle tnum shrink-0">{p.targets.length} targets</span>
        )}
      </div>
    </div>
  );
}
