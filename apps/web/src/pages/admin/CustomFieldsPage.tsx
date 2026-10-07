import { useMemo } from 'react';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { Button, Tabs, Badge, type Column } from '@/components/ui';
import { titleCase } from '@/lib/format';
import { useListState } from '@/hooks/useListState';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MonoCell, ActiveDot } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useConfigKind, useConfigMutations, moveNextTo } from '@/components/admin/api';

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

type Entity = (typeof ENTITIES)[number];

export default function CustomFieldsPage() {
  // The entity tab is part of the URL (`entity`, default ticket) like the conditions under it.
  const { state, set } = useListState();
  const entity: Entity = (ENTITIES as readonly string[]).includes(state.entity ?? '') ? (state.entity as Entity) : 'ticket';
  const setEntity = (e: Entity) => set({ entity: e === 'ticket' ? undefined : e });
  const q = useConfigKind<CustomField>('custom-fields');
  const all = useMemo(() => q.data ?? [], [q.data]);
  const rows = useMemo(() => all.filter((f) => f.entity === entity).sort((a, b) => a.sortOrder - b.sortOrder), [all, entity]);
  const { create, update, remove } = useConfigMutations('custom-fields', { label: 'Custom field' });
  const editor = useEditor<CustomField>();
  const f = useConfigFilter(rows, {
    search: [(r) => r.label, (r) => r.key, (r) => r.helpText, (r) => r.options.map((o) => o.label)],
    selects: [{ key: 'type', label: 'Type', options: FIELD_TYPES, predicate: (r, v) => r.fieldType === v }],
    active: (r) => r.isActive,
    noun: ['field', 'fields'],
    searchPlaceholder: 'Search fields',
  });

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
    // Past the row shown next to it: an inactive row hidden from the view keeps its place.
    const neighbour = f.matching[f.matching.findIndex((r) => r.id === row.id) + dir];
    if (!neighbour) return;
    for (const c of moveNextTo(rows, row.id, neighbour.id, dir)) if (rows.find((r) => r.id === c.id)?.sortOrder !== c.sortOrder) await update.mutateAsync(c);
  };

  return (
    <div>
      <SectionHeader title="Custom fields" description="Extend core records with additional fields. Values are stored on each record and shown in forms and detail views." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New field</Button>} />
      <Tabs tabs={ENTITIES.map((e) => ({ key: e, label: titleCase(e), count: all.filter((x) => x.entity === e).length }))} value={entity} onChange={setEntity} className="mb-3" />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<CustomField>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No fields match' : 'Nothing configured yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : `No custom fields for ${titleCase(entity).toLowerCase()} records yet.`}
        actions={[
          // The arrows wait while a search or a pill narrows the view; the row moves past the row shown next to it.
          { label: 'Move up', icon: <ChevronUp className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, -1), disabled: (r) => f.narrowed || f.matching[0]?.id === r.id },
          { label: 'Move down', icon: <ChevronDown className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, 1), disabled: (r) => f.narrowed || f.matching[f.matching.length - 1]?.id === r.id },
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete field "${r.label}"?`, description: 'Existing values stay on records but are no longer shown.', confirmLabel: 'Delete field' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit custom field' : `New ${titleCase(entity).toLowerCase()} field`} fields={fields} initial={initial} onSubmit={submit} />
    </div>
  );
}
