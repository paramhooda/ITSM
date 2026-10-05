import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Upload, Download, HardDrive, Package, Server, Unlink, Clock, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { INSTALL_SOURCES } from '@itsm/shared';
import { PageHeader, Button, DataTable, Pagination, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterToggle, EmptyState, Drawer, KeyValue, ConfirmDialog, type AppliedFilter, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtDate, fmtDateTime, fmtNumber, relativeTime } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { INSTALL_SOURCE_COLORS } from '@/lib/statusColors';
import { ASSET_MODULES } from '@/layouts/modules';
import { ImportDialog } from '@/components/assets/ImportDialog';
import { errorMessage } from '@/components/cmdb/hooks';
import { SoftwareNav } from '@/components/software/SoftwareNav';
import { InstallationForm } from '@/components/software/InstallationForm';
import { SourceBadge } from '@/components/software/SoftwareBits';
import { softwareApi, softwareKeys, SOURCE_LABELS, hostOf, titleOf, type SoftwareInstallation } from '@/components/software/api';

const DEFAULTS = { sort: 'lastSeenAt', order: 'desc' };
const FILTER_KEYS = ['q', 'customerId', 'productId', 'source', 'host', 'stale'];
const HOST_OPTIONS = [
  { value: 'ci', label: 'Linked to a CI' },
  { value: 'asset', label: 'Linked to an asset' },
  { value: 'unlinked', label: 'Not linked' },
];
/** The CSV columns the import understands (mirrors SOFTWARE_IMPORT_COLUMNS in the API). */
const IMPORT_COLUMNS = ['publisher', 'product', 'versionFamily', 'version', 'edition', 'hostname', 'assetTag', 'serialNumber', 'user', 'cores', 'installedAt', 'source', 'notes'];

