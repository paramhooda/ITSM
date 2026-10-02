import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { Button, Tabs, Badge, type Column } from '@/components/ui';
import { titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MonoCell, ActiveDot } from '@/components/admin/ConfigTable';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useConfigKind, useConfigMutations, moveInList } from '@/components/admin/api';

interface CustomField {
  id: string;
  entity: string;
  key: string;
  label: string;
  fieldType: string;
  options: { value: string; label: string }[];
  required: boolean;
  customerVisible: boolean;
  helpText?: string | null;
  sortOrder: number;
  isActive: boolean;
}

const ENTITIES = ['ticket', 'customer', 'site', 'contract', 'asset', 'ci', 'field_visit'] as const;
const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'multiselect', 'date', 'boolean', 'email', 'url'].map((t) => ({ value: t, label: titleCase(t) }));

type Values = Record<string, unknown>;

export default function CustomFieldsPage() {
  const [entity, setEntity] = useState<(typeof ENTITIES)[number]>('ticket');
  const q = useConfigKind<CustomField>('custom-fields');
  const all = q.data ?? [];
  const rows = useMemo(() => all.filter((f) => f.entity === entity).sort((a, b) => a.sortOrder - b.sortOrder), [all, entity]);
  const { create, update, remove } = useConfigMutations('custom-fields', { label: 'Custom field' });
  const editor = useEditor<CustomField>();

  const fields: FieldSpec<Values>[] = [
    { key: 'label', label: 'Label', type: 'text', required: true },
    { key: 'key', label: 'Key', type: 'key', required: true, disabled: (v) => !!v.id, hint: 'Stored under custom_fields on the record' },
    { key: 'fieldType', label: 'Type', type: 'select', required: true, options: FIELD_TYPES },
    { key: 'sortOrder', label: 'Order', type: 'number', min: 0 },
    { key: 'optionsText', label: 'Options', type: 'lines', rows: 4, placeholder: 'value|Label (one per line)', visible: (v) => v.fieldType === 'select' || v.fieldType === 'multiselect', hint: 'Use value|Label to show a different label' },
    { key: 'helpText', label: 'Help text', type: 'text' },
    { key: 'required', label: 'Required', type: 'boolean' },
    { key: 'customerVisible', label: 'Visible to customers', type: 'boolean', placeholder: 'Shown in the portal' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
  ];

  const initial: Values = editor.row
    ? { ...editor.row, optionsText: editor.row.options.map((o) => (o.value === o.label ? o.value : `${o.value}|${o.label}`)) }
    : { entity, key: '', label: '', fieldType: 'text', optionsText: [], helpText: '', required: false, customerVisible: false, isActive: true, sortOrder: (rows[rows.length - 1]?.sortOrder ?? 0) + 10 };

  async function submit(v: Values) {
    const options = ((v.optionsText as string[]) ?? []).map((line) => {
      const [value, label] = line.split('|').map((s) => s.trim());
      return { value, label: label || value };
    });
    const body = { entity, label: v.label, fieldType: v.fieldType, options: ['select', 'multiselect'].includes(String(v.fieldType)) ? options : [], helpText: v.helpText || null, required: !!v.required, customerVisible: !!v.customerVisible, isActive: !!v.isActive, sortOrder: Number(v.sortOrder ?? 0) };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync({ ...body, key: v.key });
  }

  const columns: Column<CustomField>[] = [
    { key: 'label', header: 'Label', render: (r) => <span className="inline-flex items-center gap-2">{r.label}{r.required && <span className="text-red-500">*</span>}</span> },
    { key: 'key', header: 'Key', render: (r) => <MonoCell>{r.key}</MonoCell> },
    { key: 'fieldType', header: 'Type', render: (r) => <Badge color="slate">{titleCase(r.fieldType)}</Badge> },
    { key: 'options', header: 'Options', render: (r) => <span className="text-muted text-[12.5px]">{r.options.length ? r.options.map((o) => o.label).join(', ') : '—'}</span> },
    { key: 'customerVisible', header: 'Portal', render: (r) => (r.customerVisible ? 'Visible' : <span className="text-subtle">Hidden</span>) },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  const move = async (row: CustomField, dir: -1 | 1) => {
    const changes = moveInList(rows, row.id, dir);
    for (const c of changes) if (rows.find((r) => r.id === c.id)?.sortOrder !== c.sortOrder) await update.mutateAsync(c);
  };

  return (
    <div>
      <SectionHeader title="Custom fields" description="Extend core records with additional fields. Values are stored on each record and shown in forms and detail views." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>Add field</Button>} />
      <Tabs tabs={ENTITIES.map((e) => ({ key: e, label: titleCase(e), count: all.filter((f) => f.entity === e).length }))} value={entity} onChange={setEntity} className="mb-3" />
      <ConfigTable<CustomField>
        columns={columns}
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyDescription={`No custom fields for ${titleCase(entity).toLowerCase()} records yet.`}
        actions={[
          { label: 'Move up', icon: <ChevronUp className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, -1), disabled: (r) => rows[0]?.id === r.id },
          { label: 'Move down', icon: <ChevronDown className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, 1), disabled: (r) => rows[rows.length - 1]?.id === r.id },
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: (r) => { if (confirm(`Delete field "${r.label}"? Existing values stay on records but are no longer shown.`)) remove.mutate(r.id); } },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit custom field' : `New ${titleCase(entity).toLowerCase()} field`} fields={fields} initial={initial} onSubmit={submit} />
    </div>
  );
}
