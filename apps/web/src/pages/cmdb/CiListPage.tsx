import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Upload, Download } from 'lucide-react';
import { toast } from 'sonner';
import { get, download, buildQuery } from '@/api/client';
import { PageHeader, Button, DataTable, Pagination, Select, SearchInput, StatTile, Badge, type Column } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/format';
import { CiForm } from '@/components/cmdb/CiForm';
import { CiTypeBadge, CiTypeIcon, CiStatusBadge, CriticalityBadge, CI_STATUSES, CRITICALITIES, ENVIRONMENTS } from '@/components/cmdb/CiTypeBadge';
import { ImportDialog } from '@/components/assets/ImportDialog';
import { useSites, errorMessage } from '@/components/cmdb/hooks';

interface CiRow {
  id: string;
  name: string;
  customerId: string;
  customerName?: string | null;
  siteName?: string | null;
  typeKey: string;
  typeName: string;
  typeIcon?: string | null;
  typeColor?: string | null;
  hostname?: string | null;
  ipAddress?: string | null;
  serialNumber?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  environment: string;
  criticality: string;
  status: string;
  assetTag?: string | null;
  lastSeenAt?: string | null;
  relationshipCount: number;
}
interface Summary { total: number; active: number; stale: number; discovered: number; withAsset: number; critical: number; byType: { key: string; name: string; color: string | null; icon: string | null; count: number }[] }

const DEFAULTS = { sort: 'updatedAt', order: 'desc' };
const IMPORT_COLUMNS = ['name', 'type', 'hostname', 'ipAddress', 'macAddress', 'serialNumber', 'manufacturer', 'model', 'osName', 'site', 'environment', 'criticality', 'status', 'description'];

