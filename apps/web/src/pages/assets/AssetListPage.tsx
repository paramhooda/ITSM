import { useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Upload, Download, Server } from 'lucide-react';
import { toast } from 'sonner';
import { get, download, buildQuery } from '@/api/client';
import { PageHeader, Button, DataTable, Pagination, Select, SearchInput, StatTile, Badge, type Column } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { ASSET_LIFECYCLE } from '@itsm/shared';
import { AssetForm } from '@/components/assets/AssetForm';
import { ImportDialog } from '@/components/assets/ImportDialog';
import { CoverageBadge, LifecycleBadge, type Coverage } from '@/components/assets/CoverageBadge';
import { useSites, errorMessage } from '@/components/cmdb/hooks';

interface AssetRow {
  id: string;
  tag: string;
  name: string;
  customerId: string;
  customerName?: string | null;
  siteName?: string | null;
  categoryLabel?: string | null;
  statusLabel?: string | null;
  statusColor?: string | null;
  lifecycleStage: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  warrantyEnd?: string | null;
  amcEnd?: string | null;
  ciId?: string | null;
  ciName?: string | null;
  warranty: Coverage;
  amc: Coverage;
}
interface Summary { total: number; warrantyExpiring90: number; warrantyExpired: number; amcExpiring90: number; amcExpired: number; inRepair: number; withCi: number }

const DEFAULTS = { sort: 'createdAt', order: 'desc' };
const IMPORT_COLUMNS = ['tag', 'name', 'category', 'status', 'site', 'manufacturer', 'model', 'serialNumber', 'purchaseDate', 'purchaseCost', 'vendor', 'warrantyStart', 'warrantyEnd', 'amcStart', 'amcEnd', 'location', 'notes'];

