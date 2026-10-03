import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Workflow, AlertTriangle, ShieldCheck, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, Badge, EmptyState, ErrorBlock, FilterChip, ListShell, FilterGroup, FilterSelect, type AppliedFilter, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber, titleCase } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { CRITICALITY_COLORS } from '@/lib/statusColors';
import { CMDB_MODULES } from '@/layouts/modules';
import { CriticalityBadge, CiStatusBadge } from '@/components/cmdb/CiTypeBadge';
import { cmdbApi, cmdbKeys, type BusinessService } from '@/components/cmdb/api';

const HEALTH: Record<BusinessService['health'], { label: string; color: string }> = { good: { label: 'Healthy', color: 'green' }, warning: { label: 'Degraded', color: 'amber' }, critical: { label: 'Critical', color: 'red' } };

/** Business services: what the customer actually consumes, with live health from the tickets on everything underneath. */
export default function BusinessServicesPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const { state, set } = useListState();
  const customers = useCustomersLookup();
  const q = useQuery({ queryKey: cmdbKeys.services(state.customerId), queryFn: () => cmdbApi.services(state.customerId), refetchInterval: 60_000, placeholderData: (p) => p });
  const items = useMemo(() => {
    const needle = (state.q ?? '').toLowerCase();
    return (q.data?.items ?? []).filter((s) => (!state.health || s.health === state.health) && (!needle || s.name.toLowerCase().includes(needle) || (s.customerName ?? '').toLowerCase().includes(needle)));
  }, [q.data, state.q, state.health]);
  const all = q.data?.items ?? [];
  const counts = { good: all.filter((s) => s.health === 'good').length, warning: all.filter((s) => s.health === 'warning').length, critical: all.filter((s) => s.health === 'critical').length };
  const customerItems = customers.data?.items ?? [];

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (state.health) addApplied('health', `Health: ${HEALTH[state.health as BusinessService['health']]?.label ?? state.health}`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);

  const columns: Column<BusinessService>[] = [
    { key: 'name', header: 'Business service', render: (s) => <div className="min-w-0"><div className="font-medium">{s.name}</div><div className="text-[11.5px] text-muted">{s.customerName}{s.tier ? ` · tier ${s.tier}` : ''}{s.owner ? ` · ${s.owner}` : ''}</div></div> },
    { key: 'health', header: 'Health', width: '120px', render: (s) => <Badge color={HEALTH[s.health].color} dot>{HEALTH[s.health].label}</Badge> },
    { key: 'criticality', header: 'Criticality', width: '110px', render: (s) => <CriticalityBadge value={s.criticality} /> },
    { key: 'status', header: 'Status', width: '110px', render: (s) => <CiStatusBadge status={s.status} /> },
    { key: 'dependencies', header: 'Depends on', width: '110px', className: 'text-right tabular-nums', render: (s) => <span>{fmtNumber(s.dependencies)} CIs</span> },
    { key: 'openIncidents', header: 'Open tickets', width: '120px', className: 'text-right tabular-nums', render: (s) => (s.openIncidents > 0 ? <span className="font-medium text-amber-700">{s.openIncidents}</span> : <span className="text-subtle">0</span>) },
    { key: 'map', header: '', width: '120px', render: (s) => <Button size="sm" variant="ghost" icon={<Workflow className="h-3.5 w-3.5" />} onClick={(e) => { e.stopPropagation(); navigate(`/cmdb/services/${s.id}`); }}>Service map</Button> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Business services" subtitle="The services customers consume, and the applications, servers and network they depend on" actions={can('cmdb:manage') ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/cmdb/cis?new=1&typeKey=business_service')}>New business service</Button> : undefined} />
      <ListShell
        id="cmdb-services"
        modules={CMDB_MODULES}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search services or customers…' }}
        filters={
          <FilterGroup label="Customer">
            <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
          </FilterGroup>
        }
        applied={applied}
        activeCount={applied.length}
        onClear={() => set({ q: undefined, health: undefined, customerId: undefined })}
        count={q.data ? `${fmtNumber(items.length)} business ${items.length === 1 ? 'service' : 'services'}` : undefined}
        quick={(['critical', 'warning', 'good'] as const).map((h) => (
          <FilterChip key={h} active={state.health === h} onClick={() => set({ health: state.health === h ? undefined : h })} dot={dotClass(HEALTH[h].color)} count={counts[h]}>
            {HEALTH[h].label}
          </FilterChip>
        ))}
        insights={
          <InsightBand
            id="cmdb-services"
            loading={q.isLoading}
            summary={q.data ? `${fmtNumber(all.length)} business services` : undefined}
            kpis={
              q.data
                ? [
                    { label: 'Business services', value: fmtNumber(all.length), icon: <Workflow className="h-4 w-4" />, hint: `${fmtNumber(all.reduce((n, s) => n + s.dependencies, 0))} dependent CIs mapped` },
                    { label: 'Critical', value: fmtNumber(counts.critical), tone: counts.critical ? 'bad' : 'good', icon: <AlertTriangle className="h-4 w-4" />, hint: 'P1/P2 or major ticket in the chain', onClick: () => set({ health: state.health === 'critical' ? undefined : 'critical' }), scrollTo: true, active: state.health === 'critical' },
                    { label: 'Degraded', value: fmtNumber(counts.warning), tone: counts.warning ? 'warn' : 'good', icon: <AlertTriangle className="h-4 w-4" />, hint: 'open tickets on dependencies', onClick: () => set({ health: state.health === 'warning' ? undefined : 'warning' }), scrollTo: true, active: state.health === 'warning' },
                    { label: 'Healthy', value: fmtNumber(counts.good), tone: 'good', icon: <ShieldCheck className="h-4 w-4" />, hint: 'nothing open underneath', onClick: () => set({ health: state.health === 'good' ? undefined : 'good' }), scrollTo: true, active: state.health === 'good' },
                  ]
                : []
            }
            panels={
              q.data && (
                <>
                  <Panel title="Open tickets by service" subtitle="Tickets on the service or anything it depends on">
                    <BreakdownBar dense items={[...all].filter((s) => s.openIncidents > 0).sort((a, b) => b.openIncidents - a.openIncidents).slice(0, 8).map((s) => ({ label: s.name, value: s.openIncidents, color: s.health === 'critical' ? 'red' : 'amber', href: `/cmdb/services/${s.id}` }))} emptyText="No open tickets on any business service" />
                  </Panel>
                  <Panel title="By criticality">
                    <BreakdownBar dense items={['critical', 'high', 'medium', 'low'].map((c) => ({ label: titleCase(c), value: all.filter((s) => s.criticality === c).length, color: CRITICALITY_COLORS[c] })).filter((i) => i.value > 0)} emptyText="No business services" />
                  </Panel>
                </>
              )
            }
          />
        }
      >
        {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
        <div className="card overflow-hidden">
          <DataTable columns={columns} rows={items} loading={q.isLoading} dense onRowClick={(s) => navigate(`/cmdb/services/${s.id}`)} rowClassName={(s) => (s.health === 'critical' ? 'row-rail-bad' : s.health === 'warning' ? 'row-rail-warn' : undefined)} empty={<EmptyState icon={<Workflow className="h-5 w-5" />} title="No business services" description="Create a CI of class Business service and add depends_on relationships to the applications and infrastructure behind it." />} />
        </div>
      </ListShell>
    </div>
  );
}
