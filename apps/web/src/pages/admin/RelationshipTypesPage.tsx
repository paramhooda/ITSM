import { useMemo } from 'react';
import { Plus, Pencil, Trash2, Ban } from 'lucide-react';
import { Button, Badge, type Column } from '@/components/ui';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MonoCell, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useConfigKind, useConfigMutations } from '@/components/admin/api';

interface RelType {
  id: string;
  key: string;
  name: string;
  inverseName: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
}

type Values = Record<string, unknown>;

export default function RelationshipTypesPage() {
  const q = useConfigKind<RelType>('relationship-types');
  const { create, update, remove } = useConfigMutations('relationship-types', { lookups: true, label: 'Relationship type' });
  const editor = useEditor<RelType>();
  const all = useMemo(() => q.data ?? [], [q.data]);
  const f = useConfigFilter(all, {
    search: [(r) => r.name, (r) => r.inverseName, (r) => r.key, (r) => r.description],
    active: (r) => r.isActive,
    noun: ['relationship type', 'relationship types'],
    searchPlaceholder: 'Search relationship types',
  });

  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Depends on' },
    { key: 'inverseName', label: 'Inverse name', type: 'text', required: true, placeholder: 'Is dependency of' },
    { key: 'key', label: 'Key', type: 'key', required: true, disabled: (v) => !!v.id },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'description', label: 'Description', type: 'textarea', rows: 2 },
  ];

  async function submit(v: Values) {
    const body = { name: v.name, inverseName: v.inverseName, description: v.description || null, isActive: !!v.isActive };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync({ ...body, key: v.key });
  }

  const columns: Column<RelType>[] = [
    { key: 'name', header: 'Relationship', render: (r) => <span className="inline-flex items-center gap-2 font-medium">{r.name}{r.isSystem && <Badge color="slate">system</Badge>}</span> },
    { key: 'inverseName', header: 'Inverse', render: (r) => <MutedCell>{r.inverseName}</MutedCell> },
    { key: 'key', header: 'Key', render: (r) => <MonoCell>{r.key}</MonoCell> },
    { key: 'description', header: 'Description', render: (r) => <MutedCell>{r.description ?? '—'}</MutedCell> },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  return (
    <div>
      <SectionHeader title="Relationship types" description="How configuration items relate to each other (A depends on B, B is a dependency of A). Used by the CMDB map and impact analysis." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New relationship type</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<RelType>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No relationship types match' : 'No relationship types yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : undefined}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Deactivate', icon: <Ban className="h-4 w-4" />, hidden: (r) => !r.isActive, onClick: (r) => update.mutate({ id: r.id, isActive: false }) },
          { label: 'Activate', icon: <Ban className="h-4 w-4" />, hidden: (r) => r.isActive, onClick: (r) => update.mutate({ id: r.id, isActive: true }) },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, hidden: (r) => r.isSystem, confirm: (r) => ({ title: `Delete relationship type "${r.name}"?`, description: 'Fails if CI relationships of this type exist.', confirmLabel: 'Delete type' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit relationship type' : 'New relationship type'} fields={fields} initial={editor.row ? { ...editor.row } : { key: '', name: '', inverseName: '', description: '', isActive: true }} onSubmit={submit} />
    </div>
  );
}
