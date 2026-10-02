import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Play } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Button, Select, DataTable, EmptyState, ErrorBlock, Pagination, FilterBar, FilterChip, type Column } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDateTime, fmtNumber } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { CmdbNav, DiscoveryNav } from '@/components/cmdb/CmdbNav';
import { RunStatusBadge, runSummary, runDurationText } from '@/components/cmdb/DiscoveryBits';
import { errorMessage } from '@/components/cmdb/hooks';
import { discoveryApi, discoveryKeys, RUN_COLORS, type DiscoveryRun } from '@/components/cmdb/api';

const STATUSES = ['running', 'queued', 'completed', 'failed', 'cancelled'];

/** Discovery runs across every source: what is scanning now and how past scans went. */
export default function RunsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { state, set, page, pageSize, setPage } = useListState();
  const customers = useCustomersLookup();
  const sources = useQuery({ queryKey: discoveryKeys.sources(state.customerId), queryFn: () => discoveryApi.sources(state.customerId), staleTime: 60_000 });
  const params = useMemo(() => ({ customerId: state.customerId || undefined, sourceId: state.sourceId || undefined, status: state.status || undefined, page, pageSize }), [state, page, pageSize]);
  const q = useQuery({ queryKey: discoveryKeys.runs(params), queryFn: () => discoveryApi.runs(params), placeholderData: (p) => p, refetchInterval: (x) => (x.state.data?.items.some((r) => r.status === 'running' || r.status === 'queued') ? 3000 : 15_000) });
  const cancel = useMutation({ mutationFn: (id: string) => discoveryApi.cancelRun(id), onSuccess: () => { toast.success('Run cancelled'); qc.invalidateQueries({ queryKey: discoveryKeys.all }); }, onError: (e) => toast.error(errorMessage(e)) });
  const items = q.data?.items ?? [];

  const columns: Column<DiscoveryRun>[] = [
    { key: 'status', header: 'Status', width: '120px', render: (r) => <RunStatusBadge status={r.status} /> },
    { key: 'source', header: 'Source', render: (r) => <div className="min-w-0"><div className="font-medium truncate">{r.sourceName ?? 'Source'}</div><div className="text-[11.5px] text-muted truncate">{r.customerName ?? ''}</div></div> },
    { key: 'startedAt', header: 'Started', width: '170px', render: (r) => <span className="text-muted whitespace-nowrap">{fmtDateTime(r.startedAt ?? r.createdAt)}</span> },
    { key: 'duration', header: 'Duration', width: '100px', render: (r) => runDurationText(r) },
    { key: 'summary', header: 'Result', render: (r) => <span className="text-[12.5px]">{runSummary(r)}</span> },
    { key: 'trigger', header: 'Trigger', width: '130px', render: (r) => <span className="text-muted">{r.triggeredByName ?? r.triggeredBy ?? 'schedule'}</span> },
    { key: 'actions', header: '', width: '90px', render: (r) => (r.status === 'running' || r.status === 'queued' ? <Button size="sm" variant="ghost" icon={<Ban className="h-3.5 w-3.5" />} loading={cancel.isPending && cancel.variables === r.id} onClick={(e) => { e.stopPropagation(); cancel.mutate(r.id); }}>Cancel</Button> : null) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Discovery runs" subtitle="Each scan of a source, with its outcome and log" actions={<Button size="sm" variant="outline" icon={<Play className="h-4 w-4" />} onClick={() => navigate('/cmdb/discovery/sources')}>Start a run</Button>} />
      <CmdbNav />
      <div className="flex flex-wrap items-center gap-2"><DiscoveryNav /></div>
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      <FilterBar
        activeCount={(state.customerId ? 1 : 0) + (state.sourceId ? 1 : 0) + (state.status ? 1 : 0)}
        onClear={() => set({ customerId: undefined, sourceId: undefined, status: undefined })}
        chips={STATUSES.map((st) => <FilterChip key={st} active={state.status === st} onClick={() => set({ status: state.status === st ? undefined : st })} dot={dotClass(RUN_COLORS[st])}>{st}</FilterChip>)}
      >
        <Select className="w-44 h-8 py-0 text-[13px]" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, sourceId: undefined })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <Select className="w-52 h-8 py-0 text-[13px]" value={state.sourceId ?? ''} onChange={(e) => set({ sourceId: e.target.value })} placeholder="All sources" options={(sources.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} />
      </FilterBar>
      <div className="card overflow-hidden">
        <DataTable columns={columns} rows={items} loading={q.isLoading} dense onRowClick={(r) => navigate(`/cmdb/discovery/runs/${r.id}`)} rowClassName={(r) => (r.status === 'failed' ? 'row-rail-bad' : r.status === 'running' || r.status === 'queued' ? 'row-rail-warn' : undefined)} empty={<EmptyState title="No runs yet" description="Open a source and press Run now, or set a schedule." />} />
        <Pagination page={page} pageSize={pageSize} total={q.data?.total ?? 0} onPage={setPage} />
      </div>
      <div className="text-[12px] text-subtle">{fmtNumber(q.data?.total ?? 0)} runs</div>
    </div>
  );
}
