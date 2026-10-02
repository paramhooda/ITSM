import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Play } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Button, DataTable, EmptyState, ErrorBlock, Pagination, ListShell, FilterGroup, FilterOptions, FilterSelect, type AppliedFilter, type Column } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDateTime, fmtNumber, titleCase } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { CMDB_MODULES } from '@/layouts/modules';
import { DiscoveryNav } from '@/components/cmdb/CmdbNav';
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
  const customerItems = customers.data?.items ?? [];
  const sourceItems = sources.data?.items ?? [];

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode, keys: string[] = [key]) => applied.push({ key, label, onRemove: () => set(Object.fromEntries(keys.map((k) => [k, undefined]))) });
  if (state.status) addApplied('status', `Status: ${titleCase(state.status)}`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`, ['customerId', 'sourceId']);
  if (state.sourceId) addApplied('sourceId', `Source: ${sourceItems.find((s) => s.id === state.sourceId)?.name ?? '…'}`);
  const total = q.data?.total;

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
      <ListShell
        id="discovery-runs"
        modules={CMDB_MODULES}
        filters={
          <>
            <FilterGroup label="Status">
              <FilterOptions options={STATUSES.map((st) => ({ value: st, label: titleCase(st), dot: dotClass(RUN_COLORS[st]) }))} value={state.status} onChange={(v) => set({ status: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Customer">
              <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, sourceId: undefined })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
            </FilterGroup>
            <FilterGroup label="Source">
              <FilterSelect value={state.sourceId ?? ''} onChange={(e) => set({ sourceId: e.target.value })} placeholder="All sources" options={sourceItems.map((s) => ({ value: s.id, label: s.name }))} />
            </FilterGroup>
          </>
        }
        applied={applied}
        activeCount={applied.length}
        onClear={() => set({ customerId: undefined, sourceId: undefined, status: undefined })}
        count={total !== undefined ? `${fmtNumber(total)} ${total === 1 ? 'run' : 'runs'}` : undefined}
        quick={<DiscoveryNav />}
      >
        {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
        <div className="card overflow-hidden">
          <DataTable columns={columns} rows={items} loading={q.isLoading} dense onRowClick={(r) => navigate(`/cmdb/discovery/runs/${r.id}`)} rowClassName={(r) => (r.status === 'failed' ? 'row-rail-bad' : r.status === 'running' || r.status === 'queued' ? 'row-rail-warn' : undefined)} empty={<EmptyState title="No runs yet" description="Open a source and press Run now, or set a schedule." />} />
          <Pagination page={page} pageSize={pageSize} total={q.data?.total ?? 0} onPage={setPage} />
        </div>
      </ListShell>
    </div>
  );
}
