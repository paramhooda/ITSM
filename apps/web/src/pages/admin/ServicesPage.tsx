import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, FolderTree } from 'lucide-react';
import { get, post, patch, del } from '@/api/client';
import { Button, Badge, type Column } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MonoCell, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type Values } from '@/components/admin/FormDialog';
import { useAdminMutation } from '@/components/admin/api';
import { useServiceFields, serviceInitial, toServicePayload, flattenCatalog, DOMAIN_LABEL, type Catalog, type Service, type ServicePayload } from '@/components/admin/ServiceForm';
import { DOMAIN_COLORS } from '@/lib/statusColors';
import { DOMAINS } from '@itsm/shared';

/**
 * Service catalog management: the list of offerings with one drawer for create
 * and edit. `?new=1` opens the editor (the browse page links here); the search,
 * domain and service line filters live in the URL (`q`, `domain`, `line`, `inactive`).
 */
export default function ServicesPage() {
  const [params, setParams] = useSearchParams();
  const { options } = useLookups();
  const catalog = useQuery({ queryKey: ['services', 'catalog', { admin: true }], queryFn: () => get<Catalog>('/services/catalog', { includeInactive: 'true' }) });
  const editor = useEditor<Service>();
  const invalidate = [['services']];
  const create = useAdminMutation((body: ServicePayload) => post<Service>('/services', body), { invalidate, lookups: true, success: 'Service created' });
  const update = useAdminMutation(({ id, ...body }: Partial<ServicePayload> & { id: string }) => patch<Service>(`/services/${id}`, body), { invalidate, lookups: true, success: 'Service updated' });
  const remove = useAdminMutation((s: Service) => del<{ deleted?: boolean; deactivated?: boolean }>(`/services/${s.id}`), { invalidate, lookups: true, onSuccess: (r) => toast.success(r.deactivated ? 'Service is referenced by contracts or tickets and was deactivated instead' : 'Service deleted') });

  // `?new=1` / `?edit=<id>` deep-link into the editor (from the browse page and old links), then drop from the URL.
  useEffect(() => {
    const editId = params.get('edit');
    if (params.get('new') === '1') editor.create();
    else if (editId) {
      const row = flattenCatalog(catalog.data).find((s) => s.id === editId);
      if (!row) return; // wait for the catalog to load
      editor.edit(row);
    } else return;
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('edit');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, catalog.data]);

  const fields = useServiceFields();
  const statuses = options('service_status');
  const all = useMemo(() => flattenCatalog(catalog.data), [catalog.data]);
  const lines = useMemo(() => (catalog.data?.categories ?? []).map((c) => ({ value: c.id, label: c.label })), [catalog.data]);
  const f = useConfigFilter(all, {
    search: [(s) => s.name, (s) => s.key, (s) => s.description, (s) => s.categoryLabel, (s) => s.subcategoryLabel, (s) => s.defaultTeamName, (s) => s.defaultSlaPolicyName],
    selects: [
      { key: 'domain', label: 'Domain', options: DOMAINS.map((d) => ({ value: d, label: DOMAIN_LABEL[d] ?? d })), predicate: (s, v) => s.domain === v },
      { key: 'line', label: 'Service line', options: lines, predicate: (s, v) => s.categoryId === v },
    ],
    active: (s) => s.isActive,
    noun: ['service', 'services'],
    searchPlaceholder: 'Search services',
  });

  async function submit(v: Values) {
    const payload = toServicePayload(v, (categoryId) => options('service_subcategory', { parentId: categoryId }).map((o) => o.id));
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...payload });
    else await create.mutateAsync(payload);
  }

  const columns: Column<Service>[] = [
    { key: 'name', header: 'Service', render: (r) => (
      <div className="min-w-0">
        <div className="font-medium truncate">{r.name}</div>
        <MonoCell>{r.key}</MonoCell>
      </div>
    ) },
    { key: 'line', header: 'Service line', render: (r) => <MutedCell>{[r.categoryLabel, r.subcategoryLabel].filter(Boolean).join(' › ') || 'Uncategorised'}</MutedCell> },
    { key: 'domain', header: 'Domain', render: (r) => <Badge color={DOMAIN_COLORS[r.domain] ?? 'slate'}>{DOMAIN_LABEL[r.domain] ?? r.domain}</Badge> },
    { key: 'team', header: 'Default team', render: (r) => <MutedCell>{r.defaultTeamName ?? '—'}</MutedCell> },
    { key: 'sla', header: 'Default SLA', render: (r) => <MutedCell>{r.defaultSlaPolicyName ?? 'Platform default'}</MutedCell> },
    { key: 'usage', header: 'In use', render: (r) => <MutedCell><span className="tnum">{r.counts.activeContracts} contract{r.counts.activeContracts === 1 ? '' : 's'} · {r.counts.openTickets} open</span></MutedCell> },
    { key: 'status', header: 'Status', render: (r) => (r.statusLabel && r.statusLabel !== 'Active' ? <Badge color={r.statusColor ?? undefined}>{r.statusLabel}</Badge> : <ActiveDot active={r.isActive} />) },
  ];

  return (
    <div>
      <SectionHeader
        title="Service catalog"
        description="The services you deliver, organised by service line and offering group. Contracts reference these for coverage, SLA and scope."
        actions={
          <>
            <Link to="/admin/options/service_category"><Button variant="outline" icon={<FolderTree className="h-4 w-4" />}>Service lines</Button></Link>
            <Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New service</Button>
          </>
        }
      />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<Service>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={catalog.isLoading}
        error={catalog.error}
        retry={() => catalog.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No services match' : 'No services yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Define the services you deliver; contracts reference them for coverage, SLA and scope.'}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete "${r.name}"?`, description: 'Services referenced by contracts, tickets or catalog items are deactivated instead of removed.', confirmLabel: 'Delete service' }), onClick: (r) => remove.mutate(r) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? `Edit ${editor.row.name}` : 'New service'} fields={fields} initial={serviceInitial(editor.row, statuses.find((s) => s.isDefault)?.id ?? null)} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}
