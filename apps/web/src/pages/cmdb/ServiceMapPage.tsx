import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Workflow, ExternalLink } from 'lucide-react';
import { PageHeader, Button, Select, LoadingBlock, ErrorBlock, EmptyState, Badge } from '@/components/ui';
import { Panel, Stat } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtNumber } from '@/lib/format';
import { CmdbNav } from '@/components/cmdb/CmdbNav';
import { ServiceMap } from '@/components/cmdb/ServiceMap';
import { CiPicker } from '@/components/cmdb/CiPicker';
import { CriticalityBadge, CiStatusBadge, CiTypeBadge } from '@/components/cmdb/CiTypeBadge';
import { cmdbApi, cmdbKeys } from '@/components/cmdb/api';

/** Service map: pick a business service (or any CI) and see everything it depends on, layer by layer, with open tickets overlaid. */
export default function ServiceMapPage() {
  const navigate = useNavigate();
  const { id: routeId } = useParams();
  const { state, set } = useListState();
  const customers = useCustomersLookup();
  const rootId = routeId ?? state.ci ?? '';
  const depth = Number(state.depth ?? 6) || 6;
  const services = useQuery({ queryKey: cmdbKeys.services(state.customerId), queryFn: () => cmdbApi.services(state.customerId), staleTime: 60_000 });
  const map = useQuery({ queryKey: cmdbKeys.map(rootId, depth), queryFn: () => cmdbApi.map(rootId, depth), enabled: !!rootId, refetchInterval: 60_000, placeholderData: (p) => p });
  useEffect(() => {
    if (!rootId && services.data?.items.length) navigate(`/cmdb/services/${services.data.items[0]!.id}`, { replace: true });
  }, [rootId, services.data, navigate]);
  const d = map.data;
  const byLayer = useMemo(() => {
    const m = new Map<number, number>();
    for (const n of d?.nodes ?? []) m.set(n.layer, (m.get(n.layer) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [d]);
  const impacted = (d?.nodes ?? []).filter((n) => n.openTickets > 0 && n.layer > 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Service map" subtitle="A business service and every configuration item it depends on, top down" actions={d ? <Button size="sm" variant="outline" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => navigate(`/cmdb/cis/${d.root.id}`)}>Open record</Button> : undefined} />
      <CmdbNav />
      <div className="filter-bar" role="toolbar" aria-label="Service map scope" data-testid="filter-bar">
        <Select className="w-44 h-8 py-0 text-[13px]" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value }, false)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <Select className="w-72 h-8 py-0 text-[13px]" value={routeId && services.data?.items.some((s) => s.id === routeId) ? routeId : ''} onChange={(e) => e.target.value && navigate(`/cmdb/services/${e.target.value}`)} placeholder="Choose a business service…" options={(services.data?.items ?? []).map((s) => ({ value: s.id, label: `${s.name}${s.customerName ? ` · ${s.customerName}` : ''}` }))} />
        <span className="text-[12px] text-subtle">or any CI:</span>
        <div className="w-64"><CiPicker customerId={state.customerId || undefined} value={null} onChange={(ci) => ci && navigate(`/cmdb/map?ci=${ci.id}`)} placeholder="Search a configuration item…" /></div>
        <Select className="w-28 h-8 py-0 text-[13px] ml-auto" value={String(depth)} onChange={(e) => set({ depth: e.target.value }, false)} options={[2, 3, 4, 6].map((n) => ({ value: String(n), label: `${n} layers` }))} />
      </div>
      {!rootId && !services.isLoading && <div className="card"><EmptyState icon={<Workflow className="h-5 w-5" />} title="Pick a business service" description="Service maps start from a business service CI; create one under Configuration items if none exist." /></div>}
      {map.isLoading && <LoadingBlock />}
      {map.isError && <ErrorBlock error={map.error} retry={() => map.refetch()} />}
      {d && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
          <div className="flex flex-col gap-3 min-w-0">
            <div className="card px-4 py-3 flex flex-wrap items-center gap-3">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold flex items-center gap-2 flex-wrap">{d.root.name} <CiTypeBadge typeKey={d.root.typeKey} name={d.root.typeName} color={d.root.color} icon={d.root.icon} /> <CiStatusBadge status={d.root.status} /> <CriticalityBadge value={d.root.criticality} /></div>
                <div className="text-[12.5px] text-muted">{fmtNumber(d.nodes.length - 1)} dependent CIs across {byLayer.length - 1} layers{d.truncated ? ' · map truncated at 200 CIs' : ''}</div>
              </div>
              <div className="ml-auto flex items-center gap-4">
                <Stat label="Open tickets in chain" value={fmtNumber(d.nodes.reduce((n, x) => n + x.openTickets, 0))} tone={d.nodes.some((x) => x.openTickets > 0) ? 'warn' : 'good'} />
                <Stat label="Impacted CIs" value={fmtNumber(impacted.length)} tone={impacted.length ? 'bad' : 'good'} />
              </div>
            </div>
            <ServiceMap nodes={d.nodes} edges={d.edges} truncated={d.truncated} onSelect={(id) => navigate(`/cmdb/cis/${id}?tab=relationships`)} />
          </div>
          <div className="flex flex-col gap-3">
            <Panel title="Impacted right now" subtitle="Dependencies with open tickets">
              {impacted.length ? (
                <ul className="flex flex-col divide-y divide-[var(--border)]">
                  {impacted.sort((a, b) => b.openTickets - a.openTickets).map((n) => (
                    <li key={n.id} className="py-1.5 flex items-center gap-2 text-[12.5px]">
                      <button className="font-medium hover:underline truncate text-left" onClick={() => navigate(`/cmdb/cis/${n.id}?tab=tickets`)}>{n.name}</button>
                      <span className="text-subtle truncate">{n.typeName}</span>
                      <Badge color={n.criticality === 'critical' || n.criticality === 'high' ? 'red' : 'amber'} className="ml-auto shrink-0">{n.openTickets}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[12.5px] text-subtle">Nothing open underneath this service.</div>
              )}
            </Panel>
            <Panel title="Layers" subtitle="How deep the dependency chain goes">
              <BreakdownBar dense items={byLayer.map(([layer, count]) => ({ label: layer === 0 ? 'Service' : `Layer ${layer}`, value: count }))} />
            </Panel>
            <Panel title="By class">
              <BreakdownBar dense items={Object.values(d.nodes.reduce<Record<string, { label: string; value: number; color: string | null }>>((acc, n) => { acc[n.typeKey] = acc[n.typeKey] ?? { label: n.typeName, value: 0, color: n.color }; acc[n.typeKey]!.value += 1; return acc; }, {})).sort((a, b) => b.value - a.value)} />
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
