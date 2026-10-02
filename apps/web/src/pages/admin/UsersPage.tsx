import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, KeyRound, Copy, UserX, UserCheck, Save } from 'lucide-react';
import { get, post, patch, put } from '@/api/client';
import { Button, Badge, Avatar, Card, Dialog, Drawer, Field, Input, Select, SearchInput, Pagination, Tabs, type Column } from '@/components/ui';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useListState } from '@/hooks/useListState';
import { useAuthStore } from '@/stores/auth';
import { fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MutedCell } from '@/components/admin/ConfigTable';
import { FormDialog, type FieldSpec } from '@/components/admin/FormDialog';
import { MultiSelect, timezoneOptions } from '@/components/admin/inputs';
import { RoleAssignmentsEditor, useRoles, type RoleAssignment } from '@/components/admin/RoleAssignmentsEditor';
import { errorMessage, useAdminMutation } from '@/components/admin/api';

interface UserRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  title: string | null;
  userType: 'msp' | 'customer';
  status: string;
  customerId: string | null;
  customerName: string | null;
  timezone: string;
  lastLoginAt: string | null;
  createdAt: string;
  roles: { roleId: string; key: string; name: string; customerId: string | null }[];
  teams: { id: string; key: string; name: string; isLead: boolean }[];
}
interface UserDetail extends UserRow {
  customerAccess: { customerId: string; customerName: string }[];
}

type Values = Record<string, unknown>;
const STATUS_COLOR: Record<string, string> = { active: 'green', invited: 'blue', disabled: 'gray', locked: 'red' };

export default function UsersPage() {
  const { state, set, page, pageSize, setPage } = useListState({ pageSize: '25' });
  const lookups = useLookups();
  const roles = useRoles();
  const customers = useCustomersLookup();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['iam', 'users', state], queryFn: () => get<{ items: UserRow[]; total: number }>('/iam/users', { ...state, page, pageSize }) });
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const createFields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Full name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
    { key: 'userType', label: 'User type', type: 'select', required: true, options: [{ value: 'msp', label: 'MSP staff' }, { value: 'customer', label: 'Customer (portal) user' }] },
    { key: 'customerId', label: 'Customer', type: 'select', required: true, visible: (v) => v.userType === 'customer', options: (customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })) },
    { key: 'title', label: 'Job title', type: 'text' },
    { key: 'phone', label: 'Phone', type: 'text' },
    { key: 'timezone', label: 'Timezone', type: 'select', options: timezoneOptions() },
    { key: 'password', label: 'Password', type: 'password', hint: 'Leave empty to generate a temporary password' },
    { key: 'roles', label: 'Roles', type: 'custom', section: 'Access', render: ({ value, onChange, values }) => <RoleAssignmentsEditor value={(value as RoleAssignment[]) ?? []} onChange={onChange} userType={(values.userType as 'msp' | 'customer') ?? 'msp'} /> },
    { key: 'teamIds', label: 'Teams', type: 'multiselect', visible: (v) => v.userType === 'msp', options: (lookups.lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name })) },
    { key: 'customerAccess', label: 'Explicit customer access', type: 'multiselect', visible: (v) => v.userType === 'msp', options: (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.code })), hint: 'Only needed for staff without MSP-wide visibility' },
    { key: 'sendWelcome', label: 'Welcome email', type: 'boolean', placeholder: 'Send sign-in details by email' },
  ];

  async function createUser(v: Values) {
    const assignments = ((v.roles as RoleAssignment[]) ?? []).filter((a) => a.roleId);
    const res = await post<{ user: UserDetail; temporaryPassword?: string }>('/iam/users', {
      name: v.name, email: v.email, userType: v.userType, customerId: v.userType === 'customer' ? v.customerId : null, title: v.title || undefined, phone: v.phone || undefined, timezone: v.timezone || undefined, password: v.password || undefined,
      roleIds: assignments.map((a) => ({ roleId: a.roleId, customerId: a.customerId })), teamIds: v.userType === 'msp' ? (v.teamIds as string[]) ?? [] : [], customerAccess: v.userType === 'msp' ? (v.customerAccess as string[]) ?? [] : [], sendWelcome: !!v.sendWelcome,
    });
    void qc.invalidateQueries({ queryKey: ['iam', 'users'] });
    toast.success('User created');
    if (res.temporaryPassword) setTempPassword(res.temporaryPassword);
  }

  const columns: Column<UserRow>[] = [
    { key: 'name', header: 'User', render: (r) => (
      <div className="flex items-center gap-2.5">
        <Avatar name={r.name} />
        <div className="min-w-0">
          <div className="font-medium truncate">{r.name}</div>
          <div className="text-[12px] text-muted truncate">{r.email}</div>
        </div>
      </div>
    ) },
    { key: 'userType', header: 'Type', render: (r) => (r.userType === 'customer' ? <Badge color="teal">Customer</Badge> : <Badge color="blue">MSP</Badge>) },
    { key: 'customer', header: 'Customer', render: (r) => <MutedCell>{r.customerName ?? '—'}</MutedCell> },
    { key: 'roles', header: 'Roles', render: (r) => <MutedCell>{r.roles.length ? [...new Set(r.roles.map((x) => x.name))].join(', ') : '—'}</MutedCell> },
    { key: 'teams', header: 'Teams', render: (r) => <MutedCell>{r.teams.length ? r.teams.map((t) => t.name).join(', ') : '—'}</MutedCell> },
    { key: 'status', header: 'Status', render: (r) => <Badge color={STATUS_COLOR[r.status] ?? 'slate'} dot>{titleCase(r.status)}</Badge> },
    { key: 'lastLoginAt', header: 'Last sign-in', render: (r) => <MutedCell><span className="whitespace-nowrap" title={r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : undefined}>{r.lastLoginAt ? relativeTime(r.lastLoginAt) : 'Never'}</span></MutedCell> },
  ];

  return (
    <div>
      <SectionHeader title="Users" description="MSP staff and customer portal users, their roles, teams and customer visibility." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New user</Button>} />
      <ConfigTable<UserRow>
        toolbar={
          <>
            <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} className="w-56" placeholder="Name or email" />
            <Select value={state.userType ?? ''} onChange={(e) => set({ userType: e.target.value })} className="w-36" placeholder="All types" options={[{ value: 'msp', label: 'MSP staff' }, { value: 'customer', label: 'Customer users' }]} />
            <Select value={state.status ?? ''} onChange={(e) => set({ status: e.target.value })} className="w-32" placeholder="Any status" options={['active', 'invited', 'disabled', 'locked'].map((s) => ({ value: s, label: titleCase(s) }))} />
            <Select value={state.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value })} className="w-44" placeholder="Any team" options={(lookups.lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} />
            <Select value={state.roleKey ?? ''} onChange={(e) => set({ roleKey: e.target.value })} className="w-44" placeholder="Any role" options={(roles.data ?? []).map((r) => ({ value: r.key, label: r.name }))} />
          </>
        }
        columns={columns}
        rows={q.data?.items ?? []}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={(r) => setSelectedId(r.id)}
        footer={<Pagination page={page} pageSize={pageSize} total={q.data?.total ?? 0} onPage={setPage} />}
      />
      <FormDialog<Values> open={createOpen} onClose={() => setCreateOpen(false)} title="New user" fields={createFields} initial={{ name: '', email: '', userType: 'msp', customerId: null, title: '', phone: '', timezone: 'Asia/Kolkata', password: '', roles: [], teamIds: [], customerAccess: [], sendWelcome: true }} onSubmit={createUser} variant="drawer" width="max-w-2xl" submitLabel="Create user" />
      {selectedId && <UserDrawer id={selectedId} onClose={() => setSelectedId(null)} onTempPassword={setTempPassword} />}
      <TempPasswordDialog password={tempPassword} onClose={() => setTempPassword(null)} />
    </div>
  );
}

