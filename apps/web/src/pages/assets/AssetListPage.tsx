import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Upload, Download, Server, Boxes, ShieldCheck, FileSignature, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { get, download, buildQuery } from '@/api/client';
import { PageHeader, Button, DataTable, Pagination, Badge, ListShell, FilterGroup, FilterOptions, FilterSelect, type AppliedFilter, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber, titleCase } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { LIFECYCLE_COLORS, COVERAGE_COLORS } from '@/lib/statusColors';
import { ASSET_MODULES } from '@/layouts/modules';
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
interface Summary {
  total: number;
  warrantyExpiring90: number;
  warrantyExpired: number;
  amcExpiring90: number;
  amcExpired: number;
  inRepair: number;
  withCi: number;
  byCategory: { id: string | null; label: string | null; count: number }[];
  byStatus: { id: string | null; label: string | null; color: string | null; count: number }[];
  byLifecycle: { stage: string; count: number }[];
}

const DEFAULTS = { sort: 'createdAt', order: 'desc' };
const FILTER_KEYS = ['q', 'customerId', 'siteId', 'categoryId', 'statusId', 'lifecycleStage', 'expiring', 'hasCi'];
/** One URL key (`expiring`) covers both "ends soon" and "already lapsed"; the query builder maps it onto the API's two parameters. */
const COVERAGE_OPTIONS = [
  { value: 'warranty30', label: 'Warranty ends ≤ 30 days', color: COVERAGE_COLORS.expiring },
  { value: 'warranty90', label: 'Warranty ends ≤ 90 days', color: COVERAGE_COLORS.expiring },
  { value: 'warrantyExpired', label: 'Warranty expired', color: COVERAGE_COLORS.expired },
  { value: 'amc30', label: 'AMC ends ≤ 30 days', color: COVERAGE_COLORS.expiring },
  { value: 'amc90', label: 'AMC ends ≤ 90 days', color: COVERAGE_COLORS.expiring },
  { value: 'amcExpired', label: 'AMC expired', color: COVERAGE_COLORS.expired },
];
const CI_LINK_OPTIONS = [
  { value: 'true', label: 'Linked to a CI' },
  { value: 'false', label: 'Without a CI' },
];
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
    if (state.expiring === 'warrantyExpired') q.expired = 'warranty';
    if (state.expiring === 'amcExpired') q.expired = 'amc';
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
      <Link to={`/cmdb/cis/${a.ciId}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-brand-600 hover:underline">
        <Server className="h-3.5 w-3.5" /> {a.ciName}
      </Link>
    ) : <span className="text-subtle">—</span> },
  ];

  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false);
  const categories = options('asset_category');
  const statuses = options('asset_status');
  const customerItems = customers.data?.items ?? [];
  const siteItems = sites.data ?? [];
  const sm = summary.data;
  const countByCategory = new Map((sm?.byCategory ?? []).map((c) => [c.id ?? '', c.count]));
  const countByStatus = new Map((sm?.byStatus ?? []).map((b) => [b.id ?? '', b.count]));
  const countByLifecycle = new Map((sm?.byLifecycle ?? []).map((b) => [b.stage, b.count]));
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));
  const exportCsv = () => download(`/assets/export.csv${buildQuery({ ...query, page: undefined, pageSize: undefined })}`, `assets-${new Date().toISOString().slice(0, 10)}.csv`).catch((e) => toast.error(errorMessage(e)));

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode, keys: string[] = [key]) => applied.push({ key, label, onRemove: () => set(Object.fromEntries(keys.map((k) => [k, undefined]))) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (state.categoryId) addApplied('categoryId', `Category: ${categories.find((c) => c.id === state.categoryId)?.label ?? '…'}`);
  if (state.lifecycleStage) addApplied('lifecycleStage', `Lifecycle: ${titleCase(state.lifecycleStage)}`);
  if (state.statusId) addApplied('statusId', `Status: ${statuses.find((o) => o.id === state.statusId)?.label ?? '…'}`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`, ['customerId', 'siteId']);
  if (state.siteId) addApplied('siteId', `Site: ${siteItems.find((s) => s.id === state.siteId)?.name ?? '…'}`);
  if (state.expiring) addApplied('expiring', `Coverage: ${COVERAGE_OPTIONS.find((o) => o.value === state.expiring)?.label ?? state.expiring}`);
  if (state.hasCi) addApplied('hasCi', CI_LINK_OPTIONS.find((o) => o.value === state.hasCi)?.label ?? `CI: ${state.hasCi}`);
  const total = list.data?.total;

  const rail = (
    <>
      <FilterGroup label="Category">
        <FilterOptions options={categories.map((c) => ({ value: c.id, label: c.label, count: sm ? countByCategory.get(c.id) ?? 0 : undefined }))} value={state.categoryId} onChange={(v) => set({ categoryId: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Lifecycle stage">
        <FilterOptions options={ASSET_LIFECYCLE.map((stage) => ({ value: stage, label: titleCase(stage), dot: dotClass(LIFECYCLE_COLORS[stage]), count: sm ? countByLifecycle.get(stage) ?? 0 : undefined }))} value={state.lifecycleStage} onChange={(v) => set({ lifecycleStage: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Status">
        <FilterOptions options={statuses.map((o) => ({ value: o.id, label: o.label, dot: dotClass(o.color), count: sm ? countByStatus.get(o.id) ?? 0 : undefined }))} value={state.statusId} onChange={(v) => set({ statusId: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Customer">
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, siteId: undefined })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
      <FilterGroup label="Site" hint={state.customerId ? undefined : 'Choose a customer first'}>
        <FilterSelect value={state.siteId ?? ''} disabled={!state.customerId} onChange={(e) => set({ siteId: e.target.value })} placeholder="All sites" options={siteItems.map((s) => ({ value: s.id, label: s.name }))} />
      </FilterGroup>
      <FilterGroup label="Coverage">
        <FilterOptions options={COVERAGE_OPTIONS.map((o) => ({ value: o.value, label: o.label, dot: dotClass(o.color) }))} value={state.expiring} onChange={(v) => set({ expiring: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="CMDB link">
        <FilterOptions options={CI_LINK_OPTIONS} value={state.hasCi} onChange={(v) => set({ hasCi: v as string | undefined })} />
      </FilterGroup>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Assets"
        subtitle="Lifecycle and coverage register of customer equipment"
        actions={can('assets:manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New asset</Button>}
      />
      <ListShell
        id="assets"
        modules={ASSET_MODULES}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search tag, name, serial, model…' }}
        filters={rail}
        applied={applied}
        activeCount={applied.length}
        onClear={clear}
        count={total !== undefined ? `${fmtNumber(total)} ${total === 1 ? 'asset' : 'assets'}` : undefined}
        toolbar={
          <>
            <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} onClick={exportCsv}>Export CSV</Button>
            {can('assets:manage') && <Button variant="outline" size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => setImportOpen(true)}>Import CSV</Button>}
          </>
        }
        insights={
          <InsightBand
            id="assets"
            loading={summary.isLoading}
            summary={sm ? `${fmtNumber(sm.total)} assets${state.customerId ? ' for this customer' : ''}` : undefined}
            kpis={
              sm
                ? [
                    { label: 'Total assets', value: fmtNumber(sm.total), icon: <Boxes className="h-4 w-4" />, hint: `${fmtNumber(sm.withCi)} linked to CIs`, onClick: () => set({ expiring: undefined, lifecycleStage: undefined }) },
                    { label: 'Warranty expiring · 90d', value: fmtNumber(sm.warrantyExpiring90), tone: sm.warrantyExpiring90 ? 'warn' : 'good', icon: <ShieldCheck className="h-4 w-4" />, hint: `${fmtNumber(sm.warrantyExpired)} already expired`, onClick: () => set({ expiring: state.expiring === 'warranty90' ? undefined : 'warranty90' }) },
                    { label: 'AMC expiring · 90d', value: fmtNumber(sm.amcExpiring90), tone: sm.amcExpiring90 ? 'warn' : 'good', icon: <FileSignature className="h-4 w-4" />, hint: `${fmtNumber(sm.amcExpired)} already expired`, onClick: () => set({ expiring: state.expiring === 'amc90' ? undefined : 'amc90' }) },
                    { label: 'In repair', value: fmtNumber(sm.inRepair), tone: sm.inRepair ? 'bad' : 'good', icon: <Wrench className="h-4 w-4" />, hint: 'out of service right now', onClick: () => set({ lifecycleStage: state.lifecycleStage === 'in_repair' ? undefined : 'in_repair' }) },
                  ]
                : []
            }
            panels={
              sm && (
                <>
                  <Panel title="By lifecycle" subtitle="Click a stage to filter">
                    <BreakdownBar
                      dense
                      items={ASSET_LIFECYCLE.map((stage) => ({ label: titleCase(stage), value: sm.byLifecycle.find((b) => b.stage === stage)?.count ?? 0, color: LIFECYCLE_COLORS[stage], active: state.lifecycleStage === stage })).filter((i) => i.value > 0)}
                      onSelect={(i) => {
                        const stage = ASSET_LIFECYCLE.find((st) => titleCase(st) === i.label);
                        if (stage) set({ lifecycleStage: state.lifecycleStage === stage ? undefined : stage });
                      }}
                    />
                  </Panel>
                  <Panel title="By status" subtitle="Operational status">
                    <BreakdownBar dense items={sm.byStatus.map((b) => ({ label: b.label ?? 'No status', value: b.count, color: b.color, active: !!b.id && state.statusId === b.id }))} onSelect={(i) => { const b = sm.byStatus.find((x) => (x.label ?? 'No status') === i.label); if (b?.id) set({ statusId: state.statusId === b.id ? undefined : b.id }); }} />
                  </Panel>
                </>
              )
            }
          />
        }
      >
        <div className="card overflow-hidden">
          <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} onRowClick={(a) => navigate(`/assets/${a.id}`)} rowClassName={(a) => (a.warranty?.status === 'expired' && a.amc?.status === 'expired' ? 'row-rail-bad' : a.warranty?.status === 'expiring' || a.amc?.status === 'expiring' ? 'row-rail-warn' : undefined)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} dense />
          <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
        </div>
      </ListShell>
      <AssetForm open={createOpen} onClose={() => setCreateOpen(false)} defaultCustomerId={state.customerId} onSaved={(a) => navigate(`/assets/${a.id}`)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} title="Import assets from CSV" endpoint="/assets/import" templatePath="/assets/import/template.csv" templateName="assets-import-template.csv" columns={IMPORT_COLUMNS} customerId={state.customerId} onDone={() => { list.refetch(); summary.refetch(); }} />
    </div>
  );
}
