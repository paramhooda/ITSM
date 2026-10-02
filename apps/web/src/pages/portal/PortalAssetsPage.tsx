import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Boxes, Server } from 'lucide-react';
import { PageHeader, Button, Tabs, SearchInput, Select, DataTable, Pagination, Badge, EmptyState, ErrorBlock, type Column } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useLookups } from '@/hooks/useLookups';
import { fmtDate, titleCase } from '@/lib/format';
import { portalApi, pk, type PortalAsset, type PortalCi, type Coverage } from '@/components/portal/api';
import { CRITICALITY_COLORS, CI_STATUS_COLORS } from '@/lib/statusColors';

type Tab = 'assets' | 'cis';
const PAGE = 50;

function CoverageBadge({ c, end }: { c: Coverage; end: string | null }) {
  if (c.status === 'none') return <span className="text-subtle text-xs">—</span>;
  const color = c.status === 'active' ? 'green' : c.status === 'expiring' ? 'amber' : 'red';
  const text = c.status === 'expired' ? `Expired ${fmtDate(end)}` : c.status === 'expiring' ? `Expires in ${c.days}d` : fmtDate(end);
  return <Badge color={color}>{text}</Badge>;
}

const CRIT_COLOR = CRITICALITY_COLORS;
const CI_STATUS_COLOR = CI_STATUS_COLORS;

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

