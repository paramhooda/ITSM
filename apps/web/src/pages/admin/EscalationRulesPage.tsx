import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { TICKET_TYPES, SLA_METRICS } from '@itsm/shared';
import { Button, Badge, type Column } from '@/components/ui';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { CheckboxGroup } from '@/components/admin/inputs';
import { useRoles } from '@/components/admin/RoleAssignmentsEditor';
import { useConfigKind, useConfigMutations, moveNextTo } from '@/components/admin/api';
import { oncallApi, oncallKeys } from '@/components/oncall/api';

interface EscalationRule {
  id: string;
  name: string;
  sortOrder: number;
  conditions: { metric?: string; onBreach?: boolean; thresholdPct?: number; priorityKeys?: string[]; ticketTypes?: string[] };
  actions: { notifyAssignee?: boolean; notifyTeam?: boolean; notifyManager?: boolean; notifyOnCall?: boolean; notifyRoles?: string[]; notifyUserIds?: string[]; emails?: string[]; raiseEscalationLevel?: boolean; reassignTeamId?: string | null; raisePriorityKey?: string | null; pagePolicyId?: string | null; pageTeam?: boolean };
  isActive: boolean;
}

type Values = Record<string, unknown>;
const NOTIFY_FLAGS = [
  { value: 'notifyAssignee', label: 'Assignee' },
  { value: 'notifyTeam', label: 'Assigned team' },
  { value: 'notifyManager', label: 'Team manager' },
  { value: 'notifyOnCall', label: 'On-call engineer' },
];

