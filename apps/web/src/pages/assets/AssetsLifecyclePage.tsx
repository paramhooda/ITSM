import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/api/client';
import { PageHeader, ModuleNav, Select, ErrorBlock, DataTable, Pagination, Badge, type Column } from '@/components/ui';
import { ASSET_MODULES } from '@/layouts/modules';
import { Panel, Stat, Skeleton } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtNumber, titleCase } from '@/lib/format';
import { LIFECYCLE_COLORS } from '@/lib/statusColors';
import { ASSET_LIFECYCLE } from '@itsm/shared';
import { CoverageBadge, LifecycleBadge, type Coverage } from '@/components/assets/CoverageBadge';
import { overviewApi, ovKeys, withQuery } from '@/components/overview/api';

interface AssetRow {
  id: string;
  tag: string;
  name: string;
  customerName?: string | null;
  siteName?: string | null;
  categoryLabel?: string | null;
  lifecycleStage: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  warranty: Coverage;
  amc: Coverage;
}

const STAGES = ASSET_LIFECYCLE as readonly string[];

/** Lifecycle module: the stage strip, end-of-life pressure, and the assets in the stage you pick. */
export default function AssetsLifecyclePage() {
  const navigate = useNavigate();
  const { state, set, page, pageSize, setPage } = useListState({ sort: 'updatedAt', order: 'desc' });
  const customers = useCustomersLookup();
  const customerId = state.customerId || undefined;
  const stage = STAGES.includes(state.stage) ? state.stage : undefined;

  const ov = useQuery({ queryKey: ovKeys.assets(customerId), queryFn: () => overviewApi.assets(customerId), refetchInterval: 60_000, placeholderData: (p) => p });
  const listParams = useMemo(() => ({ page, pageSize, sort: state.sort, order: state.order, customerId, lifecycleStage: stage }), [page, pageSize, state.sort, state.order, customerId, stage]);
  const list = useQuery({ queryKey: ['assets', 'list', listParams], queryFn: () => get<{ items: AssetRow[]; total: number }>('/assets', listParams), placeholderData: (p) => p });
  const d = ov.data;
  const counts = new Map((d?.byLifecycle ?? []).map((b) => [b.key, b.count]));
  const total = d?.total ?? 0;

  const columns: Column<AssetRow>[] = [
    { key: 'tag', header: 'Tag', sortable: true, width: '120px', render: (a) => <span className="font-mono text-[12.5px] font-medium">{a.tag}</span> },
    { key: 'name', header: 'Name', sortable: true, render: (a) => <span className="font-medium">{a.name}</span> },
    { key: 'categoryLabel', header: 'Category', render: (a) => a.categoryLabel ?? '—' },
    { key: 'customer', header: 'Customer', sortable: true, render: (a) => a.customerName ?? '—' },
    { key: 'siteName', header: 'Site', render: (a) => a.siteName ?? '—' },
    { key: 'model', header: 'Model / serial', render: (a) => (
      <div className="leading-tight">
        <div>{[a.manufacturer, a.model].filter(Boolean).join(' ') || '—'}</div>
        {a.serialNumber && <div className="text-xs text-subtle font-mono">{a.serialNumber}</div>}
      </div>
    ) },
    { key: 'lifecycleStage', header: 'Lifecycle', render: (a) => <LifecycleBadge stage={a.lifecycleStage} /> },
    { key: 'warrantyEnd', header: 'Warranty', sortable: true, render: (a) => <CoverageBadge coverage={a.warranty} /> },
    { key: 'amcEnd', header: 'AMC', sortable: true, render: (a) => <CoverageBadge coverage={a.amc} /> },
  ];
  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Lifecycle"
        subtitle="Where every asset sits in its life, and what is due for refresh"
        actions={<Select className="w-48 h-8 py-0 text-[13px]" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
      />
      <ModuleNav items={ASSET_MODULES} />
      {ov.isError && <ErrorBlock error={ov.error} retry={() => ov.refetch()} />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="By stage" subtitle={stage ? `Showing ${titleCase(stage)} · click again to clear` : 'Click a stage to list its assets'} className="lg:col-span-2" to={withQuery('/assets/inventory', { customerId })} toLabel="Inventory">
          {d ? (
            <BreakdownBar
              dense
              max={Math.max(1, ...STAGES.map((s) => counts.get(s) ?? 0))}
              items={STAGES.map((s) => ({ label: titleCase(s), value: counts.get(s) ?? 0, color: LIFECYCLE_COLORS[s] ?? 'slate', active: stage === s }))}
              onSelect={(i) => {
                const next = STAGES.find((s) => titleCase(s) === i.label);
                set({ stage: next && next !== stage ? next : undefined });
              }}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="End of life" subtitle="Deployed assets past, or approaching, their end-of-life date" to={withQuery('/assets/lifecycle', { stage: 'deployed', customerId })} toLabel="Deployed">
          {d ? (
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Past EOL" value={fmtNumber(d.eol.past)} tone={d.eol.past ? 'bad' : 'good'} />
              <Stat label="Within 90 d" value={fmtNumber(d.eol.d90)} tone={d.eol.d90 ? 'warn' : 'good'} />
              <Stat label="Within a year" value={fmtNumber(d.eol.d365)} tone={d.eol.d365 ? 'warn' : 'default'} />
            </div>
          ) : (
            <Skeleton rows={3} />
          )}
          {d && (
            <div className="mt-4 pt-3 border-t border-default grid grid-cols-2 gap-3">
              <Stat label="In repair" value={fmtNumber(counts.get('in_repair') ?? 0)} tone={counts.get('in_repair') ? 'warn' : 'good'} />
              <Stat label="Retired · disposed" value={`${fmtNumber(counts.get('retired') ?? 0)} · ${fmtNumber(counts.get('disposed') ?? 0)}`} />
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title={stage ? <span className="inline-flex items-center gap-2">Assets <Badge color={LIFECYCLE_COLORS[stage] ?? 'slate'}>{titleCase(stage)}</Badge></span> : 'All assets'}
        subtitle={list.data ? `${fmtNumber(list.data.total)} of ${fmtNumber(total)} assets` : undefined}
        padded={false}
        to={withQuery('/assets/inventory', { lifecycleStage: stage, customerId })}
        toLabel="Open in inventory"
      >
        {list.isError ? (
          <ErrorBlock error={list.error} retry={() => list.refetch()} />
        ) : (
          <>
            <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} dense onRowClick={(a) => navigate(`/assets/${a.id}`)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} empty={<div className="text-[13px] text-subtle py-8 text-center">{stage ? `No assets are ${titleCase(stage).toLowerCase()}` : 'No assets yet'}</div>} />
            <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Panel>
    </div>
  );
}