/** Where every title is installed: the host, the user, the version, how it was recorded and when it was last seen. */
export default function SoftwareInstallationsPage() {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canManage = can('software:manage');
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const customers = useCustomersLookup();
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<SoftwareInstallation | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const query = useMemo(() => ({ page, pageSize, sort: state.sort, order: state.order, q: state.q, customerId: state.customerId, productId: state.productId, source: state.source, host: state.host, stale: state.stale, ciId: state.ciId, assetId: state.assetId }), [state, page, pageSize]);
  const list = useQuery({ queryKey: softwareKeys.installations(query), queryFn: () => softwareApi.installations(query), placeholderData: (prev) => prev });
  const overview = useQuery({ queryKey: softwareKeys.overview(state.customerId), queryFn: () => softwareApi.overview(state.customerId), staleTime: 60_000 });
  const products = useQuery({ queryKey: softwareKeys.products({ fields: 'min', pageSize: 500, includeInactive: 'true' }), queryFn: () => softwareApi.productsMin({ pageSize: 500, includeInactive: 'true' }), staleTime: 300_000 });
  const remove = useMutation({ mutationFn: (id: string) => softwareApi.deleteInstallation(id), onSuccess: () => { toast.success('Installation deleted'); qc.invalidateQueries({ queryKey: softwareKeys.all }); setDeleting(false); setSelected(null); }, onError: (e) => toast.error(errorMessage(e)) });
  const customerItems = customers.data?.items ?? [];
  const productItems = products.data?.items ?? [];
  const ov = overview.data;

  const columns: Column<SoftwareInstallation>[] = [
    { key: 'product', header: 'Title', sortable: true, render: (i) => <div className="leading-tight min-w-0"><div className="font-medium truncate">{titleOf(i)}</div>{i.edition && <div className="text-[11.5px] text-subtle">{i.edition}</div>}</div> },
    { key: 'customer', header: 'Customer', sortable: true, render: (i) => i.customerName ?? <span className="text-subtle">—</span> },
    { key: 'host', header: 'Host', sortable: true, render: (i) => i.ciId ? (
      <Link to={`/cmdb/cis/${i.ciId}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-brand-700 hover:underline"><Server className="h-3.5 w-3.5" /> {i.ciName}</Link>
    ) : i.assetId ? (
      <Link to={`/assets/${i.assetId}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[12.5px] text-brand-700 hover:underline">{i.assetTag}</Link>
    ) : i.hostName ? (
      <span className="inline-flex items-center gap-1 text-muted"><Unlink className="h-3.5 w-3.5 text-subtle" /> {i.hostName}</span>
    ) : <span className="text-subtle">—</span> },
    { key: 'user', header: 'User', render: (i) => i.assignedUser ?? <span className="text-subtle">—</span> },
    { key: 'version', header: 'Version', sortable: true, width: '120px', render: (i) => <span className="font-mono text-xs">{i.version ?? '—'}</span> },
    { key: 'source', header: 'Source', width: '140px', render: (i) => <SourceBadge source={i.source} /> },
    { key: 'lastSeenAt', header: 'Last seen', sortable: true, width: '130px', render: (i) => <span className={i.stale ? 'text-amber-600' : 'text-muted'}>{i.lastSeenAt ? relativeTime(i.lastSeenAt) : i.source === 'manual' ? 'by hand' : '—'}{i.stale ? ' · stale' : ''}</span> },
  ];
  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' }, false);
  const clear = () => set(Object.fromEntries([...FILTER_KEYS, 'ciId', 'assetId'].map((k) => [k, undefined])));
  const exportCsv = () => softwareApi.exportInstallations({ ...query, page: undefined, pageSize: undefined }).catch((e) => toast.error(errorMessage(e)));

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);
  if (state.productId) addApplied('productId', `Title: ${(() => { const p = productItems.find((x) => x.id === state.productId); return p ? titleOf(p) : '…'; })()}`);
  if (state.source) addApplied('source', `Source: ${SOURCE_LABELS[state.source] ?? state.source}`);
  if (state.host) addApplied('host', HOST_OPTIONS.find((o) => o.value === state.host)?.label ?? state.host);
  if (state.stale === 'true') addApplied('stale', 'Stale only');
  if (state.ciId) addApplied('ciId', 'On one CI');
  if (state.assetId) addApplied('assetId', 'On one asset');
  const total = list.data?.total;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Installations" subtitle="Which title sits on which host, for whom, and when it was last seen" actions={canManage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>Record installation</Button>} />
      <ListShell
        id="software-installations"
        modules={ASSET_MODULES}
        quick={<SoftwareNav />}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search title, host or user…' }}
        filters={
          <>
            <FilterGroup label="Customer">
              <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
            </FilterGroup>
            <FilterGroup label="Title">
              <FilterSelect value={state.productId ?? ''} onChange={(e) => set({ productId: e.target.value })} placeholder="All titles" options={productItems.map((p) => ({ value: p.id, label: titleOf(p) }))} />
            </FilterGroup>
            <FilterGroup label="Source">
              <FilterOptions options={INSTALL_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] ?? s, dot: dotClass(INSTALL_SOURCE_COLORS[s]) }))} value={state.source} onChange={(v) => set({ source: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Host link">
              <FilterOptions options={HOST_OPTIONS} value={state.host} onChange={(v) => set({ host: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Freshness">
              <FilterToggle label="Stale only" hint="Imported or discovered and not seen again within the stale window" checked={state.stale === 'true'} onChange={(v) => set({ stale: v ? 'true' : undefined })} />
            </FilterGroup>
          </>
        }
        applied={applied}
        activeCount={applied.length}
        onClear={clear}
        count={total !== undefined ? `${fmtNumber(total)} ${total === 1 ? 'installation' : 'installations'}` : undefined}
        toolbar={
          <>
            <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} onClick={exportCsv}>Export CSV</Button>
            {canManage && <Button variant="outline" size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => setImportOpen(true)}>Import CSV</Button>}
          </>
        }
        insights={
          <InsightBand
            id="software-installations"
            loading={overview.isLoading}
            summary={ov ? `${fmtNumber(ov.installations)} installations${state.customerId ? ' at this customer' : ''}` : undefined}
            columns={5}
            kpis={
              ov
                ? [
                    { label: 'Installations', value: fmtNumber(ov.installations), icon: <HardDrive className="h-4 w-4" />, hint: 'every record', onClick: () => set({ source: undefined, host: undefined, stale: undefined }), scrollTo: true },
                    { label: 'Titles', value: fmtNumber(ov.titlesInUse), icon: <Package className="h-4 w-4" />, hint: 'in use', to: `/assets/software/titles?inUseOnly=true${state.customerId ? `&customerId=${state.customerId}` : ''}` },
                    { label: 'Hosts', value: fmtNumber(ov.hosts), icon: <Server className="h-4 w-4" />, hint: 'CIs, assets and host names', onClick: () => set({ host: state.host === 'ci' ? undefined : 'ci' }), active: state.host === 'ci', scrollTo: true },
                    { label: 'Stale', value: fmtNumber(ov.stale), tone: ov.stale ? 'warn' : 'good', icon: <Clock className="h-4 w-4" />, hint: 'not seen within the stale window', onClick: () => set({ stale: state.stale === 'true' ? undefined : 'true' }), active: state.stale === 'true', scrollTo: true },
                    { label: 'Not linked', value: fmtNumber(ov.unlinked), tone: ov.unlinked ? 'warn' : 'good', icon: <Unlink className="h-4 w-4" />, hint: 'no CI or asset yet', onClick: () => set({ host: state.host === 'unlinked' ? undefined : 'unlinked' }), active: state.host === 'unlinked', scrollTo: true },
                  ]
                : []
            }
          />
        }
      >
        <div className="card overflow-hidden">
          <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} dense onRowClick={(i) => setSelected(i)} rowClassName={(i) => (i.stale ? 'row-rail-warn' : undefined)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} empty={<EmptyState icon={<HardDrive className="h-5 w-5" />} title="No installations match" description="Change or reset the filters, import a CSV from an inventory export, or record one by hand." action={canManage ? <Button size="sm" onClick={() => setImportOpen(true)}>Import CSV</Button> : undefined} />} />
          <Pagination page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={setPage} />
        </div>
      </ListShell>

      <Drawer open={!!selected && !editing} onClose={() => setSelected(null)} title={selected ? titleOf(selected) : ''} footer={selected && canManage ? <><Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleting(true)}>Delete</Button><Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button></> : undefined}>
        {selected && (
          <div className="flex flex-col gap-4">
            <KeyValue
              items={[
                { label: 'Customer', value: selected.customerName ?? '—' },
                { label: 'Title', value: <Link to={`/assets/software/titles/${selected.productId}?customerId=${selected.customerId}`} className="text-brand-700 hover:underline">{titleOf(selected)}</Link> },
                { label: 'Host', value: selected.ciId ? <Link to={`/cmdb/cis/${selected.ciId}`} className="text-brand-700 hover:underline">{selected.ciName}</Link> : selected.assetId ? <Link to={`/assets/${selected.assetId}`} className="font-mono text-brand-700 hover:underline">{selected.assetTag}</Link> : hostOf(selected) },
                { label: 'Host name', value: selected.hostName ?? '—' },
                { label: 'Asset', value: selected.assetId ? <Link to={`/assets/${selected.assetId}`} className="font-mono text-brand-700 hover:underline">{selected.assetTag}</Link> : '—' },
                { label: 'Site', value: selected.siteName ?? '—' },
                { label: 'User', value: selected.assignedUser ?? '—' },
                { label: 'Version', value: selected.version ? <span className="font-mono text-xs">{selected.version}</span> : '—' },
                { label: 'Edition', value: selected.edition ?? '—' },
                { label: 'Cores', value: selected.cores ?? '—' },
                { label: 'Installed on', value: selected.installedAt ? fmtDate(selected.installedAt) : '—' },
                { label: 'Source', value: <SourceBadge source={selected.source} /> },
                { label: 'Last seen', value: selected.lastSeenAt ? <span className={selected.stale ? 'text-amber-600' : undefined}>{fmtDateTime(selected.lastSeenAt)}{selected.stale ? ' · stale' : ''}</span> : '—' },
                { label: 'Discovered', value: selected.discoveredAt ? fmtDateTime(selected.discoveredAt) : '—' },
                { label: 'Install path', value: selected.installPath ? <span className="font-mono text-xs break-all">{selected.installPath}</span> : '—', span: 2 },
                { label: 'Notes', value: selected.notes ?? '—', span: 2 },
                { label: 'Recorded', value: fmtDateTime(selected.createdAt) },
                { label: 'Updated', value: fmtDateTime(selected.updatedAt) },
              ]}
            />
          </div>
        )}
      </Drawer>
      <InstallationForm open={createOpen} onClose={() => setCreateOpen(false)} defaultCustomerId={state.customerId} defaultProductId={state.productId} />
      <InstallationForm open={editing && !!selected} onClose={() => setEditing(false)} installation={selected} onSaved={(i) => setSelected(i)} />
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => selected && remove.mutate(selected.id)} loading={remove.isPending} danger confirmLabel="Delete installation" title="Delete this installation?" description="The host keeps its CI and asset records; only the software record is removed." />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} title="Import installations from CSV" endpoint="/software/installations/import" templatePath="/software/installations/import/template.csv" templateName="software-import-template.csv" columns={IMPORT_COLUMNS} customerId={state.customerId} onDone={() => { qc.invalidateQueries({ queryKey: softwareKeys.all }); qc.invalidateQueries({ queryKey: ['overview', 'software'] }); }} />
    </div>
  );
}