/** Escalation rules in order, with the search, trigger and include-inactive filters in the URL (`q`, `trigger`, `inactive`). */
export default function EscalationRulesPage() {
  const q = useConfigKind<EscalationRule>('escalation-rules');
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder), [q.data]);
  const { create, update, remove } = useConfigMutations('escalation-rules', { label: 'Escalation rule' });
  const editor = useEditor<EscalationRule>();
  const lookups = useLookups();
  const engineers = useEngineers();
  const roles = useRoles();
  const priorities = lookups.options('ticket_priority');
  const teams = (lookups.lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }));
  const policies = useQuery({ queryKey: oncallKeys.policies, queryFn: oncallApi.policies, staleTime: 60_000 });
  const pageOptions = [{ value: 'team', label: "The assigned team's default policy" }, ...(policies.data ?? []).filter((p) => p.isActive).map((p) => ({ value: p.id, label: p.name }))];

  const describeTrigger = (r: EscalationRule) => {
    const c = r.conditions;
    const metric = !c.metric || c.metric === 'any' ? 'any SLA' : titleCase(c.metric);
    const when = c.onBreach ? 'breached' : `at ${c.thresholdPct ?? 75}%`;
    const scope = [c.priorityKeys?.length ? c.priorityKeys.map((k) => k.toUpperCase()).join('/') : null, c.ticketTypes?.length ? c.ticketTypes.map(titleCase).join('/') : null].filter(Boolean).join(' · ');
    return `${metric} ${when}${scope ? ` · ${scope}` : ''}`;
  };
  const describeActions = (r: EscalationRule) => {
    const a = r.actions;
    const parts: string[] = [];
    const notify = [a.notifyAssignee && 'assignee', a.notifyTeam && 'team', a.notifyManager && 'manager', a.notifyOnCall && 'on-call', a.notifyRoles?.length && `${a.notifyRoles.length} role(s)`, a.notifyUserIds?.length && `${a.notifyUserIds.length} user(s)`, a.emails?.length && `${a.emails.length} email(s)`].filter(Boolean);
    if (notify.length) parts.push(`notify ${notify.join(', ')}`);
    if (a.raiseEscalationLevel) parts.push('raise level');
    if (a.reassignTeamId) parts.push(`reassign → ${lookups.team(a.reassignTeamId)?.name ?? 'team'}`);
    if (a.raisePriorityKey) parts.push(`priority → ${a.raisePriorityKey.toUpperCase()}`);
    if (a.pageTeam) parts.push("page via the team's policy");
    else if (a.pagePolicyId) parts.push(`page via ${policies.data?.find((p) => p.id === a.pagePolicyId)?.name ?? 'policy'}`);
    return parts.join(' · ') || '—';
  };
  const f = useConfigFilter(rows, {
    search: [(r) => r.name, (r) => describeTrigger(r), (r) => describeActions(r)],
    selects: [{ key: 'trigger', label: 'Trigger', options: [{ value: 'breach', label: 'Breach' }, { value: 'warning', label: 'Warning' }], predicate: (r, v) => (r.conditions.onBreach ? 'breach' : 'warning') === v }],
    active: (r) => r.isActive,
    noun: ['rule', 'rules'],
    searchPlaceholder: 'Search rules, triggers, actions',
  });

  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Rule name', type: 'text', required: true },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'metric', label: 'SLA metric', type: 'select', section: 'Trigger', required: true, options: [{ value: 'any', label: 'Any metric' }, ...SLA_METRICS.map((m) => ({ value: m, label: titleCase(m) }))] },
    { key: 'trigger', label: 'Fires when', type: 'select', required: true, options: [{ value: 'threshold', label: 'Consumption reaches a threshold' }, { value: 'breach', label: 'The target is breached' }] },
    { key: 'thresholdPct', label: 'Threshold (% of target)', type: 'number', min: 1, max: 100, visible: (v) => v.trigger === 'threshold', required: true },
    { key: 'priorityKeys', label: 'Priorities', type: 'multiselect', options: priorities.map((p) => ({ value: p.key, label: p.label })), hint: 'Empty = any priority' },
    { key: 'ticketTypes', label: 'Ticket types', type: 'multiselect', options: TICKET_TYPES.map((t) => ({ value: t, label: titleCase(t) })), hint: 'Empty = any type' },
    { key: 'notifyFlags', label: 'Notify', type: 'custom', section: 'Actions', render: ({ value, onChange }) => <CheckboxGroup value={(value as string[]) ?? []} onChange={onChange} options={NOTIFY_FLAGS} columns={2} /> },
    { key: 'notifyRoles', label: 'Notify roles', type: 'multiselect', options: (roles.data ?? []).filter((r) => r.userType === 'msp').map((r) => ({ value: r.key, label: r.name })) },
    { key: 'notifyUserIds', label: 'Notify users', type: 'multiselect', options: (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name, hint: e.email })) },
    { key: 'emails', label: 'Additional emails', type: 'lines', rows: 2, placeholder: 'one address per line' },
    { key: 'raiseEscalationLevel', label: 'Raise escalation level', type: 'boolean', placeholder: 'Increase the ticket escalation level by one' },
    { key: 'reassignTeamId', label: 'Reassign to team', type: 'select', options: teams },
    { key: 'raisePriorityKey', label: 'Raise priority to', type: 'select', options: priorities.map((p) => ({ value: p.key, label: p.label })) },
    { key: 'page', label: 'Page on-call through', type: 'select', options: pageOptions, hint: 'Starts a page that escalates step by step until someone acknowledges (Operations → On-call → Policies)' },
  ];

  const initial: Values = editor.row
    ? {
        ...editor.row,
        metric: editor.row.conditions.metric ?? 'any',
        trigger: editor.row.conditions.onBreach ? 'breach' : 'threshold',
        thresholdPct: editor.row.conditions.thresholdPct ?? 75,
        priorityKeys: editor.row.conditions.priorityKeys ?? [],
        ticketTypes: editor.row.conditions.ticketTypes ?? [],
        notifyFlags: NOTIFY_FLAGS.map((f) => f.value).filter((f) => (editor.row!.actions as Record<string, unknown>)[f]),
        notifyRoles: editor.row.actions.notifyRoles ?? [],
        notifyUserIds: editor.row.actions.notifyUserIds ?? [],
        emails: editor.row.actions.emails ?? [],
        raiseEscalationLevel: !!editor.row.actions.raiseEscalationLevel,
        reassignTeamId: editor.row.actions.reassignTeamId ?? null,
        raisePriorityKey: editor.row.actions.raisePriorityKey ?? null,
        page: editor.row.actions.pageTeam ? 'team' : (editor.row.actions.pagePolicyId ?? null),
      }
    : { name: '', isActive: true, metric: 'any', trigger: 'threshold', thresholdPct: 75, priorityKeys: [], ticketTypes: [], notifyFlags: ['notifyAssignee', 'notifyTeam'], notifyRoles: [], notifyUserIds: [], emails: [], raiseEscalationLevel: false, reassignTeamId: null, raisePriorityKey: null, page: null };

  async function submit(v: Values) {
    const conditions: EscalationRule['conditions'] = { metric: String(v.metric ?? 'any') };
    if (v.trigger === 'breach') conditions.onBreach = true;
    else conditions.thresholdPct = Number(v.thresholdPct ?? 75);
    if ((v.priorityKeys as string[])?.length) conditions.priorityKeys = v.priorityKeys as string[];
    if ((v.ticketTypes as string[])?.length) conditions.ticketTypes = v.ticketTypes as string[];
    const flags = (v.notifyFlags as string[]) ?? [];
    const actions: EscalationRule['actions'] = { notifyAssignee: flags.includes('notifyAssignee'), notifyTeam: flags.includes('notifyTeam'), notifyManager: flags.includes('notifyManager'), notifyOnCall: flags.includes('notifyOnCall'), raiseEscalationLevel: !!v.raiseEscalationLevel };
    if ((v.notifyRoles as string[])?.length) actions.notifyRoles = v.notifyRoles as string[];
    if ((v.notifyUserIds as string[])?.length) actions.notifyUserIds = v.notifyUserIds as string[];
    if ((v.emails as string[])?.length) actions.emails = v.emails as string[];
    if (v.reassignTeamId) actions.reassignTeamId = v.reassignTeamId as string;
    if (v.raisePriorityKey) actions.raisePriorityKey = v.raisePriorityKey as string;
    if (v.page === 'team') actions.pageTeam = true;
    else if (v.page) actions.pagePolicyId = v.page as string;
    const body = { name: v.name, isActive: !!v.isActive, conditions, actions, sortOrder: editor.row?.sortOrder ?? (rows[rows.length - 1]?.sortOrder ?? 0) + 10 };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync(body);
  }

  const columns: Column<EscalationRule>[] = [
    { key: 'sortOrder', header: '#', width: '40px', render: (r) => <MutedCell>{rows.indexOf(r) + 1}</MutedCell> },
    { key: 'name', header: 'Rule', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'trigger', header: 'Trigger', render: (r) => <span className="inline-flex items-center gap-2"><Badge color={r.conditions.onBreach ? 'red' : 'amber'}>{r.conditions.onBreach ? 'breach' : 'warning'}</Badge><MutedCell>{describeTrigger(r)}</MutedCell></span> },
    { key: 'actions', header: 'Actions', render: (r) => <MutedCell>{describeActions(r)}</MutedCell> },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  const move = async (row: EscalationRule, dir: -1 | 1) => {
    // Past the row shown next to it: an inactive row hidden from the view keeps its place.
    const neighbour = f.matching[f.matching.findIndex((r) => r.id === row.id) + dir];
    if (!neighbour) return;
    for (const c of moveNextTo(rows, row.id, neighbour.id, dir)) if (rows.find((r) => r.id === c.id)?.sortOrder !== c.sortOrder) await update.mutateAsync(c);
  };

  return (
    <div>
      <SectionHeader title="Escalation rules" description="What happens when SLA consumption crosses a threshold or a target is breached. All matching rules fire." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New rule</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<EscalationRule>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No rules match' : 'No escalation rules yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Add a rule for what happens when an SLA clock reaches a threshold or breaches.'}
        actions={[
          // The arrows wait while a search or a pill narrows the view; the row moves past the row shown next to it.
          { label: 'Move up', icon: <ChevronUp className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, -1), disabled: (r) => f.narrowed || f.matching[0]?.id === r.id },
          { label: 'Move down', icon: <ChevronDown className="h-4 w-4" />, inline: true, onClick: (r) => void move(r, 1), disabled: (r) => f.narrowed || f.matching[f.matching.length - 1]?.id === r.id },
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete rule "${r.name}"?`, description: 'Tickets already escalated by this rule are not affected.', confirmLabel: 'Delete rule' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit escalation rule' : 'New escalation rule'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}
