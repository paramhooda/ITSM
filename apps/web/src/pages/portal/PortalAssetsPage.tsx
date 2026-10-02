import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Boxes, Server, Ticket } from 'lucide-react';
import { PageHeader, Button, DataTable, Pagination, Badge, EmptyState, ErrorBlock, Drawer, KeyValue, ListShell, FilterGroup, FilterOptions, FilterSelect, type Column, type AppliedFilter } from '@/components/ui';
import { PORTAL_ASSET_MODULES } from '@/layouts/modules';
import { Segmented } from '@/components/dashboards/Panel';
import { useListState } from '@/hooks/useListState';
import { useLookups } from '@/hooks/useLookups';
import { fmtNumber, titleCase } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { CoverageBadge } from '@/components/assets/CoverageBadge';
import { portalApi, pk, ASSET_EXPIRING_OPTIONS, ASSET_EXPIRING_LABELS, type PortalAsset, type PortalCi, type AssetExpiring } from '@/components/portal/api';
import { CRITICALITY_COLORS, CI_STATUS_COLORS, LIFECYCLE_COLORS } from '@/lib/statusColors';
import { ASSET_LIFECYCLE } from '@itsm/shared';

type Tab = 'assets' | 'cis';
const PAGE = 50;
const CI_STATUSES = ['active', 'maintenance', 'inactive', 'planned', 'retired'];
const CI_CRITICALITIES = ['critical', 'high', 'medium', 'low'];
const ASSET_FILTERS = ['q', 'siteId', 'categoryId', 'lifecycleStage', 'expiring'];
const CI_FILTERS = ['q', 'siteId', 'typeId', 'status', 'criticality'];
const TAB_RESET = { q: undefined, siteId: undefined, categoryId: undefined, lifecycleStage: undefined, expiring: undefined, typeId: undefined, status: undefined, criticality: undefined, sort: undefined, order: undefined, asset: undefined };

function toCsv(rows: Record<string, unknown>[], columns: { key: string; header: string }[]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.header)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\n');
}

function saveCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Inventory module of the portal's Assets: every asset and configuration item we look after, with its cover. */
export default function PortalAssetsPage() {
  const navigate = useNavigate();
  const { state, set, page, setPage } = useListState({ tab: 'assets' });
  const tab = (state.tab as Tab) === 'cis' ? 'cis' : 'assets';
  const { options, lookups } = useLookups();
  const me = useQuery({ queryKey: pk.me, queryFn: portalApi.me, staleTime: 5 * 60_000 });
  const sites = useMemo(() => me.data?.sites ?? [], [me.data]);
  const [exporting, setExporting] = useState(false);
  const sort = state.sort || (tab === 'assets' ? 'tag' : 'name');
  const order = state.order === 'desc' ? 'desc' : 'asc';

  const assetParams = useMemo(
    () => ({ q: state.q || undefined, siteId: state.siteId || undefined, categoryId: state.categoryId || undefined, lifecycleStage: state.lifecycleStage || undefined, expiring: (state.expiring as AssetExpiring) || undefined, page, pageSize: PAGE, sort, order }),
    [state.q, state.siteId, state.categoryId, state.lifecycleStage, state.expiring, page, sort, order],
  );
  const ciParams = useMemo(
    () => ({ q: state.q || undefined, siteId: state.siteId || undefined, typeId: state.typeId || undefined, status: state.status || undefined, criticality: state.criticality || undefined, page, pageSize: PAGE, sort, order }),
    [state.q, state.siteId, state.typeId, state.status, state.criticality, page, sort, order],
  );
  const assets = useQuery({ queryKey: pk.assets(assetParams), queryFn: () => portalApi.assets(assetParams), enabled: tab === 'assets', placeholderData: (p) => p });
  const cis = useQuery({ queryKey: pk.cis(ciParams), queryFn: () => portalApi.cis(ciParams), enabled: tab === 'cis', placeholderData: (p) => p });
  /** Counts for the rail come from the overview (whole register, not the current page). */
  const overview = useQuery({ queryKey: pk.assetsOverview, queryFn: portalApi.assetsOverview, enabled: tab === 'assets', staleTime: 60_000, retry: false });
  const ov = overview.data;
  const bucketCount = (list: { key: string; label: string; count: number }[] | undefined, id: string, label?: string | null) => list?.find((b) => b.key === id || (label && b.label === label))?.count ?? null;

  const categories = options('asset_category');
  const ciTypes = lookups?.ciTypes ?? [];
  const selected = useMemo(() => (state.asset ? assets.data?.items.find((a) => a.id === state.asset) ?? null : null), [state.asset, assets.data]);

  // ---------------------------------------------------------------- rail
  const filterKeys = tab === 'assets' ? ASSET_FILTERS : CI_FILTERS;
  const activeCount = filterKeys.filter((k) => state[k]).length;
  const clear = () => set(Object.fromEntries(filterKeys.map((k) => [k, undefined])));
  const applied: AppliedFilter[] = [];
  if (state.q) applied.push({ key: 'q', label: `Search: “${state.q}”`, onRemove: () => set({ q: undefined }) });
  if (state.siteId) applied.push({ key: 'siteId', label: `Site: ${sites.find((s) => s.id === state.siteId)?.name ?? '…'}`, onRemove: () => set({ siteId: undefined }) });
  if (tab === 'assets') {
    if (state.categoryId) applied.push({ key: 'categoryId', label: `Category: ${categories.find((c) => c.id === state.categoryId)?.label ?? '…'}`, onRemove: () => set({ categoryId: undefined }) });
    if (state.lifecycleStage) applied.push({ key: 'lifecycleStage', label: `Lifecycle: ${titleCase(state.lifecycleStage)}`, onRemove: () => set({ lifecycleStage: undefined }) });
    if (state.expiring) applied.push({ key: 'expiring', label: ASSET_EXPIRING_LABELS[state.expiring] ?? state.expiring, onRemove: () => set({ expiring: undefined }) });
  } else {
    if (state.typeId) applied.push({ key: 'typeId', label: `Type: ${ciTypes.find((t) => t.id === state.typeId)?.name ?? '…'}`, onRemove: () => set({ typeId: undefined }) });
    if (state.status) applied.push({ key: 'status', label: `Status: ${titleCase(state.status)}`, onRemove: () => set({ status: undefined }) });
    if (state.criticality) applied.push({ key: 'criticality', label: `Criticality: ${titleCase(state.criticality)}`, onRemove: () => set({ criticality: undefined }) });
  }

  const filters =
    tab === 'assets' ? (
      <>
        <FilterGroup label="Coverage">
          <FilterOptions options={ASSET_EXPIRING_OPTIONS.map((o) => ({ ...o, dot: dotClass(o.value === 'expired' ? 'red' : 'amber'), count: ov ? (o.value === 'expired' ? ov.warranty.expired + ov.amc.expired : o.value === 'warranty30' ? ov.warranty.d30 : o.value === 'warranty90' ? ov.warranty.d30 + ov.warranty.d90 : o.value === 'amc30' ? ov.amc.d30 : ov.amc.d30 + ov.amc.d90) : null }))} value={state.expiring} onChange={(v) => set({ expiring: v as string | undefined })} />
        </FilterGroup>
        <FilterGroup label="Category">
          <FilterOptions options={categories.map((c) => ({ value: c.id, label: c.label, count: bucketCount(ov?.byCategory, c.id, c.label) }))} value={state.categoryId} onChange={(v) => set({ categoryId: v as string | undefined })} emptyLabel="No categories" />
        </FilterGroup>
        <FilterGroup label="Lifecycle">
          <FilterOptions options={ASSET_LIFECYCLE.map((s) => ({ value: s, label: titleCase(s), dot: dotClass(LIFECYCLE_COLORS[s]), count: bucketCount(ov?.byLifecycle, s) }))} value={state.lifecycleStage} onChange={(v) => set({ lifecycleStage: v as string | undefined })} />
        </FilterGroup>
        {sites.length > 1 && (
          <FilterGroup label="Site">
            <FilterOptions options={sites.map((s) => ({ value: s.id, label: s.name, count: bucketCount(ov?.bySite, s.id, s.name) }))} value={state.siteId} onChange={(v) => set({ siteId: v as string | undefined })} />
          </FilterGroup>
        )}
      </>
    ) : (
      <>
        <FilterGroup label="Type">
          <FilterSelect value={state.typeId ?? ''} onChange={(e) => set({ typeId: e.target.value })} placeholder="All types" options={ciTypes.map((t) => ({ value: t.id, label: t.name }))} />
        </FilterGroup>
        <FilterGroup label="Status">
          <FilterOptions options={CI_STATUSES.map((s) => ({ value: s, label: titleCase(s), dot: dotClass(CI_STATUS_COLORS[s]) }))} value={state.status} onChange={(v) => set({ status: v as string | undefined })} />
        </FilterGroup>
        <FilterGroup label="Criticality">
          <FilterOptions options={CI_CRITICALITIES.map((c) => ({ value: c, label: titleCase(c), dot: dotClass(CRITICALITY_COLORS[c]) }))} value={state.criticality} onChange={(v) => set({ criticality: v as string | undefined })} />
        </FilterGroup>
        {sites.length > 1 && (
          <FilterGroup label="Site">
            <FilterOptions options={sites.map((s) => ({ value: s.id, label: s.name }))} value={state.siteId} onChange={(v) => set({ siteId: v as string | undefined })} />
          </FilterGroup>
        )}
      </>
    );

  // ---------------------------------------------------------------- tables
  const onSort = (key: string) => set({ sort: key, order: sort === key && order === 'asc' ? 'desc' : 'asc' }, false);
  const assetColumns: Column<PortalAsset>[] = [
    { key: 'tag', header: 'Tag', sortable: true, width: '120px', render: (r) => <span className="font-mono text-[12.5px] font-medium">{r.tag}</span> },
    { key: 'name', header: 'Name', sortable: true, render: (r) => <div className="min-w-[160px]"><div className="font-medium truncate">{r.name}</div><div className="text-[11.5px] text-muted truncate">{[r.manufacturer, r.model].filter(Boolean).join(' ') || '—'}</div></div> },
    { key: 'category', header: 'Category', render: (r) => r.categoryLabel ?? '—' },
    { key: 'site', header: 'Site', render: (r) => r.siteName ?? '—' },
    { key: 'serial', header: 'Serial', render: (r) => <span className="font-mono text-[12px]">{r.serialNumber ?? '—'}</span> },
    { key: 'lifecycle', header: 'Lifecycle', render: (r) => <div className="flex flex-col items-start gap-0.5"><Badge color={LIFECYCLE_COLORS[r.lifecycleStage] ?? 'slate'} dot>{titleCase(r.lifecycleStage)}</Badge>{r.statusLabel && <span className="text-[11px] text-muted">{r.statusLabel}</span>}</div> },
    { key: 'warrantyEnd', header: 'Warranty end', sortable: true, render: (r) => <CoverageBadge coverage={r.warranty} /> },
    { key: 'amcEnd', header: 'AMC end', sortable: true, render: (r) => <CoverageBadge coverage={r.amc} /> },
  ];
  const ciColumns: Column<PortalCi>[] = [
    { key: 'name', header: 'Name', sortable: true, render: (r) => <div><div className="font-medium">{r.name}</div>{r.assetTag && <div className="text-[11.5px] text-muted font-mono">{r.assetTag}</div>}</div> },
    { key: 'typeName', header: 'Type', sortable: true, render: (r) => <Badge color={r.typeColor ?? 'slate'}>{r.typeName}</Badge> },
    { key: 'hostname', header: 'Hostname', sortable: true, render: (r) => <span className="font-mono text-[12px]">{r.hostname ?? '—'}</span> },
    { key: 'ipAddress', header: 'IP address', sortable: true, render: (r) => <span className="font-mono text-[12px]">{r.ipAddress ?? '—'}</span> },
    { key: 'site', header: 'Site', render: (r) => r.siteName ?? '—' },
    { key: 'status', header: 'Status', render: (r) => <Badge color={CI_STATUS_COLORS[r.status] ?? 'slate'} dot>{titleCase(r.status)}</Badge> },
    { key: 'criticality', header: 'Criticality', sortable: true, render: (r) => <Badge color={CRITICALITY_COLORS[r.criticality] ?? 'slate'}>{titleCase(r.criticality)}</Badge> },
  ];

  async function exportCsv() {
    setExporting(true);
    try {
      if (tab === 'assets') {
        const all = await portalApi.assets({ ...assetParams, page: 1, pageSize: 500 });
        const cols = [{ key: 'tag', header: 'Tag' }, { key: 'name', header: 'Name' }, { key: 'categoryLabel', header: 'Category' }, { key: 'siteName', header: 'Site' }, { key: 'manufacturer', header: 'Manufacturer' }, { key: 'model', header: 'Model' }, { key: 'serialNumber', header: 'Serial' }, { key: 'statusLabel', header: 'Status' }, { key: 'lifecycleStage', header: 'Lifecycle' }, { key: 'location', header: 'Location' }, { key: 'warrantyEnd', header: 'Warranty end' }, { key: 'amcEnd', header: 'AMC end' }];
        saveCsv(`assets-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(all.items as unknown as Record<string, unknown>[], cols));
        toast.success(`${all.items.length} assets exported${all.total > all.items.length ? ` (first ${all.items.length} of ${all.total})` : ''}`);
      } else {
        const all = await portalApi.cis({ ...ciParams, page: 1, pageSize: 500 });
        const cols = [{ key: 'name', header: 'Name' }, { key: 'typeName', header: 'Type' }, { key: 'hostname', header: 'Hostname' }, { key: 'ipAddress', header: 'IP address' }, { key: 'siteName', header: 'Site' }, { key: 'status', header: 'Status' }, { key: 'criticality', header: 'Criticality' }, { key: 'environment', header: 'Environment' }, { key: 'manufacturer', header: 'Manufacturer' }, { key: 'model', header: 'Model' }, { key: 'serialNumber', header: 'Serial' }, { key: 'assetTag', header: 'Asset tag' }];
        saveCsv(`configuration-items-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(all.items as unknown as Record<string, unknown>[], cols));
        toast.success(`${all.items.length} items exported${all.total > all.items.length ? ` (first ${all.items.length} of ${all.total})` : ''}`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  const current = tab === 'assets' ? assets : cis;
  const total = current.data?.total ?? 0;

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Inventory"
        subtitle="Equipment and systems we look after for you, with warranty and maintenance coverage."
        actions={
          <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportCsv} loading={exporting} disabled={total === 0}>
            Export CSV
          </Button>
        }
      />
      <ListShell
        id={`portal-assets-${tab}`}
        modules={PORTAL_ASSET_MODULES}
        search={{ value: state.q ?? '', onChange: (q) => set({ q }), placeholder: tab === 'assets' ? 'Search tag, name, serial…' : 'Search name, hostname, IP…' }}
        filters={filters}
        activeCount={activeCount}
        onClear={clear}
        applied={applied}
        count={current.data ? `${fmtNumber(total)} ${tab === 'assets' ? (total === 1 ? 'asset' : 'assets') : total === 1 ? 'configuration item' : 'configuration items'}` : undefined}
        quick={<Segmented size="sm" options={[{ value: 'assets' as Tab, label: 'Assets', count: tab === 'assets' ? assets.data?.total : undefined }, { value: 'cis' as Tab, label: 'Configuration items', count: tab === 'cis' ? cis.data?.total : undefined }]} value={tab} onChange={(t) => set({ ...TAB_RESET, tab: t })} />}
      >
        <div className="card">
          {current.isError ? (
            <ErrorBlock error={current.error} retry={() => current.refetch()} />
          ) : tab === 'assets' ? (
            <DataTable
              columns={assetColumns}
              rows={assets.data?.items ?? []}
              loading={assets.isLoading}
              sort={{ key: sort, order }}
              onSort={onSort}
              onRowClick={(r) => set({ asset: r.id }, false)}
              rowClassName={(r) => (r.warranty.status === 'expired' && r.amc.status === 'expired' ? 'row-rail-bad' : r.warranty.status === 'expiring' || r.amc.status === 'expiring' ? 'row-rail-warn' : undefined)}
              empty={<EmptyState icon={<Boxes className="h-5 w-5" />} title={activeCount ? 'No assets match' : 'No assets on record'} description={activeCount ? 'Adjust or clear the filters.' : 'Assets we manage for you will appear here.'} />}
            />
          ) : (
            <DataTable columns={ciColumns} rows={cis.data?.items ?? []} loading={cis.isLoading} sort={{ key: sort, order }} onSort={onSort} empty={<EmptyState icon={<Server className="h-5 w-5" />} title={activeCount ? 'No configuration items match' : 'No configuration items'} description={activeCount ? 'Adjust or clear the filters.' : 'Monitored devices and systems will appear here.'} />} />
          )}
          <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
        </div>
      </ListShell>

      <Drawer open={!!state.asset} onClose={() => set({ asset: undefined }, false)} title={selected ? selected.tag : 'Asset'} width="max-w-md" footer={<Button variant="outline" icon={<Ticket className="h-4 w-4" />} onClick={() => navigate('/portal/tickets/new')}>Report an issue</Button>}>
        {selected ? (
          <div className="flex flex-col gap-5">
            <div>
              <div className="text-[16px] font-semibold tracking-[-0.01em]">{selected.name}</div>
              <div className="text-[12.5px] text-muted">{[selected.manufacturer, selected.model].filter(Boolean).join(' ') || selected.categoryLabel || '—'}</div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge color={LIFECYCLE_COLORS[selected.lifecycleStage] ?? 'slate'} dot>{titleCase(selected.lifecycleStage)}</Badge>
                {selected.statusLabel && <Badge color={selected.statusColor ?? 'slate'}>{selected.statusLabel}</Badge>}
              </div>
            </div>
            <KeyValue
              columns={2}
              items={[
                { label: 'Tag', value: <span className="font-mono">{selected.tag}</span> },
                { label: 'Serial number', value: selected.serialNumber ? <span className="font-mono">{selected.serialNumber}</span> : '—' },
                { label: 'Category', value: selected.categoryLabel ?? '—' },
                { label: 'Site', value: selected.siteName ?? '—' },
                { label: 'Manufacturer', value: selected.manufacturer ?? '—' },
                { label: 'Model', value: selected.model ?? '—' },
                { label: 'Location', value: selected.location ?? '—', span: 2 },
                { label: 'Warranty', value: <CoverageBadge coverage={selected.warranty} /> },
                { label: 'Maintenance (AMC)', value: <CoverageBadge coverage={selected.amc} /> },
                { label: 'Monitored as', value: selected.ciName ?? 'Not linked to a configuration item', span: 2 },
              ]}
            />
          </div>
        ) : assets.isLoading ? (
          <div className="text-[12.5px] text-muted">Loading…</div>
        ) : (
          <EmptyState icon={<Boxes className="h-5 w-5" />} title="Asset not in this view" description="It is outside the current filters or page. Clear the filters to find it." action={<Button size="sm" variant="outline" onClick={() => set({ ...Object.fromEntries(ASSET_FILTERS.map((k) => [k, undefined])) })}>Clear filters</Button>} />
        )}
      </Drawer>
    </div>
  );
}
