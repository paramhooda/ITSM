import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Pencil, Copy, Trash2, Eye, EyeOff } from 'lucide-react';
import { get, post, patch, del } from '@/api/client';
import { Button, Badge, Tabs, type Column } from '@/components/ui';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell, MonoCell } from '@/components/admin/ConfigTable';
import { FormDialog, FormFields, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { FormSchemaBuilder, type FormFieldDef } from '@/components/admin/FormSchemaBuilder';
import { useAdminMutation, slugify } from '@/components/admin/api';
import { useSlaPolicies } from '@/components/sla/api';
import { useConfigKind } from '@/components/admin/api';

interface CatalogItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryLabel: string | null;
  icon: string | null;
  formSchema: FormFieldDef[];
  slaPolicyId: string | null;
  slaPolicyName: string | null;
  teamId: string | null;
  teamName: string | null;
  approvalWorkflowId: string | null;
  approvalWorkflowName: string | null;
  ticketCategoryId: string | null;
  ticketCategoryLabel: string | null;
  defaultPriorityId: string | null;
  serviceId: string | null;
  fulfilmentInstructions: string | null;
  customerIds: string[];
  portalVisible: boolean;
  isActive: boolean;
  sortOrder: number;
  ticketCount: number;
}

type Values = Record<string, unknown>;

