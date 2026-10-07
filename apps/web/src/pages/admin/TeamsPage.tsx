import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Star, Clock } from 'lucide-react';
import { get, post, patch, put, del } from '@/api/client';
import { Button, Badge, type Column } from '@/components/ui';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MonoCell, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { MultiSelect } from '@/components/admin/inputs';
import { useAdminMutation } from '@/components/admin/api';
import { oncallApi, oncallKeys } from '@/components/oncall/api';
import { ShiftsDialog } from '@/components/handover/ShiftsDialog';

interface Team {
  id: string;
  key: string;
  name: string;
  description: string | null;
  teamType: string;
  email: string | null;
  managerUserId: string | null;
  managerName: string | null;
  escalationPolicyId: string | null;
  isActive: boolean;
  members: { userId: string; name: string; email: string; isLead: boolean; status: string }[];
}

type Values = Record<string, unknown>;

export default function TeamsPage() {
  const q = useQuery({ queryKey: ['iam', 'teams'], queryFn: () => get<Team[]>('/iam/teams') });
  const editor = useEditor<Team>();
  const [shiftsFor, setShiftsFor] = useState<Team | null>(null);
  const lookups = useLookups();
  const engineers = useEngineers();
  const policies = useQuery({ queryKey: oncallKeys.policies, queryFn: oncallApi.policies, staleTime: 60_000 });
  const invalidate = [['iam', 'teams'], ['engineers'], ['oncall']];
  const create = useAdminMutation((body: Values) => post<Team>('/iam/teams', body), { invalidate, lookups: true });
  const update = useAdminMutation(({ id, ...body }: Values & { id: string }) => patch<Team>(`/iam/teams/${id}`, body), { invalidate, lookups: true });
  const setMembers = useAdminMutation(({ id, members }: { id: string; members: { userId: string; isLead: boolean }[] }) => put(`/iam/teams/${id}/members`, { members }), { invalidate, lookups: true });
  const remove = useAdminMutation((id: string) => del(`/iam/teams/${id}`), { invalidate, lookups: true, success: 'Team deleted' });

  const all = useMemo(() => q.data ?? [], [q.data]);
  const teamTypes = useMemo(() => lookups.options('team_type', { includeInactive: true }).map((o) => ({ value: o.key, label: o.label })), [lookups.lookups]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = useConfigFilter(all, {
    search: [(t) => t.name, (t) => t.key, (t) => t.description, (t) => t.email, (t) => t.managerName, (t) => t.members.map((m) => m.name)],
    selects: [{ key: 'teamType', label: 'Type', options: teamTypes, predicate: (t, v) => t.teamType === v }],
    active: (t) => t.isActive,
    noun: ['team', 'teams'],
    searchPlaceholder: 'Search teams, members',
  });

  const engineerOpts = (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name, hint: e.email }));
  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'key', label: 'Key', type: 'key', required: true, disabled: (v) => !!v.id },
    { key: 'teamType', label: 'Type', type: 'select', options: lookups.options('team_type').map((o) => ({ value: o.key, label: o.label })) },
    { key: 'email', label: 'Shared mailbox', type: 'email' },
    { key: 'managerUserId', label: 'Manager', type: 'select', options: engineerOpts, hint: 'Receives escalations for the team' },
    { key: 'escalationPolicyId', label: 'Default escalation policy', type: 'select', options: (policies.data ?? []).filter((p) => p.isActive).map((p) => ({ value: p.id, label: p.name })), hint: 'Whom a page for this team reaches (Operations → On-call → Policies)' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'description', label: 'Description', type: 'textarea', rows: 2 },
    { key: 'memberIds', label: 'Members', type: 'custom', section: 'Membership', render: ({ value, onChange, values, setValues }) => (
      <div className="flex flex-col gap-2">
        <MultiSelect value={(value as string[]) ?? []} onChange={(ids) => { onChange(ids); setValues({ leadIds: ((values.leadIds as string[]) ?? []).filter((l) => ids.includes(l)) }); }} options={engineerOpts} maxHeight="max-h-48" />
        {((value as string[]) ?? []).length > 0 && (
          <div className="rounded-lg border border-default p-2">
            <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-1">Team leads</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {((value as string[]) ?? []).map((id) => (
                <label key={id} className="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={((values.leadIds as string[]) ?? []).includes(id)} onChange={(e) => setValues({ leadIds: e.target.checked ? [...((values.leadIds as string[]) ?? []), id] : ((values.leadIds as string[]) ?? []).filter((x) => x !== id) })} />
                  {engineers.data?.find((e) => e.id === id)?.name ?? id}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    ) },
  ];

  const initial: Values = editor.row
    ? { ...editor.row, memberIds: editor.row.members.map((m) => m.userId), leadIds: editor.row.members.filter((m) => m.isLead).map((m) => m.userId) }
    : { key: '', name: '', teamType: 'general', email: '', managerUserId: null, escalationPolicyId: null, isActive: true, description: '', memberIds: [], leadIds: [] };

  async function submit(v: Values) {
    const members = ((v.memberIds as string[]) ?? []).map((userId) => ({ userId, isLead: ((v.leadIds as string[]) ?? []).includes(userId) }));
    let id = editor.row?.id;
    if (editor.row) await update.mutateAsync({ id: editor.row.id, name: v.name, description: v.description || null, teamType: v.teamType || 'general', email: v.email || null, managerUserId: v.managerUserId || null, escalationPolicyId: v.escalationPolicyId || null, isActive: !!v.isActive });
    else {
      const t = await create.mutateAsync({ key: v.key, name: v.name, description: v.description || undefined, teamType: v.teamType || 'general', email: v.email || undefined, managerUserId: v.managerUserId || null, escalationPolicyId: v.escalationPolicyId || null });
      id = t.id;
    }
    await setMembers.mutateAsync({ id: id!, members });
  }

  const columns: Column<Team>[] = [
    { key: 'name', header: 'Team', render: (r) => (
      <div>
        <div className="font-medium">{r.name}</div>
        <MonoCell>{r.key}</MonoCell>
      </div>
    ) },
    { key: 'teamType', header: 'Type', render: (r) => <Badge color="slate">{lookups.byKey('team_type', r.teamType)?.label ?? r.teamType}</Badge> },
    { key: 'email', header: 'Mailbox', render: (r) => <MutedCell>{r.email ?? '—'}</MutedCell> },
    { key: 'manager', header: 'Manager', render: (r) => <MutedCell>{r.managerName ?? '—'}</MutedCell> },
    { key: 'members', header: 'Members', render: (r) => (
      <span className="inline-flex items-center gap-1 flex-wrap">
        <span>{r.members.length}</span>
        {r.members.filter((m) => m.isLead).map((m) => <Badge key={m.userId} color="amber"><Star className="h-3 w-3" /> {m.name}</Badge>)}
      </span>
    ) },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  return (
    <div>
      <SectionHeader title="Teams" description="Operational groups (service desk, NOC, SOC, field...). Teams receive assignments, drive customer visibility and own CIs." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New team</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<Team>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No teams match' : 'No teams yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Create the operational groups that receive assignments and own CIs.'}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Shifts', icon: <Clock className="h-4 w-4" />, inline: true, onClick: (r) => setShiftsFor(r) },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete team "${r.name}"?`, description: 'Tickets assigned to it become unassigned.', confirmLabel: 'Delete team' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? `Edit ${editor.row.name}` : 'New team'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
      <ShiftsDialog open={!!shiftsFor} onClose={() => setShiftsFor(null)} team={shiftsFor} />
    </div>
  );
}
