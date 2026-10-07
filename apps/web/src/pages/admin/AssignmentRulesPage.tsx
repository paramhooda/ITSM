import { useMemo } from 'react';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { TICKET_TYPES, DOMAINS } from '@itsm/shared';
import { Button, Badge, type Column } from '@/components/ui';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useConfigKind, useConfigMutations, moveNextTo } from '@/components/admin/api';

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

/** Assignment rules in evaluation order, with the search, strategy, team and include-inactive filters in the URL (`q`, `strategy`, `teamId`, `inactive`). */
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
  const engineerName = (id: string | null) => engineers.data?.find((e) => e.id === id)?.name;
  const strategyLabel = (key: string) => STRATEGIES.find((s) => s.value === key)?.label.split(' (')[0] ?? key;
  // The filter runs over the ordered list, so "#" stays the rule's position in the evaluation order even when the view is narrowed.
  const f = useConfigFilter(rows, {
    search: [(r) => r.name, (r) => describe(r), (r) => lookups.team(r.teamId)?.name, (r) => engineerName(r.userId), (r) => strategyLabel(r.strategy)],
    selects: [
      { key: 'strategy', label: 'Strategy', options: STRATEGIES.map((s) => ({ value: s.value, label: s.label.split(' (')[0] })), predicate: (r, v) => r.strategy === v },
      { key: 'teamId', label: 'Team', options: teams, predicate: (r, v) => r.teamId === v },
    ],
    active: (r) => r.isActive,
    noun: ['rule', 'rules'],
    searchPlaceholder: 'Search rules, teams, engineers',
  });

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

  const columns: Column<AssignmentRule>[] = [
    { key: 'sortOrder', header: '#', width: '40px', render: (r) => <MutedCell>{rows.indexOf(r) + 1}</MutedCell> },
    { key: 'name', header: 'Rule', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'conditions', header: 'When', render: (r) => <MutedCell>{describe(r)}</MutedCell> },
    { key: 'target', header: 'Assign to', render: (r) => (
      <span className="inline-flex items-center gap-2">
        {r.teamId && <Badge color="blue">{lookups.team(r.teamId)?.name ?? 'Team'}</Badge>}
        {r.userId && <Badge color="violet">{engineerName(r.userId) ?? 'Engineer'}</Badge>}
        <span className="text-[12px] text-subtle">{strategyLabel(r.strategy)}</span>
      </span>
    ) },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  const move = async (row: AssignmentRule, dir: -1 | 1) => {
    // Past the row shown next to it: an inactive row hidden from the view keeps its place.
    const neighbour = f.matching[f.matching.findIndex((r) => r.id === row.id) + dir];
    if (!neighbour) return;
    for (const c of moveNextTo(rows, row.id, neighbour.id, dir)) if (rows.find((r) => r.id === c.id)?.sortOrder !== c.sortOrder) await update.mutateAsync(c);
  };

  return (
    <div>
      <SectionHeader title="Assignment rules" description="Evaluated top to bottom when a ticket is created; the first matching rule assigns the team or engineer." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New rule</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<AssignmentRule>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No rules match' : 'No assignment rules yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Without rules, tickets stay unassigned until an engineer picks them up or a service default team applies.'}
        actions={[
          // The arrows wait while a search or a pill narrows the view; the row moves past the row shown next to it.
          { label: 'Move up', icon: <ChevronUp className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, -1), disabled: (r) => f.narrowed || f.matching[0]?.id === r.id },
          { label: 'Move down', icon: <ChevronDown className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, 1), disabled: (r) => f.narrowed || f.matching[f.matching.length - 1]?.id === r.id },
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete rule "${r.name}"?`, description: 'New tickets matching it are routed by the remaining rules.', confirmLabel: 'Delete rule' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit assignment rule' : 'New assignment rule'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}