export default function CiListPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { lookups } = useLookups();
  const customers = useCustomersLookup();
  const sites = useSites(state.customerId);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const typeKeys = useMemo(() => (state.typeKey ? state.typeKey.split(',').filter(Boolean) : []), [state.typeKey]);

  const query = useMemo(() => ({ page, pageSize, sort: state.sort, order: state.order, q: state.q, customerId: state.customerId, siteId: state.siteId, typeKey: state.typeKey, status: state.status, environment: state.environment, criticality: state.criticality, stale: state.stale, hasAsset: state.hasAsset }), [state, page, pageSize]);
  const list = useQuery({ queryKey: ['cmdb', 'list', query], queryFn: () => get<{ items: CiRow[]; total: number }>('/cmdb/cis', query), placeholderData: (prev) => prev });
  const summary = useQuery({ queryKey: ['cmdb', 'summary', state.customerId ?? ''], queryFn: () => get<Summary>('/cmdb/summary', { customerId: state.customerId }) });
  const countByType = new Map((summary.data?.byType ?? []).map((t) => [t.key, t.count]));

  const columns: Column<CiRow>[] = [
    { key: 'name', header: 'Name', sortable: true, render: (c) => <span className="font-medium">{c.name}</span> },
    { key: 'typeName', header: 'Type', sortable: true, render: (c) => <CiTypeBadge typeKey={c.typeKey} name={c.typeName} color={c.typeColor} icon={c.typeIcon} /> },
    { key: 'hostname', header: 'Hostname', sortable: true, render: (c) => <span className="font-mono text-xs">{c.hostname ?? '—'}</span> },
    { key: 'ipAddress', header: 'IP', sortable: true, render: (c) => <span className="font-mono text-xs">{c.ipAddress ?? '—'}</span> },
    { key: 'customer', header: 'Customer', sortable: true, render: (c) => <div className="leading-tight"><div>{c.customerName ?? '—'}</div>{c.siteName && <div className="text-xs text-subtle">{c.siteName}</div>}</div> },
    { key: 'status', header: 'Status', render: (c) => <CiStatusBadge status={c.status} /> },
    { key: 'criticality', header: 'Criticality', sortable: true, render: (c) => <CriticalityBadge value={c.criticality} /> },
    { key: 'environment', header: 'Env', render: (c) => <span className="capitalize">{c.environment}</span> },
    { key: 'lastSeenAt', header: 'Last seen', sortable: true, render: (c) => <span className={cn('text-muted', c.lastSeenAt && Date.now() - new Date(c.lastSeenAt).getTime() > 30 * 86_400_000 && 'text-amber-600')}>{c.lastSeenAt ? relativeTime(c.lastSeenAt) : '—'}</span> },
    { key: 'relationshipCount', header: 'Rels', className: 'text-right', render: (c) => <span className="text-muted">{c.relationshipCount}</span> },
    { key: 'assetTag', header: 'Asset', render: (c) => c.assetTag ? <Badge color="slate">{c.assetTag}</Badge> : <span className="text-subtle">—</span> },
  ];
  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false);
  const toggleType = (key: string) => {
    const next = typeKeys.includes(key) ? typeKeys.filter((k) => k !== key) : [...typeKeys, key];
    set({ typeKey: next.join(',') || undefined });
  };
  const exportCsv = () => download(`/cmdb/export.csv${buildQuery({ ...query, page: undefined, pageSize: undefined })}`, `cis-${new Date().toISOString().slice(0, 10)}.csv`).catch((e) => toast.error(errorMessage(e)));
  const activeFilters = Object.keys(state).filter((k) => !(k in DEFAULTS) && k !== 'page');

  return (
    <div>
      <PageHeader
        title="CMDB"
        subtitle="Configuration items, relationships and service dependencies"
        actions={
          <>
            <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} onClick={exportCsv}>Export CSV</Button>
            {can('cmdb:manage') && <Button variant="outline" size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => setImportOpen(true)}>Import CSV</Button>}
            {can('cmdb:manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New CI</Button>}
          </>
        }
      />
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <StatTile label="Configuration items" value={summary.data?.total ?? '—'} hint={summary.data ? `${summary.data.active} active` : undefined} onClick={() => set({ status: undefined, stale: undefined, criticality: undefined })} />
        <StatTile label="Critical" value={summary.data?.critical ?? '—'} tone={summary.data?.critical ? 'bad' : 'default'} onClick={() => set({ criticality: 'critical' })} />
        <StatTile label="Discovered" value={summary.data?.discovered ?? '—'} hint="via network discovery" />
        <StatTile label="Stale (>30d unseen)" value={summary.data?.stale ?? '—'} tone={summary.data?.stale ? 'warn' : 'default'} onClick={() => set({ stale: 'true' })} />
        <StatTile label="Linked to assets" value={summary.data?.withAsset ?? '—'} onClick={() => set({ hasAsset: 'true' })} />
      </div>
      <div className="card mb-3 p-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2 items-center">
          <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search name, hostname, IP, serial…" className="w-64" />
          <Select className="w-52" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, siteId: undefined })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <Select className="w-44" value={state.siteId ?? ''} disabled={!state.customerId} onChange={(e) => set({ siteId: e.target.value })} placeholder="All sites" options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))} />
          <Select className="w-36" value={state.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="Any status" options={CI_STATUSES.map((s) => ({ value: s, label: s }))} />
          <Select className="w-36" value={state.environment ?? ''} onChange={(e) => set({ environment: e.target.value })} placeholder="Any env" options={ENVIRONMENTS.map((s) => ({ value: s, label: s }))} />
          <Select className="w-36" value={state.criticality ?? ''} onChange={(e) => set({ criticality: e.target.value })} placeholder="Any criticality" options={CRITICALITIES.map((s) => ({ value: s, label: s }))} />
          {activeFilters.length > 0 && <Button variant="ghost" size="sm" onClick={() => set(Object.fromEntries(activeFilters.map((k) => [k, undefined])))}>Clear</Button>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(lookups?.ciTypes ?? []).map((t) => {
            const active = typeKeys.includes(t.key);
            const n = countByType.get(t.key) ?? 0;
            return (
              <button key={t.key} onClick={() => toggleType(t.key)} className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] border', active ? 'bg-brand-600 text-white border-brand-600' : 'border-default text-muted hover:text-default', !active && n === 0 && 'opacity-60')}>
                <CiTypeIcon icon={t.icon} className="h-3 w-3" />
                {t.name}
                {n > 0 && <span className={cn('text-[10.5px]', active ? 'text-white/80' : 'text-subtle')}>{n}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="card">
        <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} onRowClick={(c) => navigate(`/cmdb/${c.id}`)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} dense />
        <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
      </div>
      <CiForm open={createOpen} onClose={() => setCreateOpen(false)} defaultCustomerId={state.customerId} onSaved={(c) => navigate(`/cmdb/${c.id}`)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} title="Import configuration items from CSV" endpoint="/cmdb/import" templatePath="/cmdb/import/template.csv" templateName="cis-import-template.csv" columns={IMPORT_COLUMNS} customerId={state.customerId} onDone={() => { list.refetch(); summary.refetch(); }} />
    </div>
  );
}