export default function AssetListPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options } = useLookups();
  const customers = useCustomersLookup();
  const sites = useSites(state.customerId);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const query = useMemo(() => {
    const q: Record<string, unknown> = { page, pageSize, sort: state.sort, order: state.order, q: state.q, customerId: state.customerId, siteId: state.siteId, categoryId: state.categoryId, statusId: state.statusId, lifecycleStage: state.lifecycleStage };
    if (state.expiring === 'warranty30') q.warrantyExpiringDays = 30;
    if (state.expiring === 'warranty90') q.warrantyExpiringDays = 90;
    if (state.expiring === 'amc30') q.amcExpiringDays = 30;
    if (state.expiring === 'amc90') q.amcExpiringDays = 90;
    if (state.hasCi) q.hasCi = state.hasCi;
    return q;
  }, [state, page, pageSize]);
  const list = useQuery({ queryKey: ['assets', 'list', query], queryFn: () => get<{ items: AssetRow[]; total: number }>('/assets', query), placeholderData: (prev) => prev });
  const summary = useQuery({ queryKey: ['assets', 'summary', state.customerId ?? ''], queryFn: () => get<Summary>('/assets/summary', { customerId: state.customerId }) });

  const columns: Column<AssetRow>[] = [
    { key: 'tag', header: 'Tag', sortable: true, render: (a) => <span className="font-mono text-[12.5px] font-medium">{a.tag}</span> },
    { key: 'name', header: 'Name', sortable: true, render: (a) => <span className="font-medium">{a.name}</span> },
    { key: 'categoryLabel', header: 'Category' },
    { key: 'customer', header: 'Customer', sortable: true, render: (a) => a.customerName ?? '—' },
    { key: 'siteName', header: 'Site' },
    { key: 'model', header: 'Model / serial', render: (a) => (
      <div className="leading-tight">
        <div>{[a.manufacturer, a.model].filter(Boolean).join(' ') || '—'}</div>
        {a.serialNumber && <div className="text-xs text-subtle font-mono">{a.serialNumber}</div>}
      </div>
    ) },
    { key: 'status', header: 'Status', render: (a) => (
      <div className="flex items-center gap-1.5">
        {a.statusLabel ? <Badge color={a.statusColor ?? undefined} dot>{a.statusLabel}</Badge> : <LifecycleBadge stage={a.lifecycleStage} />}
      </div>
    ) },
    { key: 'warrantyEnd', header: 'Warranty', sortable: true, render: (a) => <CoverageBadge coverage={a.warranty} /> },
    { key: 'amcEnd', header: 'AMC', sortable: true, render: (a) => <CoverageBadge coverage={a.amc} /> },
    { key: 'ci', header: 'CI', render: (a) => a.ciId ? (
      <Link to={`/cmdb/${a.ciId}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-brand-600 hover:underline">
        <Server className="h-3.5 w-3.5" /> {a.ciName}
      </Link>
    ) : <span className="text-subtle">—</span> },
  ];

  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false);
  const categoryChips = options('asset_category');
  const exportCsv = () => download(`/assets/export.csv${buildQuery({ ...query, page: undefined, pageSize: undefined })}`, `assets-${new Date().toISOString().slice(0, 10)}.csv`).catch((e) => toast.error(errorMessage(e)));

  return (
    <div>
      <PageHeader
        title="Assets"
        subtitle="Financial and lifecycle register of customer equipment"
        actions={
          <>
            <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} onClick={exportCsv}>Export CSV</Button>
            {can('assets:manage') && <Button variant="outline" size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => setImportOpen(true)}>Import CSV</Button>}
            {can('assets:manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New asset</Button>}
          </>
        }
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatTile label="Total assets" value={summary.data?.total ?? '—'} hint={summary.data ? `${summary.data.withCi} linked to CIs` : undefined} onClick={() => set({ expiring: undefined, lifecycleStage: undefined })} />
        <StatTile label="Warranty expiring (90d)" value={summary.data?.warrantyExpiring90 ?? '—'} tone={summary.data?.warrantyExpiring90 ? 'warn' : 'default'} hint={summary.data ? `${summary.data.warrantyExpired} already expired` : undefined} onClick={() => set({ expiring: 'warranty90' })} />
        <StatTile label="AMC expiring (90d)" value={summary.data?.amcExpiring90 ?? '—'} tone={summary.data?.amcExpiring90 ? 'warn' : 'default'} hint={summary.data ? `${summary.data.amcExpired} already expired` : undefined} onClick={() => set({ expiring: 'amc90' })} />
        <StatTile label="In repair" value={summary.data?.inRepair ?? '—'} tone={summary.data?.inRepair ? 'bad' : 'default'} onClick={() => set({ lifecycleStage: 'in_repair' })} />
      </div>
      <div className="card mb-3 p-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2 items-center">
          <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search tag, name, serial, model…" className="w-64" />
          <Select className="w-52" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, siteId: undefined })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <Select className="w-44" value={state.siteId ?? ''} disabled={!state.customerId} onChange={(e) => set({ siteId: e.target.value })} placeholder="All sites" options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))} />
          <Select className="w-40" value={state.statusId ?? ''} onChange={(e) => set({ statusId: e.target.value })} placeholder="Any status" options={options('asset_status').map((o) => ({ value: o.id, label: o.label }))} />
          <Select className="w-40" value={state.lifecycleStage ?? ''} onChange={(e) => set({ lifecycleStage: e.target.value })} placeholder="Any lifecycle" options={ASSET_LIFECYCLE.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} />
          <Select className="w-44" value={state.expiring ?? ''} onChange={(e) => set({ expiring: e.target.value })} placeholder="Any coverage" options={[{ value: 'warranty30', label: 'Warranty ≤ 30 days' }, { value: 'warranty90', label: 'Warranty ≤ 90 days' }, { value: 'amc30', label: 'AMC ≤ 30 days' }, { value: 'amc90', label: 'AMC ≤ 90 days' }]} />
          <Select className="w-36" value={state.hasCi ?? ''} onChange={(e) => set({ hasCi: e.target.value })} placeholder="CI: any" options={[{ value: 'true', label: 'Linked to CI' }, { value: 'false', label: 'No CI' }]} />
          {Object.keys(state).some((k) => !(k in DEFAULTS) && k !== 'page') && <Button variant="ghost" size="sm" onClick={() => set(Object.fromEntries(Object.keys(state).filter((k) => !(k in DEFAULTS)).map((k) => [k, undefined])))}>Clear</Button>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => set({ categoryId: undefined })} className={cn('px-2 py-0.5 rounded-md text-[12px] border', !state.categoryId ? 'bg-brand-600 text-white border-brand-600' : 'border-default text-muted hover:text-default')}>All categories</button>
          {categoryChips.map((c) => (
            <button key={c.id} onClick={() => set({ categoryId: state.categoryId === c.id ? undefined : c.id })} className={cn('px-2 py-0.5 rounded-md text-[12px] border', state.categoryId === c.id ? 'bg-brand-600 text-white border-brand-600' : 'border-default text-muted hover:text-default')}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} onRowClick={(a) => navigate(`/assets/${a.id}`)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} dense />
        <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
      </div>
      <AssetForm open={createOpen} onClose={() => setCreateOpen(false)} defaultCustomerId={state.customerId} onSaved={(a) => navigate(`/assets/${a.id}`)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} title="Import assets from CSV" endpoint="/assets/import" templatePath="/assets/import/template.csv" templateName="assets-import-template.csv" columns={IMPORT_COLUMNS} customerId={state.customerId} onDone={() => { list.refetch(); summary.refetch(); }} />
    </div>
  );
}
