import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Upload, Download, Server, AlertOctagon, Radar, EyeOff, Boxes, Bookmark, ChevronDown, Share2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { get, post, del, download, buildQuery } from '@/api/client';
import { PageHeader, Button, DataTable, Pagination, Select, SearchInput, Badge, FilterBar, FilterChip, Dialog, Input, Checkbox, type Column } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { CmdbNav } from '@/components/cmdb/CmdbNav';
import { cmdbApi } from '@/components/cmdb/api';
import type { SavedView } from '@/components/tickets/types';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { toast as notify } from 'sonner';
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
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [viewShared, setViewShared] = useState(false);
  const views = useQuery({ queryKey: ['cmdb', 'saved-views'], queryFn: () => get<{ items: SavedView[] }>('/saved-views', { entity: 'ci' }) });
  const FILTER_KEYS = ['q', 'customerId', 'siteId', 'typeKey', 'status', 'environment', 'criticality', 'stale', 'hasAsset', 'discovered', 'withoutRelationships', 'unowned', 'ownerTeamId'];
  useEffect(() => {
    if (state.new === '1') { setCreateOpen(true); set({ new: undefined }, false); }
    if (state.import === '1') { setImportOpen(true); set({ import: undefined }, false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.new, state.import]);

  const query = useMemo(() => ({ page, pageSize, sort: state.sort, order: state.order, q: state.q, customerId: state.customerId, siteId: state.siteId, typeKey: state.typeKey, status: state.status, environment: state.environment, criticality: state.criticality, stale: state.stale, hasAsset: state.hasAsset, discovered: state.discovered, withoutRelationships: state.withoutRelationships, unowned: state.unowned, ownerTeamId: state.ownerTeamId }), [state, page, pageSize]);
  const list = useQuery({ queryKey: ['cmdb', 'list', query], queryFn: () => get<{ items: CiRow[]; total: number }>('/cmdb/cis', query), placeholderData: (prev) => prev });
  const summary = useQuery({ queryKey: ['cmdb', 'summary', state.customerId ?? ''], queryFn: () => get<Summary>('/cmdb/summary', { customerId: state.customerId }) });
  const countByType = new Map((summary.data?.byType ?? []).map((t) => [t.key, t.count]));

  const teams = lookups?.teams ?? [];
  useEffect(() => setSelected(new Set()), [query]);
  const rows = list.data?.items ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggleOne = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const columns: Column<CiRow>[] = [
    ...(can('cmdb:manage') ? [{ key: 'sel', header: <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" className="h-3.5 w-3.5 accent-brand-600" />, width: '32px', render: (c: CiRow) => <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} onClick={(e) => e.stopPropagation()} aria-label="Select" className="h-3.5 w-3.5 accent-brand-600" /> }] : []),
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
  const activeFilters = Object.keys(state).filter((k) => !(k in DEFAULTS) && k !== 'page' && FILTER_KEYS.includes(k));
  const sm = summary.data;
  const applyView = (v: SavedView) => {
    const patch: Record<string, string | undefined> = Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined]));
    for (const [k, val] of Object.entries(v.filters)) if (val !== undefined && val !== null && val !== '') patch[k] = String(val);
    if (v.sort) { const [s, o] = v.sort.split(':'); patch.sort = s; patch.order = o ?? 'desc'; }
    set(patch);
  };
  const saveView = useMutation({
    mutationFn: () => { const filters: Record<string, unknown> = {}; for (const k of FILTER_KEYS) if (state[k]) filters[k] = state[k]; return post<SavedView>('/saved-views', { name: viewName.trim(), entity: 'ci', filters, sort: `${state.sort}:${state.order}`, isShared: viewShared }); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cmdb', 'saved-views'] }); setSaveOpen(false); setViewName(''); notify.success('View saved'); },
    onError: (e) => notify.error(errorMessage(e)),
  });
  const deleteView = useMutation({ mutationFn: (id: string) => del(`/saved-views/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['cmdb', 'saved-views'] }), onError: (e) => notify.error(errorMessage(e)) });
  const bulk = useMutation({
    mutationFn: (body: { action: string; payload?: Record<string, unknown> }) => cmdbApi.bulk({ ids: [...selected], ...body }),
    onSuccess: (r) => { notify[r.failed ? 'warning' : 'success'](`${r.succeeded} updated${r.failed ? `, ${r.failed} failed` : ''}`); setSelected(new Set()); qc.invalidateQueries({ queryKey: ['cmdb'] }); },
    onError: (e) => notify.error(errorMessage(e)),
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Configuration items"
        subtitle="Every item under management: servers, network, applications, services and more"
        actions={
          <>
            <Menu
              trigger={<Button variant="outline" size="sm" icon={<Bookmark className="h-3.5 w-3.5" />}>Views <ChevronDown className="h-3 w-3" /></Button>}
              items={[
                ...(views.data?.items ?? []).map((v) => ({
                  label: (
                    <span className="flex items-center gap-2 w-full">
                      <span className="flex-1 truncate">{v.name}</span>
                      {v.isShared && <Share2 className="h-3 w-3 text-subtle" />}
                      {v.isOwner && <span role="button" className="text-subtle hover:text-red-600" onClick={(e) => { e.stopPropagation(); deleteView.mutate(v.id); }}><Trash2 className="h-3 w-3" /></span>}
                    </span>
                  ),
                  onClick: () => applyView(v),
                })),
                { label: 'Save current filters…', icon: <Plus className="h-3.5 w-3.5" />, onClick: () => setSaveOpen(true) },
              ]}
            />
            <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} onClick={exportCsv}>Export CSV</Button>
            {can('cmdb:manage') && <Button variant="outline" size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => setImportOpen(true)}>Import CSV</Button>}
            {can('cmdb:manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New CI</Button>}
          </>
        }
      />
      <CmdbNav />
      <FilterBar
        activeCount={activeFilters.length}
        onClear={() => set(Object.fromEntries(activeFilters.map((k) => [k, undefined])))}
        trailing={
          selected.size > 0 ? (
            <div className="flex items-center gap-2 text-[12.5px]">
              <span className="text-muted">{selected.size} selected</span>
              <Select className="h-7 py-0 w-36 text-[12.5px]" placeholder="Set status…" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'status', payload: { status: e.target.value } })} options={CI_STATUSES.map((st) => ({ value: st, label: titleCase(st) }))} />
              <Select className="h-7 py-0 w-36 text-[12.5px]" placeholder="Set criticality…" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'criticality', payload: { criticality: e.target.value } })} options={CRITICALITIES.map((c) => ({ value: c, label: titleCase(c) }))} />
              <Select className="h-7 py-0 w-40 text-[12.5px]" placeholder="Set owner team…" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'ownerTeam', payload: { ownerTeamId: e.target.value } })} options={teams.map((t) => ({ value: t.id, label: t.name }))} />
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          ) : undefined
        }
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
        <Select className="w-40 h-8 py-0 text-[13px]" value={state.discovered ?? ''} onChange={(e) => set({ discovered: e.target.value })} placeholder="Any origin" options={[{ value: 'true', label: 'Discovered' }, { value: 'false', label: 'Created manually' }]} />
        <Select className="w-44 h-8 py-0 text-[13px]" value={state.withoutRelationships === 'true' ? 'norel' : state.unowned === 'true' ? 'unowned' : state.hasAsset === 'false' ? 'noasset' : state.stale === 'true' ? 'stale' : ''} onChange={(e) => { const v = e.target.value; set({ withoutRelationships: v === 'norel' ? 'true' : undefined, unowned: v === 'unowned' ? 'true' : undefined, hasAsset: v === 'noasset' ? 'false' : state.hasAsset === 'false' ? undefined : state.hasAsset, stale: v === 'stale' ? 'true' : undefined }); }} placeholder="Any data gap" options={[{ value: 'stale', label: 'Stale (unseen 30d)' }, { value: 'norel', label: 'No relationships' }, { value: 'unowned', label: 'No owner team' }, { value: 'noasset', label: 'No asset linked' }]} />
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
        <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} onRowClick={(c) => navigate(`/cmdb/cis/${c.id}`)} rowClassName={(c) => (c.criticality === 'critical' && c.status === 'active' ? 'row-rail-bad' : undefined)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} dense />
        <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
      </div>
      <CiForm open={createOpen} onClose={() => setCreateOpen(false)} defaultCustomerId={state.customerId} onSaved={(c) => navigate(`/cmdb/cis/${c.id}`)} />
      <Dialog open={saveOpen} onClose={() => setSaveOpen(false)} title="Save view" width="max-w-sm" footer={<><Button variant="ghost" onClick={() => setSaveOpen(false)}>Cancel</Button><Button onClick={() => viewName.trim() && saveView.mutate()} loading={saveView.isPending} disabled={!viewName.trim()}>Save</Button></>}>
        <div className="flex flex-col gap-3">
          <Input autoFocus placeholder="View name" value={viewName} onChange={(e) => setViewName(e.target.value)} />
          <Checkbox checked={viewShared} onChange={(e) => setViewShared(e.target.checked)} label="Share with all MSP users" />
        </div>
      </Dialog>
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} title="Import configuration items from CSV" endpoint="/cmdb/import" templatePath="/cmdb/import/template.csv" templateName="cis-import-template.csv" columns={IMPORT_COLUMNS} customerId={state.customerId} onDone={() => { list.refetch(); summary.refetch(); }} />
    </div>
  );
}
