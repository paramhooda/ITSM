import { Plus, Pencil, Trash2, X, ChevronUp, ChevronDown } from 'lucide-react';
import { Button, Select, Input, Badge, type Column } from '@/components/ui';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell } from '@/components/admin/ConfigTable';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useRoles } from '@/components/admin/RoleAssignmentsEditor';
import { useConfigKind, useConfigMutations } from '@/components/admin/api';

interface Step {
  name: string;
  approverType: 'customer_admin' | 'role' | 'user' | 'team' | 'account_manager';
  approverRef?: string | null;
  required: 'all' | 'any';
}
interface Workflow {
  id: string;
  name: string;
  description: string | null;
  steps: Step[];
  isActive: boolean;
}

const APPROVER_TYPES = [
  { value: 'customer_admin', label: 'Customer administrator' },
  { value: 'account_manager', label: 'Account manager' },
  { value: 'role', label: 'Users with role' },
  { value: 'team', label: 'Team' },
  { value: 'user', label: 'Specific user' },
];

type Values = Record<string, unknown>;

export default function ApprovalsPage() {
  const q = useConfigKind<Workflow>('approval-workflows');
  const { create, update, remove } = useConfigMutations('approval-workflows', { label: 'Approval workflow' });
  const editor = useEditor<Workflow>();
  const lookups = useLookups();
  const roles = useRoles();
  const engineers = useEngineers();

  const refLabel = (s: Step) => {
    if (s.approverType === 'role') return roles.data?.find((r) => r.key === s.approverRef)?.name ?? s.approverRef;
    if (s.approverType === 'team') return lookups.team(s.approverRef)?.name ?? 'team';
    if (s.approverType === 'user') return engineers.data?.find((e) => e.id === s.approverRef)?.name ?? 'user';
    return APPROVER_TYPES.find((t) => t.value === s.approverType)?.label ?? s.approverType;
  };

  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'description', label: 'Description', type: 'textarea', rows: 2 },
    { key: 'steps', label: 'Steps (in order)', type: 'custom', render: ({ value, onChange }) => <StepsEditor value={(value as Step[]) ?? []} onChange={onChange} /> },
  ];

  async function submit(v: Values) {
    const steps = ((v.steps as Step[]) ?? []).map((s) => ({ name: s.name?.trim() || APPROVER_TYPES.find((t) => t.value === s.approverType)?.label || 'Approval', approverType: s.approverType, approverRef: ['role', 'team', 'user'].includes(s.approverType) ? s.approverRef || null : null, required: s.required ?? 'any' }));
    if (!steps.length) throw new Error('Add at least one approval step');
    if (steps.some((s) => ['role', 'team', 'user'].includes(s.approverType) && !s.approverRef)) throw new Error('Each role/team/user step needs an approver');
    const body = { name: v.name, description: v.description || null, steps, isActive: !!v.isActive };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync(body);
  }

  const columns: Column<Workflow>[] = [
    { key: 'name', header: 'Workflow', render: (r) => (
      <div>
        <div className="font-medium">{r.name}</div>
        {r.description && <div className="text-[12px] text-muted">{r.description}</div>}
      </div>
    ) },
    { key: 'steps', header: 'Steps', render: (r) => (
      <div className="flex flex-wrap items-center gap-1">
        {r.steps.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {i > 0 && <span className="text-subtle text-[11px]">→</span>}
            <Badge color="slate">{s.name}: {refLabel(s)}{s.required === 'all' ? ' (all)' : ''}</Badge>
          </span>
        ))}
        {!r.steps.length && <MutedCell>No steps</MutedCell>}
      </div>
    ) },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  return (
    <div>
      <SectionHeader title="Approval workflows" description="Sequential approval steps for service requests and changes. Each step names who approves and whether all or any approver must agree." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New workflow</Button>} />
      <ConfigTable<Workflow>
        columns={columns}
        rows={q.data ?? []}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete workflow "${r.name}"?`, description: 'Catalog items using it will no longer require approval.', confirmLabel: 'Delete workflow' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit approval workflow' : 'New approval workflow'} fields={fields} initial={editor.row ? { ...editor.row } : { name: '', description: '', steps: [{ name: 'Customer approval', approverType: 'customer_admin', required: 'any' }], isActive: true }} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}

function StepsEditor({ value, onChange }: { value: Step[]; onChange: (v: unknown) => void }) {
  const lookups = useLookups();
  const roles = useRoles();
  const engineers = useEngineers();
  const update = (i: number, patch: Partial<Step>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const refOptions = (s: Step) => {
    if (s.approverType === 'role') return (roles.data ?? []).map((r) => ({ value: r.key, label: r.name }));
    if (s.approverType === 'team') return (lookups.lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }));
    if (s.approverType === 'user') return (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name }));
    return [];
  };
  return (
    <div className="flex flex-col gap-2">
      {value.map((s, i) => (
        <div key={i} className="rounded-lg border border-default p-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="h-6 w-6 rounded-full bg-surface-2 text-[11px] font-semibold inline-flex items-center justify-center shrink-0">{i + 1}</span>
            <Input value={s.name} placeholder="Step name" onChange={(e) => update(i, { name: e.target.value })} className="flex-1" />
            <button type="button" className="h-7 w-7 inline-flex items-center justify-center rounded text-subtle hover:text-default disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} title="Move up"><ChevronUp className="h-3.5 w-3.5" /></button>
            <button type="button" className="h-7 w-7 inline-flex items-center justify-center rounded text-subtle hover:text-default disabled:opacity-30" disabled={i === value.length - 1} onClick={() => move(i, 1)} title="Move down"><ChevronDown className="h-3.5 w-3.5" /></button>
            <button type="button" className="h-7 w-7 inline-flex items-center justify-center rounded text-subtle hover:text-red-600" onClick={() => onChange(value.filter((_, j) => j !== i))} title="Remove step"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pl-8">
            <Select value={s.approverType} options={APPROVER_TYPES} onChange={(e) => update(i, { approverType: e.target.value as Step['approverType'], approverRef: null })} />
            {['role', 'team', 'user'].includes(s.approverType) ? <Select value={s.approverRef ?? ''} placeholder="Select…" options={refOptions(s)} onChange={(e) => update(i, { approverRef: e.target.value || null })} /> : <div className="text-[12px] text-subtle self-center">Resolved from the ticket's customer</div>}
            <Select value={s.required ?? 'any'} options={[{ value: 'any', label: 'Any approver suffices' }, { value: 'all', label: 'All approvers required' }]} onChange={(e) => update(i, { required: e.target.value as Step['required'] })} />
          </div>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => onChange([...value, { name: '', approverType: 'role', approverRef: null, required: 'any' }])}>
          Add step
        </Button>
      </div>
    </div>
  );
}
