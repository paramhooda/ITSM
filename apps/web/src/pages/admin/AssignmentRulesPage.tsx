import { useMemo } from 'react';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { TICKET_TYPES, DOMAINS } from '@itsm/shared';
import { Button, Badge, type Column } from '@/components/ui';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell } from '@/components/admin/ConfigTable';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useConfigKind, useConfigMutations, moveInList } from '@/components/admin/api';

interface AssignmentRule {
  id: string;
  name: string;
  sortOrder: number;
  conditions: { ticketTypes?: string[]; categoryIds?: string[]; serviceIds?: string[]; customerIds?: string[]; priorityIds?: string[]; domains?: string[] };
  teamId: string | null;
  userId: string | null;
  strategy: string;
  isActive: boolean;
}

const STRATEGIES = [
  { value: 'team', label: 'Assign to team (unassigned engineer)' },
  { value: 'round_robin', label: 'Round-robin across team members' },
  { value: 'least_loaded', label: 'Least loaded team member' },
  { value: 'user', label: 'Assign to a specific engineer' },
];

type Values = Record<string, unknown>;

export default function AssignmentRulesPage() {
  const q = useConfigKind<AssignmentRule>('assignment-rules');
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder), [q.data]);
  const { create, update, remove } = useConfigMutations('assignment-rules', { label: 'Assignment rule' });
  const editor = useEditor<AssignmentRule>();
  const lookups = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();

  const categories = lookups.options('ticket_category').map((o) => ({ value: o.id, label: o.label, hint: o.domain !== 'general' ? o.domain.toUpperCase() : undefined }));
  const priorities = lookups.options('ticket_priority').map((o) => ({ value: o.id, label: o.label }));
  const services = (lookups.lookups?.services ?? []).map((s) => ({ value: s.id, label: s.name }));
  const teams = (lookups.lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }));
  const customerOpts = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.code }));
  const engineerOpts = (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name, hint: e.email }));

  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Rule name', type: 'text', required: true },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'ticketTypes', label: 'Ticket types', type: 'multiselect', section: 'Conditions (all that are set must match)', options: TICKET_TYPES.map((t) => ({ value: t, label: titleCase(t) })), hint: 'Empty = any type' },
    { key: 'domains', label: 'Domains', type: 'multiselect', options: DOMAINS.map((d) => ({ value: d, label: d === 'general' ? 'General' : d.toUpperCase().replace('_', ' ') })) },
    { key: 'categoryIds', label: 'Categories', type: 'multiselect', options: categories },
    { key: 'priorityIds', label: 'Priorities', type: 'multiselect', options: priorities },
    { key: 'serviceIds', label: 'Services', type: 'multiselect', options: services },
    { key: 'customerIds', label: 'Customers', type: 'multiselect', options: customerOpts, hint: customers.isError ? 'Customer list unavailable' : undefined },
    { key: 'strategy', label: 'Strategy', type: 'select', required: true, section: 'Assignment', options: STRATEGIES, span: 2 },
    { key: 'teamId', label: 'Team', type: 'select', options: teams, required: true },
    { key: 'userId', label: 'Engineer', type: 'select', options: engineerOpts, visible: (v) => v.strategy === 'user', required: true },
  ];

  const initial: Values = editor.row
    ? { ...editor.row, ...editor.row.conditions, ticketTypes: editor.row.conditions.ticketTypes ?? [], domains: editor.row.conditions.domains ?? [], categoryIds: editor.row.conditions.categoryIds ?? [], priorityIds: editor.row.conditions.priorityIds ?? [], serviceIds: editor.row.conditions.serviceIds ?? [], customerIds: editor.row.conditions.customerIds ?? [] }
    : { name: '', isActive: true, ticketTypes: [], domains: [], categoryIds: [], priorityIds: [], serviceIds: [], customerIds: [], strategy: 'team', teamId: null, userId: null };

  async function submit(v: Values) {
    const conditions: AssignmentRule['conditions'] = {};
    for (const k of ['ticketTypes', 'categoryIds', 'serviceIds', 'customerIds', 'priorityIds', 'domains'] as const) if ((v[k] as string[])?.length) conditions[k] = v[k] as string[];
    const body = { name: v.name, isActive: !!v.isActive, conditions, strategy: v.strategy, teamId: v.teamId || null, userId: v.strategy === 'user' ? v.userId || null : null, sortOrder: editor.row?.sortOrder ?? (rows[rows.length - 1]?.sortOrder ?? 0) + 10 };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync(body);
  }

  const describe = (r: AssignmentRule) => {
    const c = r.conditions;
    const parts: string[] = [];
    if (c.ticketTypes?.length) parts.push(c.ticketTypes.map(titleCase).join('/'));
    if (c.domains?.length) parts.push(c.domains.map((d) => d.toUpperCase()).join('/'));
    if (c.categoryIds?.length) parts.push(`${c.categoryIds.length} categor${c.categoryIds.length > 1 ? 'ies' : 'y'}`);
    if (c.priorityIds?.length) parts.push(c.priorityIds.map((id) => lookups.byId(id)?.key.toUpperCase() ?? '?').join('/'));
    if (c.serviceIds?.length) parts.push(`${c.serviceIds.length} service${c.serviceIds.length > 1 ? 's' : ''}`);
    if (c.customerIds?.length) parts.push(`${c.customerIds.length} customer${c.customerIds.length > 1 ? 's' : ''}`);
    return parts.length ? parts.join(' · ') : 'Any ticket';
  };

  const columns: Column<AssignmentRule>[] = [
    { key: 'sortOrder', header: '#', width: '40px', render: (r) => <MutedCell>{rows.indexOf(r) + 1}</MutedCell> },
    { key: 'name', header: 'Rule', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'conditions', header: 'When', render: (r) => <MutedCell>{describe(r)}</MutedCell> },
    { key: 'target', header: 'Assign to', render: (r) => (
      <span className="inline-flex items-center gap-2">
        {r.teamId && <Badge color="blue">{lookups.team(r.teamId)?.name ?? 'Team'}</Badge>}
        {r.userId && <Badge color="violet">{engineers.data?.find((e) => e.id === r.userId)?.name ?? 'Engineer'}</Badge>}
        <span className="text-[12px] text-subtle">{STRATEGIES.find((s) => s.value === r.strategy)?.label.split(' (')[0] ?? r.strategy}</span>
      </span>
    ) },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  const move = async (row: AssignmentRule, dir: -1 | 1) => {
    for (const c of moveInList(rows, row.id, dir)) if (rows.find((r) => r.id === c.id)?.sortOrder !== c.sortOrder) await update.mutateAsync(c);
  };

  return (
    <div>
      <SectionHeader title="Assignment rules" description="Evaluated top to bottom when a ticket is created; the first matching rule assigns the team or engineer." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New rule</Button>} />
      <ConfigTable<AssignmentRule>
        columns={columns}
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyDescription="Without rules, tickets stay unassigned until an engineer picks them up or a service default team applies."
        actions={[
          { label: 'Move up', icon: <ChevronUp className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, -1), disabled: (r) => rows[0]?.id === r.id },
          { label: 'Move down', icon: <ChevronDown className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, 1), disabled: (r) => rows[rows.length - 1]?.id === r.id },
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete rule "${r.name}"?`, description: 'New tickets matching it are routed by the remaining rules.', confirmLabel: 'Delete rule' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit assignment rule' : 'New assignment rule'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}
