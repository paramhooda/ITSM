import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, Radar } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Button, Select, SearchInput, DataTable, Badge, EmptyState, ErrorBlock, FilterBar, FilterChip, type Column } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { relativeTime, fmtNumber } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { CmdbNav, DiscoveryNav } from '@/components/cmdb/CmdbNav';
import { SourceDrawer } from '@/components/cmdb/SourceDrawer';
import { RunStatusBadge, cronLabel } from '@/components/cmdb/DiscoveryBits';
import { errorMessage } from '@/components/cmdb/hooks';
import { discoveryApi, discoveryKeys, type DiscoverySource } from '@/components/cmdb/api';

/** Discovery sources: one per customer network segment, with its schedule and review backlog. */
export default function SourcesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canManage = can('discovery:manage');
  const { state, set } = useListState();
  const customers = useCustomersLookup();
  const [drawer, setDrawer] = useState(false);
  const providers = useQuery({ queryKey: discoveryKeys.providers, queryFn: () => discoveryApi.providers(), staleTime: 300_000 });
  const q = useQuery({ queryKey: discoveryKeys.sources(state.customerId), queryFn: () => discoveryApi.sources(state.customerId), refetchInterval: 15_000, placeholderData: (p) => p });
  const runNow = useMutation({ mutationFn: (id: string) => discoveryApi.runNow(id), onSuccess: (r) => { toast.success('Run queued'); qc.invalidateQueries({ queryKey: discoveryKeys.all }); navigate(`/cmdb/discovery/runs/${r.id}`); }, onError: (e) => toast.error(errorMessage(e)) });
  const items = useMemo(() => {
    const needle = (state.q ?? '').toLowerCase();
    return (q.data?.items ?? []).filter((s) => (state.active === 'true' ? s.isActive : state.active === 'false' ? !s.isActive : true) && (state.backlog !== 'true' || s.pendingFindings > 0) && (!needle || s.name.toLowerCase().includes(needle) || (s.customerName ?? '').toLowerCase().includes(needle) || s.config.subnets.some((x) => x.includes(needle))));
  }, [q.data, state.q, state.active, state.backlog]);
  const all = q.data?.items ?? [];
  const label = (type: string) => providers.data?.items.find((p) => p.type === type)?.label ?? type;
  const schedule = (cron: string | null | undefined) => cronLabel(cron).replace(' UTC', '');

  const columns: Column<DiscoverySource>[] = [
    { key: 'name', header: 'Source', render: (s) => <div className="min-w-0"><div className="font-medium flex items-center gap-2">{s.name}{!s.isActive && <Badge color="gray">inactive</Badge>}</div><div className="text-[11.5px] text-muted truncate">{s.customerName}{s.siteName ? ` · ${s.siteName}` : ''} · {label(s.sourceType)}</div></div> },
    { key: 'targets', header: 'Targets', render: (s) => <span className="font-mono text-xs text-muted" title={s.config.subnets.join(', ')}>{s.config.subnets.slice(0, 2).join(', ')}{s.config.subnets.length > 2 ? ` +${s.config.subnets.length - 2}` : ''}</span> },
    { key: 'schedule', header: 'Schedule', width: '150px', render: (s) => <span className="text-muted">{schedule(s.scheduleCron)}</span> },
    { key: 'lastRun', header: 'Last run', width: '170px', render: (s) => (s.lastRunStatus ? <span className="inline-flex items-center gap-1.5"><RunStatusBadge status={s.lastRunStatus} /><span className="text-[12px] text-muted">{s.lastRunAt ? relativeTime(s.lastRunAt) : ''}</span></span> : <span className="text-subtle">never</span>) },
    { key: 'pending', header: 'To review', width: '100px', className: 'text-right tabular-nums', render: (s) => (s.pendingFindings > 0 ? <Badge color="blue">{s.pendingFindings}</Badge> : <span className="text-subtle">0</span>) },
    { key: 'auto', header: 'Apply', width: '100px', render: (s) => (s.autoApply ? <Badge color="green">automatic</Badge> : <span className="text-muted text-[12px]">review</span>) },
    { key: 'run', header: '', width: '110px', render: (s) => <Button size="sm" variant="ghost" icon={<Play className="h-3.5 w-3.5" />} disabled={!s.isActive} loading={runNow.isPending && runNow.variables === s.id} onClick={(e) => { e.stopPropagation(); runNow.mutate(s.id); }}>Run now</Button> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Discovery sources" subtitle="Which networks are scanned, how often, and with what credentials" actions={canManage ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setDrawer(true)}>New source</Button> : undefined} />
      <CmdbNav />
      <div className="flex flex-wrap items-center gap-2"><DiscoveryNav /></div>
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      <FilterBar
        activeCount={(state.q ? 1 : 0) + (state.customerId ? 1 : 0) + (state.active ? 1 : 0) + (state.backlog ? 1 : 0)}
        onClear={() => set({ q: undefined, customerId: undefined, active: undefined, backlog: undefined })}
        chips={
          <>
            <FilterChip active={state.active === 'true'} onClick={() => set({ active: state.active === 'true' ? undefined : 'true' })} dot={dotClass('green')} count={all.filter((s) => s.isActive).length}>Active</FilterChip>
            <FilterChip active={state.active === 'false'} onClick={() => set({ active: state.active === 'false' ? undefined : 'false' })} dot={dotClass('gray')} count={all.filter((s) => !s.isActive).length}>Inactive</FilterChip>
            <FilterChip active={state.backlog === 'true'} onClick={() => set({ backlog: state.backlog === 'true' ? undefined : 'true' })} dot={dotClass('blue')} count={all.filter((s) => s.pendingFindings > 0).length}>With findings to review</FilterChip>
          </>
        }
      >
        <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search name, customer or subnet…" className="w-64" />
        <Select className="w-48 h-8 py-0 text-[13px]" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </FilterBar>
      <div className="card overflow-hidden">
        <DataTable columns={columns} rows={items} loading={q.isLoading} dense onRowClick={(s) => navigate(`/cmdb/discovery/sources/${s.id}`)} rowClassName={(s) => (s.lastRunStatus === 'failed' ? 'row-rail-bad' : s.pendingFindings > 0 ? 'row-rail-warn' : undefined)} empty={<EmptyState icon={<Radar className="h-5 w-5" />} title="No discovery sources" description="A source is a set of subnets plus SNMP credentials for one customer site." action={canManage ? <Button size="sm" onClick={() => setDrawer(true)}>New source</Button> : undefined} />} />
        <div className="px-4 py-2 text-[12px] text-muted border-t border-default">{fmtNumber(items.length)} of {fmtNumber(all.length)} sources</div>
      </div>
      <SourceDrawer open={drawer} onClose={() => setDrawer(false)} source={null} providers={providers.data?.items ?? [{ type: 'network_scan', label: 'Network scan' }]} />
    </div>
  );
}