function TempPasswordDialog({ password, onClose }: { password: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!password} onClose={onClose} title="Temporary password" width="max-w-md" footer={<Button onClick={onClose}>Done</Button>}>
      <div className="text-[13px] text-muted mb-3">Share this password securely with the user. It is shown only once; the user must change it at first sign-in.</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-[14px] rounded-lg border border-default bg-surface-2 px-3 py-2 select-all">{password}</code>
        <Button variant="outline" icon={<Copy className="h-4 w-4" />} onClick={() => { void navigator.clipboard?.writeText(password ?? ''); toast.success('Copied'); }}>
          Copy
        </Button>
      </div>
    </Dialog>
  );
}

function UserDrawer({ id, onClose, onTempPassword }: { id: string; onClose: () => void; onTempPassword: (p: string) => void }) {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const lookups = useLookups();
  const customers = useCustomersLookup();
  const q = useQuery({ queryKey: ['iam', 'user', id], queryFn: () => get<UserDetail>(`/iam/users/${id}`) });
  const u = q.data;
  const [tab, setTab] = useState<'profile' | 'access'>('profile');
  const invalidate = [['iam', 'user', id], ['iam', 'users']];
  const save = useAdminMutation((body: Values) => patch(`/iam/users/${id}`, body), { invalidate, success: 'User updated' });
  const setRoles = useAdminMutation((assignments: RoleAssignment[]) => put(`/iam/users/${id}/roles`, { assignments }), { invalidate, success: 'Roles updated' });
  const setTeams = useAdminMutation((teamIds: string[]) => put(`/iam/users/${id}/teams`, { teamIds }), { invalidate, success: 'Teams updated' });
  const setAccess = useAdminMutation((customerIds: string[]) => put(`/iam/users/${id}/customers`, { customerIds }), { invalidate, success: 'Customer access updated' });

  const [profile, setProfile] = useState<Values | null>(null);
  const [rolesDraft, setRolesDraft] = useState<RoleAssignment[] | null>(null);
  const [teamsDraft, setTeamsDraft] = useState<string[] | null>(null);
  const [accessDraft, setAccessDraft] = useState<string[] | null>(null);
  const p = profile ?? { name: u?.name ?? '', phone: u?.phone ?? '', title: u?.title ?? '', timezone: u?.timezone ?? 'UTC' };
  const rolesValue = rolesDraft ?? (u?.roles ?? []).map((r) => ({ roleId: r.roleId, customerId: r.customerId }));
  const teamsValue = teamsDraft ?? (u?.teams ?? []).map((t) => t.id);
  const accessValue = accessDraft ?? (u?.customerAccess ?? []).map((c) => c.customerId);

  async function resetPassword() {
    if (!confirm('Generate a new temporary password? Existing sessions are signed out.')) return;
    try {
      const res = await post<{ temporaryPassword?: string }>(`/iam/users/${id}/reset-password`, {});
      void qc.invalidateQueries({ queryKey: ['iam', 'user', id] });
      if (res.temporaryPassword) onTempPassword(res.temporaryPassword);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Drawer open onClose={onClose} title={u ? u.name : 'User'} width="max-w-2xl">
      {!u ? (
        <div className="text-muted text-[13px]">Loading…</div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Avatar name={u.name} size="md" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-muted">{u.email}</div>
              <div className="flex items-center gap-2 mt-1">
                {u.userType === 'customer' ? <Badge color="teal">Customer · {u.customerName}</Badge> : <Badge color="blue">MSP staff</Badge>}
                <Badge color={STATUS_COLOR[u.status] ?? 'slate'} dot>{titleCase(u.status)}</Badge>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={resetPassword}>
                Reset password
              </Button>
              {u.status === 'disabled' ? (
                <Button variant="outline" size="sm" icon={<UserCheck className="h-3.5 w-3.5" />} onClick={() => save.mutate({ status: 'active' })}>
                  Enable
                </Button>
              ) : (
                <Button variant="outline" size="sm" icon={<UserX className="h-3.5 w-3.5" />} disabled={me?.id === u.id} onClick={() => { if (confirm('Disable this account? The user is signed out immediately.')) save.mutate({ status: 'disabled' }); }}>
                  Disable
                </Button>
              )}
            </div>
          </div>
          <Tabs tabs={[{ key: 'profile', label: 'Profile' }, { key: 'access', label: 'Access' }]} value={tab} onChange={setTab} />
          {tab === 'profile' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Full name"><Input value={String(p.name)} onChange={(e) => setProfile({ ...p, name: e.target.value })} /></Field>
              <Field label="Job title"><Input value={String(p.title ?? '')} onChange={(e) => setProfile({ ...p, title: e.target.value })} /></Field>
              <Field label="Phone"><Input value={String(p.phone ?? '')} onChange={(e) => setProfile({ ...p, phone: e.target.value })} /></Field>
              <Field label="Timezone"><Select value={String(p.timezone)} options={timezoneOptions()} onChange={(e) => setProfile({ ...p, timezone: e.target.value })} /></Field>
              {u.userType === 'customer' && (
                <Field label="Customer" className="sm:col-span-2">
                  <Select value={u.customerId ?? ''} options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} onChange={(e) => e.target.value && save.mutate({ customerId: e.target.value })} />
                </Field>
              )}
              <div className="sm:col-span-2 flex items-center justify-between text-[12px] text-subtle">
                <span>Created {fmtDateTime(u.createdAt)} · last sign-in {u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'never'}</span>
                <Button size="sm" icon={<Save className="h-3.5 w-3.5" />} disabled={!profile} loading={save.isPending} onClick={() => save.mutate({ name: p.name, phone: p.phone || null, title: p.title || null, timezone: p.timezone }, { onSuccess: () => setProfile(null) })}>
                  Save profile
                </Button>
              </div>
            </div>
          )}
          {tab === 'access' && (
            <div className="flex flex-col gap-4">
              <Card title="Roles" actions={<Button size="sm" disabled={!rolesDraft} loading={setRoles.isPending} onClick={() => setRoles.mutate(rolesValue.filter((a) => a.roleId), { onSuccess: () => setRolesDraft(null) })}>Save</Button>}>
                <RoleAssignmentsEditor value={rolesValue} onChange={setRolesDraft} userType={u.userType} />
              </Card>
              {u.userType === 'msp' && (
                <>
                  <Card title="Teams" actions={<Button size="sm" disabled={!teamsDraft} loading={setTeams.isPending} onClick={() => setTeams.mutate(teamsValue, { onSuccess: () => setTeamsDraft(null) })}>Save</Button>}>
                    <MultiSelect value={teamsValue} onChange={setTeamsDraft} options={(lookups.lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} maxHeight="max-h-40" />
                  </Card>
                  <Card title="Explicit customer access" actions={<Button size="sm" disabled={!accessDraft} loading={setAccess.isPending} onClick={() => setAccess.mutate(accessValue, { onSuccess: () => setAccessDraft(null) })}>Save</Button>}>
                    <div className="text-[12.5px] text-muted mb-2">Customers this user can see in addition to those granted through scoped roles and team assignments. Not needed for roles with MSP-wide visibility.</div>
                    <MultiSelect value={accessValue} onChange={setAccessDraft} options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.code }))} maxHeight="max-h-40" emptyText={customers.isError ? 'Customer list unavailable' : 'No customers'} />
                  </Card>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
