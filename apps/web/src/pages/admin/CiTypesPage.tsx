import { useMemo } from 'react';
import { Plus, Pencil, Trash2, Ban, ChevronUp, ChevronDown } from 'lucide-react';
import { Button, Badge, type Column } from '@/components/ui';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MonoCell, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { FormSchemaBuilder, ATTRIBUTE_FIELD_TYPES, type FormFieldDef } from '@/components/admin/FormSchemaBuilder';
import { ColorSwatch } from '@/components/admin/inputs';
import { useConfigKind, useConfigMutations, moveNextTo, slugify } from '@/components/admin/api';

interface CiType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  parentKey: string | null;
  icon: string | null;
  color: string | null;
  attributeSchema: FormFieldDef[];
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
}

type Values = Record<string, unknown>;

export default function CiTypesPage() {
  const q = useConfigKind<CiType>('ci-types');
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)), [q.data]);
  const { create, update, remove } = useConfigMutations('ci-types', { lookups: true, label: 'CI type' });
  const editor = useEditor<CiType>();
  const parentName = (key: string | null) => rows.find((x) => x.key === key)?.name ?? null;
  const f = useConfigFilter(rows, {
    search: [(r) => r.name, (r) => r.key, (r) => r.description, (r) => parentName(r.parentKey), (r) => r.attributeSchema?.map((a) => a.label)],
    selects: [{ key: 'parent', label: 'Parent', options: rows.filter((r) => rows.some((x) => x.parentKey === r.key)).map((r) => ({ value: r.key, label: r.name })), predicate: (r, v) => r.parentKey === v }],
    active: (r) => r.isActive,
    noun: ['CI type', 'CI types'],
    searchPlaceholder: 'Search CI types',
  });

  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'key', label: 'Key', type: 'key', required: true, disabled: (v) => !!v.id },
    { key: 'description', label: 'Description', type: 'text', span: 2 },
    { key: 'parentKey', label: 'Parent type', type: 'select', options: (v) => rows.filter((r) => r.key !== v.key).map((r) => ({ value: r.key, label: r.name })), hint: 'Inherits attributes conceptually; used for grouping' },
    { key: 'icon', label: 'Icon', type: 'text', placeholder: 'lucide icon name', mono: true },
    { key: 'color', label: 'Colour', type: 'color' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'sortOrder', label: 'Order', type: 'number', min: 0 },
    { key: 'attributeSchema', label: 'Attributes', type: 'custom', hint: 'Type-specific fields captured on each CI', render: ({ value, onChange }) => <FormSchemaBuilder value={(value as FormFieldDef[]) ?? []} onChange={onChange} types={ATTRIBUTE_FIELD_TYPES} preview={false} /> },
  ];

  const initial: Values = editor.row ? { ...editor.row, attributeSchema: editor.row.attributeSchema ?? [] } : { key: '', name: '', description: '', parentKey: null, icon: '', color: null, isActive: true, sortOrder: ((rows[rows.length - 1]?.sortOrder ?? 0) + 10), attributeSchema: [] };

  async function submit(v: Values) {
    const attributeSchema = ((v.attributeSchema as FormFieldDef[]) ?? []).map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, ...(f.type === 'select' ? { options: (f.options ?? []).map((o) => o.trim()).filter(Boolean) } : {}) }));
    const keys = attributeSchema.map((a) => a.key);
    if (keys.some((k) => !k || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(k))) throw new Error('Every attribute needs a valid key (letters, digits, underscore)');
    if (new Set(keys).size !== keys.length) throw new Error('Attribute keys must be unique');
    if (attributeSchema.some((a) => a.type === 'select' && !a.options?.length)) throw new Error('Select attributes need at least one option');
    const body = { name: v.name, description: v.description || null, parentKey: v.parentKey || null, icon: v.icon || null, color: v.color || null, isActive: !!v.isActive, sortOrder: Number(v.sortOrder ?? 0), attributeSchema };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync({ ...body, key: v.key || slugify(String(v.name)) });
  }

  const columns: Column<CiType>[] = [
    { key: 'name', header: 'Type', render: (r) => <span className="inline-flex items-center gap-2 font-medium">{r.name}{r.isSystem && <Badge color="slate">system</Badge>}</span> },
    { key: 'key', header: 'Key', render: (r) => <MonoCell>{r.key}</MonoCell> },
    { key: 'parentKey', header: 'Parent', render: (r) => <MutedCell>{parentName(r.parentKey) ?? '—'}</MutedCell> },
    { key: 'icon', header: 'Icon', render: (r) => <MonoCell>{r.icon ?? '—'}</MonoCell> },
    { key: 'color', header: 'Colour', render: (r) => <ColorSwatch color={r.color} /> },
    { key: 'attributes', header: 'Attributes', render: (r) => <MutedCell>{r.attributeSchema?.length ? r.attributeSchema.map((a) => a.label).join(', ') : '—'}</MutedCell> },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  const move = async (row: CiType, dir: -1 | 1) => {
    // Past the row shown next to it: an inactive row hidden from the view keeps its place.
    const neighbour = f.matching[f.matching.findIndex((r) => r.id === row.id) + dir];
    if (!neighbour) return;
    for (const c of moveNextTo(rows, row.id, neighbour.id, dir)) if (rows.find((r) => r.id === c.id)?.sortOrder !== c.sortOrder) await update.mutateAsync(c);
  };

  return (
    <div>
      <SectionHeader title="CI types" description="Configuration item classes with their attribute schemas. System types can be customised or deactivated but not deleted." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New CI type</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<CiType>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No CI types match' : 'No CI types yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : undefined}
        actions={[
          // The arrows wait while a search or a pill narrows the view; the row moves past the row shown next to it.
          { label: 'Move up', icon: <ChevronUp className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, -1), disabled: (r) => f.narrowed || f.matching[0]?.id === r.id },
          { label: 'Move down', icon: <ChevronDown className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, 1), disabled: (r) => f.narrowed || f.matching[f.matching.length - 1]?.id === r.id },
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Deactivate', icon: <Ban className="h-4 w-4" />, hidden: (r) => !r.isActive, onClick: (r) => update.mutate({ id: r.id, isActive: false }) },
          { label: 'Activate', icon: <Ban className="h-4 w-4" />, hidden: (r) => r.isActive, onClick: (r) => update.mutate({ id: r.id, isActive: true }) },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, hidden: (r) => r.isSystem, confirm: (r) => ({ title: `Delete CI type "${r.name}"?`, description: 'Fails if CIs of this type exist.', confirmLabel: 'Delete type' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? `Edit ${editor.row.name}` : 'New CI type'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}
