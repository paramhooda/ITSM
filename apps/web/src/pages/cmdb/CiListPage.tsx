import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Upload, Download, Server, AlertOctagon, Radar, EyeOff, Boxes } from 'lucide-react';
import { toast } from 'sonner';
import { get, download, buildQuery } from '@/api/client';
import { PageHeader, Button, DataTable, Pagination, Select, SearchInput, Badge, FilterBar, FilterChip, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { relativeTime, fmtNumber, titleCase } from '@/lib/format';
import { CI_STATUS_COLORS, CRITICALITY_COLORS, ENVIRONMENT_COLORS } from '@/lib/statusColors';
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
interface Summary {
  total: number;
  active: number;
  stale: number;
  discovered: number;
  withAsset: number;
  critical: number;
  byType: { key: string; name: string; color: string | null; icon: string | null; count: number }[];
  byStatus: { status: string; count: number }[];
  byEnvironment: { environment: string; count: number }[];
  byCriticality: { criticality: string; count: number }[];
}

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
    { key: 'environment', header: 'Env', render: (c) => <Badge color={ENVIRONMENT_COLORS[c.environment] ?? 'slate'}>{titleCase(c.environment)}</Badge> },
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
  const sm = summary.data;

  return (
    <div className="flex flex-col gap-4">
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
      <FilterBar
        activeCount={activeFilters.length}
        onClear={() => set(Object.fromEntries(activeFilters.map((k) => [k, undefined])))}
        chips={(lookups?.ciTypes ?? []).map((t) => {
          const active = typeKeys.includes(t.key);
          const n = countByType.get(t.key) ?? 0;
          return (
            <FilterChip key={t.key} active={active} onClick={() => toggleType(t.key)} count={n} className={cn(!active && n === 0 && 'opacity-60')}>
              <CiTypeIcon icon={t.icon} className="h-3 w-3" />
              {t.name}
            </FilterChip>
          );
        })}
      >
        <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search name, hostname, IP, serial…" className="w-64" />
        <Select className="w-48 h-8 py-0 text-[13px]" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, siteId: undefined })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <Select className="w-40 h-8 py-0 text-[13px]" value={state.siteId ?? ''} disabled={!state.customerId} onChange={(e) => set({ siteId: e.target.value })} placeholder="All sites" options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        <Select className="w-32 h-8 py-0 text-[13px]" value={state.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="Any status" options={CI_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
        <Select className="w-32 h-8 py-0 text-[13px]" value={state.environment ?? ''} onChange={(e) => set({ environment: e.target.value })} placeholder="Any env" options={ENVIRONMENTS.map((s) => ({ value: s, label: titleCase(s) }))} />
        <Select className="w-36 h-8 py-0 text-[13px]" value={state.criticality ?? ''} onChange={(e) => set({ criticality: e.target.value })} placeholder="Any criticality" options={CRITICALITIES.map((s) => ({ value: s, label: titleCase(s) }))} />
      </FilterBar>

      <InsightBand
        id="cmdb"
        loading={summary.isLoading}
        columns={5}
        summary={sm ? `${fmtNumber(sm.total)} configuration items${state.customerId ? ' for this customer' : ''}` : undefined}
        kpis={
          sm
            ? [
                { label: 'Configuration items', value: fmtNumber(sm.total), icon: <Server className="h-4 w-4" />, hint: `${fmtNumber(sm.active)} active`, onClick: () => set({ status: undefined, stale: undefined, criticality: undefined }) },
                { label: 'Critical', value: fmtNumber(sm.critical), tone: sm.critical ? 'bad' : 'good', icon: <AlertOctagon className="h-4 w-4" />, hint: 'business-critical items', onClick: () => set({ criticality: state.criticality === 'critical' ? undefined : 'critical' }) },
                { label: 'Discovered', value: fmtNumber(sm.discovered), icon: <Radar className="h-4 w-4" />, hint: 'via network discovery' },
                { label: 'Stale · 30d unseen', value: fmtNumber(sm.stale), tone: sm.stale ? 'warn' : 'good', icon: <EyeOff className="h-4 w-4" />, hint: 'discovered but not seen lately', onClick: () => set({ stale: state.stale ? undefined : 'true' }) },
                { label: 'Linked to assets', value: fmtNumber(sm.withAsset), icon: <Boxes className="h-4 w-4" />, hint: 'with a financial record', onClick: () => set({ hasAsset: state.hasAsset ? undefined : 'true' }) },
              ]
            : []
        }
        panels={
          sm && (
            <>
              <Panel title="By criticality" subtitle="Click a level to filter">
                <BreakdownBar dense items={CRITICALITIES.map((c) => ({ label: titleCase(c), value: sm.byCriticality.find((b) => b.criticality === c)?.count ?? 0, color: CRITICALITY_COLORS[c], active: state.criticality === c })).filter((i) => i.value > 0)} onSelect={(i) => { const c = CRITICALITIES.find((x) => titleCase(x) === i.label); if (c) set({ criticality: state.criticality === c ? undefined : c }); }} />
              </Panel>
              <Panel title="By status" subtitle="Lifecycle state of each item">
                <BreakdownBar dense items={CI_STATUSES.map((st) => ({ label: titleCase(st), value: sm.byStatus.find((b) => b.status === st)?.count ?? 0, color: CI_STATUS_COLORS[st], active: state.status === st })).filter((i) => i.value > 0)} onSelect={(i) => { const st = CI_STATUSES.find((x) => titleCase(x) === i.label); if (st) set({ status: state.status === st ? undefined : st }); }} />
              </Panel>
            </>
          )
        }
      />

      <div className="card overflow-hidden">
        <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} onRowClick={(c) => navigate(`/cmdb/${c.id}`)} rowClassName={(c) => (c.criticality === 'critical' && c.status === 'active' ? 'row-rail-bad' : undefined)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} dense />
        <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
      </div>
      <CiForm open={createOpen} onClose={() => setCreateOpen(false)} defaultCustomerId={state.customerId} onSaved={(c) => navigate(`/cmdb/${c.id}`)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} title="Import configuration items from CSV" endpoint="/cmdb/import" templatePath="/cmdb/import/template.csv" templateName="cis-import-template.csv" columns={IMPORT_COLUMNS} customerId={state.customerId} onDone={() => { list.refetch(); summary.refetch(); }} />
    </div>
  );
}