export default function CatalogPage() {
  const q = useQuery({ queryKey: ['catalog', 'items'], queryFn: () => get<{ items: CatalogItem[] }>('/catalog/items') });
  const editor = useEditor<CatalogItem>();
  const lookups = useLookups();
  const customers = useCustomersLookup();
  const policies = useSlaPolicies();
  const workflows = useConfigKind<{ id: string; name: string; isActive: boolean }>('approval-workflows');
  const invalidate = [['catalog']];
  const create = useAdminMutation((body: Values) => post<CatalogItem>('/catalog/items', body), { invalidate, success: 'Catalog item created' });
  const update = useAdminMutation(({ id, ...body }: Values & { id: string }) => patch<CatalogItem>(`/catalog/items/${id}`, body), { invalidate, success: 'Catalog item updated' });
  const remove = useAdminMutation((id: string) => del(`/catalog/items/${id}`), { invalidate, success: 'Catalog item deleted' });
  const clone = useAdminMutation((id: string) => post<CatalogItem>(`/catalog/items/${id}/clone`, {}), { invalidate, success: 'Catalog item cloned (inactive until published)', onSuccess: (item) => editor.edit(item) });
  const [tab, setTab] = useState<'details' | 'form'>('details');

  const detailFields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'key', label: 'Key', type: 'key', required: true, hint: 'Used by the API and integrations' },
    { key: 'description', label: 'Description', type: 'textarea', rows: 2, hint: 'Shown to requesters in the portal' },
    { key: 'categoryId', label: 'Catalog category', type: 'select', options: lookups.options('service_category').map((o) => ({ value: o.id, label: o.label })) },
    { key: 'icon', label: 'Icon', type: 'text', placeholder: 'lucide icon name', mono: true },
    { key: 'ticketCategoryId', label: 'Ticket category', type: 'select', section: 'Resulting ticket', options: lookups.options('ticket_category').map((o) => ({ value: o.id, label: o.label })) },
    { key: 'defaultPriorityId', label: 'Default priority', type: 'select', options: lookups.options('ticket_priority').map((o) => ({ value: o.id, label: o.label })) },
    { key: 'serviceId', label: 'Service', type: 'select', options: (lookups.lookups?.services ?? []).map((s) => ({ value: s.id, label: s.name })) },
    { key: 'teamId', label: 'Fulfilment team', type: 'select', options: (lookups.lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name })) },
    { key: 'slaPolicyId', label: 'SLA policy', type: 'select', options: (policies.data?.items ?? []).map((p) => ({ value: p.id, label: p.name })), hint: 'Overrides contract and service policies' },
    { key: 'approvalWorkflowId', label: 'Approval workflow', type: 'select', options: (workflows.data ?? []).filter((w) => w.isActive).map((w) => ({ value: w.id, label: w.name })) },
    { key: 'fulfilmentInstructions', label: 'Fulfilment instructions', type: 'textarea', rows: 4, hint: 'Internal guidance for the engineer; never shown to customers' },
    { key: 'customerIds', label: 'Restrict to customers', type: 'multiselect', section: 'Availability', options: (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.code })), hint: customers.isError ? 'Customer list unavailable' : 'Empty = offered to every customer' },
    { key: 'portalVisible', label: 'Portal', type: 'boolean', placeholder: 'Visible in the customer portal' },
    { key: 'isActive', label: 'Active', type: 'boolean', placeholder: 'Can be requested' },
    { key: 'sortOrder', label: 'Order', type: 'number', min: 0 },
  ];

  const initial: Values = editor.row
    ? { ...editor.row, formSchema: editor.row.formSchema ?? [] }
    : { key: '', name: '', description: '', categoryId: null, icon: '', ticketCategoryId: null, defaultPriorityId: null, serviceId: null, teamId: null, slaPolicyId: null, approvalWorkflowId: null, fulfilmentInstructions: '', customerIds: [], portalVisible: true, isActive: true, sortOrder: ((q.data?.items.length ?? 0) + 1) * 10, formSchema: [] };

  async function submit(v: Values) {
    const body = {
      key: v.key, name: v.name, description: v.description || null, categoryId: v.categoryId || null, icon: v.icon || null, ticketCategoryId: v.ticketCategoryId || null, defaultPriorityId: v.defaultPriorityId || null, serviceId: v.serviceId || null, teamId: v.teamId || null, slaPolicyId: v.slaPolicyId || null, approvalWorkflowId: v.approvalWorkflowId || null, fulfilmentInstructions: v.fulfilmentInstructions || null, customerIds: (v.customerIds as string[]) ?? [], portalVisible: !!v.portalVisible, isActive: !!v.isActive, sortOrder: Number(v.sortOrder ?? 0),
      formSchema: ((v.formSchema as FormFieldDef[]) ?? []).map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, ...(f.type === 'select' ? { options: (f.options ?? []).map((o) => o.trim()).filter(Boolean) } : {}), ...(f.helpText ? { helpText: f.helpText } : {}) })),
    };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync(body);
  }

  const columns: Column<CatalogItem>[] = [
    { key: 'name', header: 'Item', render: (r) => (
      <div>
        <div className="font-medium">{r.name}</div>
        <MonoCell>{r.key}</MonoCell>
      </div>
    ) },
    { key: 'category', header: 'Category', render: (r) => <MutedCell>{r.categoryLabel ?? r.ticketCategoryLabel ?? '—'}</MutedCell> },
    { key: 'sla', header: 'SLA', render: (r) => <MutedCell>{r.slaPolicyName ?? 'Inherited'}</MutedCell> },
    { key: 'team', header: 'Team', render: (r) => <MutedCell>{r.teamName ?? '—'}</MutedCell> },
    { key: 'approval', header: 'Approval', render: (r) => (r.approvalWorkflowName ? <Badge color="purple">{r.approvalWorkflowName}</Badge> : <MutedCell>None</MutedCell>) },
    { key: 'form', header: 'Form', render: (r) => <MutedCell>{r.formSchema.length} field{r.formSchema.length === 1 ? '' : 's'}</MutedCell> },
    { key: 'portal', header: 'Portal', render: (r) => (r.portalVisible ? <span className="inline-flex items-center gap-1 text-[12.5px]"><Eye className="h-3.5 w-3.5 text-muted" /> {r.customerIds.length ? `${r.customerIds.length} customer(s)` : 'All'}</span> : <span className="inline-flex items-center gap-1 text-[12.5px] text-subtle"><EyeOff className="h-3.5 w-3.5" /> Hidden</span>) },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  return (
    <div>
      <SectionHeader title="Service request catalog" description="Request types customers and engineers can raise, each with its own form, approval, team and SLA." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => { setTab('details'); editor.create(); }}>New item</Button>} />
      <ConfigTable<CatalogItem>
        columns={columns}
        rows={q.data?.items ?? []}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={(r) => { setTab('details'); editor.edit(r); }}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: (r) => { setTab('details'); editor.edit(r); } },
          { label: 'Clone', icon: <Copy className="h-4 w-4" />, inline: true, onClick: (r) => clone.mutate(r.id) },
          { label: 'Deactivate', icon: <EyeOff className="h-4 w-4" />, hidden: (r) => !r.isActive, onClick: (r) => update.mutate({ id: r.id, isActive: false }) },
          { label: 'Activate', icon: <Eye className="h-4 w-4" />, hidden: (r) => r.isActive, onClick: (r) => update.mutate({ id: r.id, isActive: true }) },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, disabled: (r) => r.ticketCount > 0, confirm: (r) => ({ title: `Delete "${r.name}"?`, description: 'Items that tickets were raised from cannot be deleted; deactivate those instead.', confirmLabel: 'Delete item' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values>
        open={editor.open}
        onClose={editor.close}
        title={editor.row ? `Edit ${editor.row.name}` : 'New catalog item'}
        fields={[]}
        initial={initial}
        onSubmit={submit}
        variant="drawer"
        width="max-w-4xl"
        submitLabel={editor.row ? 'Save' : 'Create'}
      >
        {(values, setValues) => (
          <div>
            <Tabs tabs={[{ key: 'details', label: 'Details' }, { key: 'form', label: 'Request form', count: ((values.formSchema as FormFieldDef[]) ?? []).length }]} value={tab} onChange={setTab} className="mb-4 -mt-2" />
            <div className={tab === 'details' ? '' : 'hidden'}>
              <FormFields
                fields={detailFields}
                values={values}
                setValues={(p) => {
                  // auto-derive the key from the name while creating
                  if (!editor.row && 'name' in p && (!values.key || values.key === slugify(String(values.name ?? '')))) p = { ...p, key: slugify(String(p.name ?? '')) };
                  setValues(p);
                }}
              />
            </div>
            <div className={tab === 'form' ? '' : 'hidden'}>
              <div className="text-[12.5px] text-muted mb-3">Questions the requester answers. Answers are stored on the ticket and shown to the fulfilment team.</div>
              <FormSchemaBuilder value={(values.formSchema as FormFieldDef[]) ?? []} onChange={(formSchema) => setValues({ formSchema })} />
            </div>
          </div>
        )}
      </FormDialog>
    </div>
  );
}
