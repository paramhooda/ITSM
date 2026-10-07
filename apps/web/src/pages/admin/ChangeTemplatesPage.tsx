import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ShieldCheck } from 'lucide-react';
import { Button, Badge, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MonoCell, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { MultiSelect } from '@/components/admin/inputs';
import { useAdminMutation } from '@/components/admin/api';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { relativeTime } from '@/lib/format';
import { changesApi, changeKeys, type ChangeTemplate } from '@/components/changes/api';

type Values = Record<string, unknown>;
const TYPE_OPTIONS = [
  { value: 'standard', label: 'Standard (pre-approved)' },
  { value: 'normal', label: 'Normal' },
  { value: 'emergency', label: 'Emergency' },
];

/** Standard change templates: repeatable, low-risk changes raised from a pattern, pre-approved when the template says so; the search, type, approval and include-inactive filters live in the URL (`q`, `changeType`, `approval`, `inactive`). */
export default function ChangeTemplatesPage() {
  const q = useQuery({ queryKey: changeKeys.templates({ all: true }), queryFn: () => changesApi.templates({ all: true }) });
  const editor = useEditor<ChangeTemplate>();
  const lookups = useLookups();
  const customers = useCustomersLookup();
  const invalidate = [['changes']];
  const create = useAdminMutation((body: Values) => changesApi.createTemplate(body), { invalidate, success: 'Template created' });
  const update = useAdminMutation(({ id, ...body }: Values & { id: string }) => changesApi.updateTemplate(id, body), { invalidate, success: 'Template updated' });
  const remove = useAdminMutation((id: string) => changesApi.deleteTemplate(id), { invalidate, success: 'Template deleted' });
  const customerOpts = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.code }));
  const categoryOpts = lookups.options('ticket_category').map((o) => ({ value: o.id, label: o.label }));
  const riskOpts = lookups.options('change_risk').map((o) => ({ value: o.id, label: o.label }));
  const serviceOpts = (lookups.lookups?.services ?? []).map((s) => ({ value: s.id, label: s.name }));
  const all = useMemo(() => q.data?.items ?? [], [q.data]);
  const f = useConfigFilter(all, {
    search: [(r) => r.name, (r) => r.key, (r) => r.description, (r) => r.riskLabel, (r) => r.categoryLabel, (r) => r.serviceName, (r) => r.titleTemplate],
    selects: [
      { key: 'changeType', label: 'Type', options: TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label.split(' (')[0] })), predicate: (r, v) => r.changeType === v },
      { key: 'approval', label: 'Approval', options: [{ value: 'pre', label: 'Pre-approved' }, { value: 'workflow', label: 'Workflow' }], predicate: (r, v) => (r.skipApproval ? 'pre' : 'workflow') === v },
    ],
    active: (r) => r.isActive,
    noun: ['template', 'templates'],
    searchPlaceholder: 'Search templates, services',
  });

  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Firewall firmware patch' },
    { key: 'key', label: 'Key', type: 'key', required: true, disabled: (v) => !!v.id },
    { key: 'description', label: 'Description', type: 'textarea', rows: 2, span: 2, placeholder: 'When to use this template' },
    { key: 'changeType', label: 'Change type', type: 'select', options: TYPE_OPTIONS, required: true },
    { key: 'riskId', label: 'Risk', type: 'select', options: riskOpts },
    { key: 'categoryId', label: 'Category', type: 'select', options: categoryOpts },
    { key: 'serviceId', label: 'Service', type: 'select', options: serviceOpts, hint: 'Prefilled on the change' },
    { key: 'downtimeExpectedMinutes', label: 'Expected downtime (min)', type: 'number', min: 0 },
    { key: 'titleTemplate', label: 'Default title', type: 'text', span: 2, section: 'Prefilled change' },
    { key: 'descriptionTemplate', label: 'Default description', type: 'textarea', rows: 2, span: 2 },
    { key: 'justification', label: 'Justification', type: 'textarea', rows: 2, span: 2 },
    { key: 'implementationPlan', label: 'Implementation plan', type: 'textarea', rows: 4, span: 2 },
    { key: 'testPlan', label: 'Test plan', type: 'textarea', rows: 3, span: 2 },
    { key: 'backoutPlan', label: 'Backout plan', type: 'textarea', rows: 3, span: 2 },
    { key: 'communicationPlan', label: 'Communication plan', type: 'textarea', rows: 2, span: 2 },
    { key: 'skipApproval', label: 'Pre-approved (no approval workflow)', type: 'boolean', section: 'Availability' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'customerIds', label: 'Offered to', type: 'custom', span: 2, hint: 'Empty = every customer', render: ({ value, onChange, disabled }) => <MultiSelect value={(value as string[]) ?? []} onChange={(ids) => onChange(ids)} options={customerOpts} disabled={disabled} placeholder="Search customers…" /> },
  ];
  const initial: Values = editor.row
    ? { ...editor.row, riskId: editor.row.riskId ?? '', categoryId: editor.row.categoryId ?? '', serviceId: editor.row.serviceId ?? '' }
    : { name: '', key: '', description: '', changeType: 'standard', riskId: '', categoryId: '', serviceId: '', downtimeExpectedMinutes: '', titleTemplate: '', descriptionTemplate: '', justification: '', implementationPlan: '', testPlan: '', backoutPlan: '', communicationPlan: '', skipApproval: true, isActive: true, customerIds: [] };
  async function submit(v: Values) {
    const str = (k: string) => ((v[k] as string) || '').trim() || null;
    const body = {
      name: v.name, key: v.key, description: str('description'), changeType: v.changeType || 'standard', riskId: (v.riskId as string) || null, categoryId: (v.categoryId as string) || null, serviceId: (v.serviceId as string) || null,
      downtimeExpectedMinutes: v.downtimeExpectedMinutes === '' || v.downtimeExpectedMinutes == null ? null : Number(v.downtimeExpectedMinutes),
      titleTemplate: str('titleTemplate'), descriptionTemplate: str('descriptionTemplate'), justification: str('justification'), implementationPlan: str('implementationPlan'), testPlan: str('testPlan'), backoutPlan: str('backoutPlan'), communicationPlan: str('communicationPlan'),
      skipApproval: !!v.skipApproval, isActive: !!v.isActive, customerIds: (v.customerIds as string[]) ?? [],
    };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync(body);
  }
  const columns: Column<ChangeTemplate>[] = [
    { key: 'name', header: 'Template', render: (r) => <div><div className="font-medium">{r.name}</div><MonoCell>{r.key}</MonoCell></div> },
    { key: 'changeType', header: 'Type', render: (r) => <Badge color={r.changeType === 'emergency' ? 'red' : r.changeType === 'standard' ? 'green' : 'slate'}>{r.changeType}</Badge> },
    { key: 'risk', header: 'Risk', render: (r) => <MutedCell>{r.riskLabel ?? '—'}</MutedCell> },
    { key: 'approval', header: 'Approval', render: (r) => (r.skipApproval ? <Badge color="green"><ShieldCheck className="h-3 w-3" /> pre-approved</Badge> : <Badge color="amber">workflow</Badge>) },
    { key: 'customers', header: 'Offered to', render: (r) => <MutedCell>{r.customerIds.length ? `${r.customerIds.length} customer${r.customerIds.length === 1 ? '' : 's'}` : 'Every customer'}</MutedCell> },
    { key: 'used', header: 'Used', width: '80px', render: (r) => <span className="tabular-nums text-[12.5px]">{r.usageCount}</span> },
    { key: 'lastUsed', header: 'Last used', width: '120px', render: (r) => <MutedCell>{r.lastUsedAt ? relativeTime(r.lastUsedAt) : 'never'}</MutedCell> },
    { key: 'isActive', header: 'Status', width: '90px', render: (r) => <ActiveDot active={r.isActive} /> },
  ];
  return (
    <div>
      <SectionHeader title="Standard change templates" description="Repeatable, low-risk changes raised from a pattern: the plans are prefilled on the new-change form and a pre-approved template skips the approval workflow." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New template</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<ChangeTemplate>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No templates match' : 'No templates yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Add the standard changes your engineers raise every month.'}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete "${r.name}"?`, description: 'Changes already raised from it keep their details.', confirmLabel: 'Delete' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? `Edit ${editor.row.name}` : 'New change template'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-3xl" />
    </div>
  );
}
