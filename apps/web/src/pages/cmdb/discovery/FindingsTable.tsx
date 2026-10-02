import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Badge, Select, SearchInput, DataTable, EmptyState, Pagination, FilterBar, FilterChip, type Column } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useAuthStore } from '@/stores/auth';
import { dotClass } from '@/lib/utils';
import { CiTypeBadge } from '@/components/cmdb/CiTypeBadge';
import { DiffBadge, FindingStatusBadge, RunLink } from '@/components/cmdb/DiscoveryBits';
import { errorMessage } from '@/components/cmdb/hooks';
import { discoveryApi, discoveryKeys, DIFF_COLORS, FINDING_STATUS_COLORS, type Finding } from '@/components/cmdb/api';

/**
 * The review queue: findings with filters, multi-select and apply/ignore. Used on the
 * global Findings page, inside a source record and inside a run record.
 */
export function FindingsTable({ sourceId, runId, customerId, showSource = false, defaultStatus = 'pending', extraFilters }: { sourceId?: string; runId?: string; customerId?: string; showSource?: boolean; defaultStatus?: string; extraFilters?: React.ReactNode }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canApply = can('discovery:run', 'discovery:manage');
  const { state, set, page, pageSize, setPage } = useListState({ status: defaultStatus });
  const params = useMemo(() => ({ sourceId: sourceId ?? state.sourceId, runId, customerId: customerId ?? state.customerId, status: state.status || undefined, diffStatus: state.diffStatus || undefined, q: state.q || undefined, page, pageSize, sort: 'ipAddress', order: 'asc' }), [sourceId, runId, customerId, state, page, pageSize]);
  const q = useQuery({ queryKey: discoveryKeys.findings(params), queryFn: () => discoveryApi.findings(params), placeholderData: (p) => p });
  const statsParams = useMemo(() => ({ sourceId: sourceId ?? state.sourceId, runId, customerId: customerId ?? state.customerId }), [sourceId, runId, customerId, state.sourceId, state.customerId]);
  const stats = useQuery({ queryKey: discoveryKeys.findingStats(statsParams), queryFn: () => discoveryApi.findingStats(statsParams), staleTime: 30_000 });
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSelected([]), [params]);
  const invalidate = () => { qc.invalidateQueries({ queryKey: discoveryKeys.all }); qc.invalidateQueries({ queryKey: ['cmdb'] }); };
  const act = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'apply' | 'ignore' }) => discoveryApi.act(id, action), onSuccess: (r, v) => { toast.success(v.action === 'apply' ? `${r.created ? 'Created' : 'Updated'} CI ${r.ciName ?? ''}` : 'Finding ignored'); invalidate(); }, onError: (e) => toast.error(errorMessage(e)) });
  const bulk = useMutation({ mutationFn: (action: 'apply' | 'ignore') => discoveryApi.bulk(selected, action), onSuccess: (r) => { toast[r.failed ? 'warning' : 'success'](`${r.applied} processed${r.failed ? `, ${r.failed} failed` : ''}`); setSelected([]); invalidate(); }, onError: (e) => toast.error(errorMessage(e)) });
  const items = q.data?.items ?? [];
  const pendingIds = items.filter((f) => f.status === 'pending').map((f) => f.id);
  const allSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.includes(id));
  const byStatus = stats.data?.byStatus ?? {};
  const byDiff = stats.data?.byDiff ?? {};

  const columns: Column<Finding>[] = [
    ...(canApply ? [{ key: 'sel', header: <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? pendingIds : [])} aria-label="Select all pending" />, width: '32px', render: (f: Finding) => (f.status === 'pending' ? <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={selected.includes(f.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setSelected((ids) => (e.target.checked ? [...ids, f.id] : ids.filter((x) => x !== f.id)))} aria-label="Select" /> : null) }] : []),
    { key: 'ip', header: 'Device', render: (f) => <div className="leading-tight"><div className="font-mono text-[12.5px] font-medium">{f.ipAddress}</div><div className="text-[11.5px] text-muted truncate">{f.hostname ?? f.fqdn ?? <span className="text-subtle">no hostname</span>}</div></div> },
    { key: 'type', header: 'Class', width: '150px', render: (f) => <CiTypeBadge typeKey={f.suggestedTypeKey ?? 'other'} /> },
    { key: 'model', header: 'Manufacturer / model', render: (f) => <span className="text-[12.5px]">{[f.manufacturer, f.model].filter(Boolean).join(' ') || <span className="text-subtle">—</span>}</span> },
    { key: 'serial', header: 'Serial', width: '130px', render: (f) => <span className="font-mono text-xs">{f.serialNumber ?? '—'}</span> },
    { key: 'ports', header: 'Signals', render: (f) => <div className="flex flex-wrap gap-1 max-w-[220px]">{f.openPorts.slice(0, 6).map((p) => <Badge key={p} color="slate">{p}</Badge>)}{f.openPorts.length > 6 && <Badge color="slate">+{f.openPorts.length - 6}</Badge>}{(f.raw as { snmp?: boolean })?.snmp && <Badge color="indigo">snmp</Badge>}</div> },
    { key: 'match', header: 'Matched CI', width: '170px', render: (f) => (f.matchedCiId ? <Link to={`/cmdb/cis/${f.matchedCiId}`} onClick={(e) => e.stopPropagation()} className="text-brand-700 hover:underline truncate block max-w-[160px]">{f.matchedCiName ?? 'CI'}</Link> : <span className="text-subtle">new device</span>) },
    { key: 'diff', header: 'Diff', width: '100px', render: (f) => <DiffBadge diff={f.diffStatus} /> },
    { key: 'status', header: 'Status', width: '110px', render: (f) => <FindingStatusBadge status={f.status} /> },
    ...(showSource ? [{ key: 'run', header: 'Run', width: '90px', render: (f: Finding) => <RunLink run={{ id: f.runId, status: '', startedAt: null, createdAt: f.createdAt }} /> }] : []),
    { key: 'actions', header: '', width: '150px', render: (f) => (f.status === 'pending' && canApply ? <div className="flex gap-1" onClick={(e) => e.stopPropagation()}><Button size="sm" variant="outline" onClick={() => act.mutate({ id: f.id, action: 'apply' })} loading={act.isPending && act.variables?.id === f.id}>{f.matchedCiId ? 'Update' : 'Create'}</Button><Button size="sm" variant="ghost" onClick={() => act.mutate({ id: f.id, action: 'ignore' })}>Ignore</Button></div> : null) },
  ];

  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        activeCount={(state.q ? 1 : 0) + (state.diffStatus ? 1 : 0) + (state.status !== defaultStatus ? 1 : 0)}
        onClear={() => set({ q: undefined, diffStatus: undefined, status: defaultStatus })}
        trailing={selected.length > 0 ? <div className="flex items-center gap-2 text-[12.5px]"><span className="text-muted">{selected.length} selected</span><Button size="sm" icon={<Check className="h-3.5 w-3.5" />} loading={bulk.isPending} onClick={() => bulk.mutate('apply')}>Apply</Button><Button size="sm" variant="outline" icon={<X className="h-3.5 w-3.5" />} loading={bulk.isPending} onClick={() => bulk.mutate('ignore')}>Ignore</Button></div> : undefined}
        chips={
          <>
            {['pending', 'applied', 'ignored'].map((st) => <FilterChip key={st} active={state.status === st} onClick={() => set({ status: state.status === st ? '' : st })} dot={dotClass(FINDING_STATUS_COLORS[st])} count={byStatus[st] ?? 0}>{st === 'pending' ? 'To review' : st === 'applied' ? 'Applied' : 'Ignored'}</FilterChip>)}
            <span className="mx-1 h-4 w-px bg-[var(--border)]" aria-hidden />
            {['new', 'changed', 'unchanged'].map((d) => <FilterChip key={d} active={state.diffStatus === d} onClick={() => set({ diffStatus: state.diffStatus === d ? undefined : d })} dot={dotClass(DIFF_COLORS[d])} count={byDiff[d] ?? 0}>{d === 'new' ? 'New devices' : d === 'changed' ? 'Changed' : 'Unchanged'}</FilterChip>)}
          </>
        }
      >
        <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="IP, hostname, serial…" className="w-56" />
        {extraFilters}
        {!sourceId && !runId && <Select className="w-36 h-8 py-0 text-[13px]" value={state.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="Any status" options={['pending', 'applied', 'ignored'].map((v) => ({ value: v, label: v === 'pending' ? 'To review' : v }))} />}
      </FilterBar>
      <div className="card overflow-hidden">
        <DataTable columns={columns} rows={items} loading={q.isLoading} dense onRowClick={(f) => navigate(`/cmdb/discovery/findings/${f.id}`)} rowClassName={(f) => (f.status === 'pending' && f.diffStatus === 'new' ? 'row-rail-good' : f.status === 'pending' && f.diffStatus === 'changed' ? 'row-rail-warn' : undefined)} empty={<EmptyState title="No findings" description={state.status === 'pending' ? 'Nothing waiting for review. Run a scan or change the status filter.' : 'No findings match the filters.'} />} />
        <Pagination page={page} pageSize={pageSize} total={q.data?.total ?? 0} onPage={setPage} />
      </div>
    </div>
  );
}