export default function PortalAssetsPage() {
  const { state, set, page, setPage } = useListState({ tab: 'assets' });
  const tab = (state.tab as Tab) || 'assets';
  const { options, lookups } = useLookups();
  const me = useQuery({ queryKey: pk.me, queryFn: portalApi.me, staleTime: 5 * 60_000 });
  const sites = me.data?.sites ?? [];
  const [exporting, setExporting] = useState(false);

  const assetParams = useMemo(() => ({ q: state.q || undefined, siteId: state.siteId || undefined, categoryId: state.categoryId || undefined, page, pageSize: PAGE, sort: 'tag', order: 'asc' }), [state.q, state.siteId, state.categoryId, page]);
  const ciParams = useMemo(() => ({ q: state.q || undefined, siteId: state.siteId || undefined, typeId: state.typeId || undefined, status: state.status || undefined, page, pageSize: PAGE, sort: 'name', order: 'asc' }), [state.q, state.siteId, state.typeId, state.status, page]);
  const assets = useQuery({ queryKey: pk.assets(assetParams), queryFn: () => portalApi.assets(assetParams), enabled: tab === 'assets', placeholderData: (p) => p });
  const cis = useQuery({ queryKey: pk.cis(ciParams), queryFn: () => portalApi.cis(ciParams), enabled: tab === 'cis', placeholderData: (p) => p });

  const assetColumns: Column<PortalAsset>[] = [
    { key: 'tag', header: 'Tag', width: '120px', render: (r) => <span className="font-mono text-[12.5px]">{r.tag}</span> },
    { key: 'name', header: 'Name', render: (r) => <div><div className="font-medium">{r.name}</div><div className="text-[11.5px] text-muted">{[r.manufacturer, r.model].filter(Boolean).join(' ')}</div></div> },
    { key: 'category', header: 'Category', render: (r) => r.categoryLabel ?? '—' },
    { key: 'site', header: 'Site', render: (r) => r.siteName ?? '—' },
    { key: 'serial', header: 'Serial', render: (r) => <span className="font-mono text-[12px]">{r.serialNumber ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => (r.statusLabel ? <Badge color={r.statusColor ?? 'slate'}>{r.statusLabel}</Badge> : <Badge color="slate">{titleCase(r.lifecycleStage)}</Badge>) },
    { key: 'warranty', header: 'Warranty', render: (r) => <CoverageBadge c={r.warranty} end={r.warrantyEnd} /> },
    { key: 'amc', header: 'Maintenance (AMC)', render: (r) => <CoverageBadge c={r.amc} end={r.amcEnd} /> },
  ];
  const ciColumns: Column<PortalCi>[] = [
    { key: 'name', header: 'Name', render: (r) => <div><div className="font-medium">{r.name}</div>{r.assetTag && <div className="text-[11.5px] text-muted font-mono">{r.assetTag}</div>}</div> },
    { key: 'type', header: 'Type', render: (r) => <Badge color={r.typeColor ?? 'slate'}>{r.typeName}</Badge> },
    { key: 'hostname', header: 'Hostname', render: (r) => <span className="font-mono text-[12px]">{r.hostname ?? '—'}</span> },
    { key: 'ip', header: 'IP address', render: (r) => <span className="font-mono text-[12px]">{r.ipAddress ?? '—'}</span> },
    { key: 'site', header: 'Site', render: (r) => r.siteName ?? '—' },
    { key: 'status', header: 'Status', render: (r) => <Badge color={CI_STATUS_COLOR[r.status] ?? 'slate'}>{titleCase(r.status)}</Badge> },
    { key: 'criticality', header: 'Criticality', render: (r) => <Badge color={CRIT_COLOR[r.criticality] ?? 'slate'}>{titleCase(r.criticality)}</Badge> },
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

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Your assets"
        subtitle="Equipment and systems we look after for you, with warranty and maintenance coverage."
        actions={
          <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportCsv} loading={exporting} disabled={(current.data?.total ?? 0) === 0}>
            Export CSV
          </Button>
        }
      />
      <Tabs tabs={[{ key: 'assets' as Tab, label: 'Assets', count: tab === 'assets' ? assets.data?.total : undefined }, { key: 'cis' as Tab, label: 'Configuration items', count: tab === 'cis' ? cis.data?.total : undefined }]} value={tab} onChange={(t) => set({ tab: t, q: undefined, categoryId: undefined, typeId: undefined, status: undefined })} className="mb-3" />
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <SearchInput value={state.q ?? ''} onChange={(q) => set({ q })} placeholder={tab === 'assets' ? 'Search tag, name, serial…' : 'Search name, hostname, IP…'} className="w-full sm:w-72" />
        {sites.length > 1 && <Select value={state.siteId ?? ''} onChange={(e) => set({ siteId: e.target.value })} placeholder="All sites" options={sites.map((s) => ({ value: s.id, label: s.name }))} className="w-auto" />}
        {tab === 'assets' ? (
          <Select value={state.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value })} placeholder="All categories" options={options('asset_category').map((o) => ({ value: o.id, label: o.label }))} className="w-auto" />
        ) : (
          <>
            <Select value={state.typeId ?? ''} onChange={(e) => set({ typeId: e.target.value })} placeholder="All types" options={(lookups?.ciTypes ?? []).map((t) => ({ value: t.id, label: t.name }))} className="w-auto" />
            <Select value={state.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="Any status" options={['active', 'maintenance', 'inactive', 'planned', 'retired'].map((s) => ({ value: s, label: titleCase(s) }))} className="w-auto" />
          </>
        )}
      </div>
      <div className="card">
        {current.isError ? (
          <ErrorBlock error={current.error} retry={() => current.refetch()} />
        ) : tab === 'assets' ? (
          <DataTable columns={assetColumns} rows={assets.data?.items ?? []} loading={assets.isLoading} empty={<EmptyState icon={<Boxes className="h-5 w-5" />} title="No assets on record" description="Assets we manage for you will appear here." />} />
        ) : (
          <DataTable columns={ciColumns} rows={cis.data?.items ?? []} loading={cis.isLoading} empty={<EmptyState icon={<Server className="h-5 w-5" />} title="No configuration items" description="Monitored devices and systems will appear here." />} />
        )}
        <Pagination page={page} pageSize={PAGE} total={current.data?.total ?? 0} onPage={setPage} />
      </div>
    </div>
  );
}
