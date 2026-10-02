import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/api/client';
import { PageHeader, ModuleNav, Select, ErrorBlock, DataTable, type Column } from '@/components/ui';
import { ASSET_MODULES } from '@/layouts/modules';
import { Panel, Segmented, Skeleton } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtNumber } from '@/lib/format';
import { CoverageBadge, LifecycleBadge, type Coverage } from '@/components/assets/CoverageBadge';
import { overviewApi, ovKeys, withQuery } from '@/components/overview/api';
import { coverageItems, coverageTotal, COVER_LABEL, type CoverKind } from '@/components/overview/coverage';

interface ExpiringRow {
  id: string;
  tag: string;
  name: string;
  customerId: string;
  customerName: string | null;
  siteName: string | null;
  model: string | null;
  serialNumber: string | null;
  warrantyEnd: string | null;
  amcEnd: string | null;
  lifecycleStage: string;
  coverage: Coverage;
}

const WINDOWS = [30, 90, 180] as const;

/** Warranty & AMC module: how cover is distributed in time, and the assets that lose it next. */
export default function AssetsCoveragePage() {
  const navigate = useNavigate();
  const { state, set } = useListState({ kind: 'warranty', days: '90' });
  const customers = useCustomersLookup();
  const customerId = state.customerId || undefined;
  const kind: CoverKind = state.kind === 'amc' ? 'amc' : 'warranty';
  const days = WINDOWS.includes(Number(state.days) as (typeof WINDOWS)[number]) ? Number(state.days) : 90;

  const ov = useQuery({ queryKey: ovKeys.assets(customerId), queryFn: () => overviewApi.assets(customerId), refetchInterval: 60_000, placeholderData: (p) => p });
  const expiring = useQuery({ queryKey: ['assets', 'expiring', { kind, days, customerId }], queryFn: () => get<{ items: ExpiringRow[]; kind: string; days: number }>('/assets/expiring', { kind, days, customerId, limit: 200 }), placeholderData: (p) => p });
  const d = ov.data;

  const columns: Column<ExpiringRow>[] = [
    { key: 'tag', header: 'Tag', width: '120px', render: (a) => <span className="font-mono text-[12.5px] font-medium">{a.tag}</span> },
    { key: 'name', header: 'Name', render: (a) => <span className="font-medium">{a.name}</span> },
    { key: 'customerName', header: 'Customer', render: (a) => a.customerName ?? '—' },
    { key: 'siteName', header: 'Site', render: (a) => a.siteName ?? '—' },
    { key: 'model', header: 'Model / serial', render: (a) => (
      <div className="leading-tight">
        <div>{a.model ?? '—'}</div>
        {a.serialNumber && <div className="text-xs text-subtle font-mono">{a.serialNumber}</div>}
      </div>
    ) },
    { key: 'lifecycleStage', header: 'Lifecycle', render: (a) => <LifecycleBadge stage={a.lifecycleStage} /> },
    { key: 'end', header: `${COVER_LABEL[kind]} ends`, render: (a) => <CoverageBadge coverage={a.coverage} /> },
  ];
  const rows = expiring.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Warranty & AMC"
        subtitle="Which assets lose cover next, and which already have"
        actions={<Select className="w-48 h-8 py-0 text-[13px]" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value }, false)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
      />
      <ModuleNav items={ASSET_MODULES} />
      {ov.isError && <ErrorBlock error={ov.error} retry={() => ov.refetch()} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(['warranty', 'amc'] as const).map((k) => (
          <Panel key={k} title={COVER_LABEL[k]} subtitle={d ? `${fmtNumber(coverageTotal(d[k]))} assets · ${fmtNumber(d[k].expired)} expired · ${fmtNumber(d[k].d30 + d[k].d90)} ending within 90 days` : 'By how soon cover ends'} to={withQuery('/assets/inventory', { expiring: `${k}90`, customerId })} toLabel="Ending ≤ 90 d">
            {d ? <BreakdownBar dense items={coverageItems(k, d[k], customerId)} /> : <Skeleton rows={5} />}
          </Panel>
        ))}
      </div>

      <Panel
        title="Ending soonest"
        subtitle={`${COVER_LABEL[kind]} cover ending within ${days} days, soonest first`}
        padded={false}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented size="sm" value={kind} onChange={(v) => set({ kind: v }, false)} options={[{ value: 'warranty', label: 'Warranty' }, { value: 'amc', label: 'AMC' }]} />
            <Segmented size="sm" value={days} onChange={(v) => set({ days: v }, false)} options={WINDOWS.map((w) => ({ value: w, label: `${w} days` }))} />
          </div>
        }
      >
        {expiring.isError ? (
          <ErrorBlock error={expiring.error} retry={() => expiring.refetch()} />
        ) : (
          <>
            <DataTable columns={columns} rows={rows} loading={expiring.isLoading} dense onRowClick={(a) => navigate(`/assets/${a.id}`)} rowClassName={(a) => (a.coverage.status === 'expired' ? 'row-rail-bad' : a.coverage.status === 'expiring' && (a.coverage.days ?? 99) <= 30 ? 'row-rail-warn' : undefined)} empty={<div className="text-[13px] text-subtle py-8 text-center">No {COVER_LABEL[kind]} cover ends within {days} days</div>} />
            {rows.length > 0 && <div className="text-[12.5px] text-muted px-4 py-2.5 border-t border-default">{fmtNumber(rows.length)} {rows.length === 1 ? 'asset' : 'assets'}{rows.length >= 200 ? ' · showing the first 200' : ''}</div>}
          </>
        )}
      </Panel>
    </div>
  );
}
