import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, KeyRound, Copy, UserX, UserCheck, Unlink } from 'lucide-react';
import { get, post, patch, put } from '@/api/client';
import { Button, Badge, Avatar, Dialog, ConfirmDialog, Select, SearchInput, Pagination, type Column } from '@/components/ui';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useListState } from '@/hooks/useListState';
import { useAuthStore } from '@/stores/auth';
import { fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MutedCell } from '@/components/admin/ConfigTable';
import { FormDialog, type FieldSpec } from '@/components/admin/FormDialog';
import { timezoneOptions } from '@/components/admin/inputs';
import { RoleAssignmentsEditor, useRoles, type RoleAssignment } from '@/components/admin/RoleAssignmentsEditor';
import { errorMessage } from '@/components/admin/api';
import { WHATSAPP_LINK_COLORS } from '@/lib/statusColors';
import { whatsappApi } from '@/components/whatsapp/api';

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
  whatsappOptIn: boolean;
  /** Set when the person proved they control the phone number with a one-time code over WhatsApp. */
  whatsappVerifiedAt: string | null;
  /** The person switched "WhatsApp chat with Grady" on (meaningful only with a verified number). */
  assistantOn: boolean;
  roles: { roleId: string; key: string; name: string; customerId: string | null }[];
  teams: { id: string; key: string; name: string; isLead: boolean }[];
}
interface UserDetail extends UserRow {
  customerAccess: { customerId: string; customerName: string }[];
}

type Values = Record<string, unknown>;
const STATUS_COLOR: Record<string, string> = { active: 'green', invited: 'blue', disabled: 'gray', locked: 'red' };

/**
 * Users: list + one editor drawer used for both "New user" and editing an
 * existing user (same fields; sign-in details only on create, account actions
 * only on edit).
 */
export default function UsersPage() {
  const { state, set, page, pageSize, setPage } = useListState({ pageSize: '25' });
  const lookups = useLookups();
  const roles = useRoles();
  const customers = useCustomersLookup();
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const q = useQuery({ queryKey: ['iam', 'users', state], queryFn: () => get<{ items: UserRow[]; total: number }>('/iam/users', { ...state, page, pageSize }) });
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['iam', 'user', selectedId], queryFn: () => get<UserDetail>(`/iam/users/${selectedId}`), enabled: !!selectedId });
  const u = selectedId ? detail.data ?? null : null;
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const invalidateUsers = () => {
    void qc.invalidateQueries({ queryKey: ['iam', 'users'] });
    if (selectedId) void qc.invalidateQueries({ queryKey: ['iam', 'user', selectedId] });
  };
  const close = () => {
    setCreateOpen(false);
    setSelectedId(null);
  };

  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Full name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true, disabled: (v) => !!v.id },
    { key: 'userType', label: 'User type', type: 'select', required: true, disabled: (v) => !!v.id, options: [{ value: 'msp', label: 'MSP staff' }, { value: 'customer', label: 'Customer (portal) user' }] },
    { key: 'customerId', label: 'Customer', type: 'select', required: true, visible: (v) => v.userType === 'customer', options: (customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })) },
    { key: 'title', label: 'Job title', type: 'text' },
    { key: 'phone', label: 'Phone', type: 'text' },
    { key: 'whatsapp', label: 'WhatsApp chat with Grady', type: 'custom', visible: (v) => !!v.id, render: () => (u ? <WhatsAppChatLine user={u} onRevoke={() => setConfirmRevoke(true)} /> : null) },
    { key: 'timezone', label: 'Timezone', type: 'select', options: timezoneOptions() },
    { key: 'password', label: 'Password', type: 'password', visible: (v) => !v.id, hint: 'Leave empty to generate a temporary password' },
    { key: 'sendWelcome', label: 'Welcome email', type: 'boolean', visible: (v) => !v.id, placeholder: 'Send sign-in details by email' },
    { key: 'roles', label: 'Roles', type: 'custom', section: 'Access', render: ({ value, onChange, values }) => <RoleAssignmentsEditor value={(value as RoleAssignment[]) ?? []} onChange={onChange} userType={(values.userType as 'msp' | 'customer') ?? 'msp'} /> },
    { key: 'teamIds', label: 'Teams', type: 'multiselect', visible: (v) => v.userType === 'msp', options: (lookups.lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name })) },
    { key: 'customerAccess', label: 'Explicit customer access', type: 'multiselect', visible: (v) => v.userType === 'msp', options: (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.code })), hint: 'Only needed for staff without MSP-wide visibility' },
  ];

  const initial: Values = u
    ? { id: u.id, name: u.name, email: u.email, userType: u.userType, customerId: u.customerId, title: u.title ?? '', phone: u.phone ?? '', timezone: u.timezone, roles: u.roles.map((r) => ({ roleId: r.roleId, customerId: r.customerId })), teamIds: u.teams.map((t) => t.id), customerAccess: u.customerAccess.map((c) => c.customerId) }
    : { name: '', email: '', userType: 'msp', customerId: null, title: '', phone: '', timezone: 'Asia/Kolkata', password: '', roles: [], teamIds: [], customerAccess: [], sendWelcome: true };

  async function submit(v: Values) {
    const assignments = ((v.roles as RoleAssignment[]) ?? []).filter((a) => a.roleId).map((a) => ({ roleId: a.roleId, customerId: a.customerId }));
    const isMsp = v.userType === 'msp';
    if (u) {
      await patch(`/iam/users/${u.id}`, { name: v.name, phone: v.phone || null, title: v.title || null, timezone: v.timezone || undefined, ...(!isMsp && v.customerId && v.customerId !== u.customerId ? { customerId: v.customerId } : {}) });
      await put(`/iam/users/${u.id}/roles`, { assignments });
      if (isMsp) {
        await put(`/iam/users/${u.id}/teams`, { teamIds: (v.teamIds as string[]) ?? [] });
        await put(`/iam/users/${u.id}/customers`, { customerIds: (v.customerAccess as string[]) ?? [] });
      }
      invalidateUsers();
      toast.success('User updated');
      return;
    }
    const res = await post<{ user: UserDetail; temporaryPassword?: string }>('/iam/users', {
      name: v.name, email: v.email, userType: v.userType, customerId: isMsp ? null : v.customerId, title: v.title || undefined, phone: v.phone || undefined, timezone: v.timezone || undefined, password: v.password || undefined,
      roleIds: assignments, teamIds: isMsp ? (v.teamIds as string[]) ?? [] : [], customerAccess: isMsp ? (v.customerAccess as string[]) ?? [] : [], sendWelcome: !!v.sendWelcome,
    });
    invalidateUsers();
    toast.success('User created');
    if (res.temporaryPassword) setTempPassword(res.temporaryPassword);
  }

  async function resetPassword() {
    if (!u) return;
    setBusy(true);
    try {
      const res = await post<{ temporaryPassword?: string }>(`/iam/users/${u.id}/reset-password`, {});
      invalidateUsers();
      setConfirmReset(false);
      if (res.temporaryPassword) setTempPassword(res.temporaryPassword);
      else toast.success('Password reset');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeNumber() {
    if (!u) return;
    setBusy(true);
    try {
      await whatsappApi.revokeUser(u.id);
      invalidateUsers();
      setConfirmRevoke(false);
      toast.success('Number revoked');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: 'active' | 'disabled') {
    if (!u) return;
    setBusy(true);
    try {
      await patch(`/iam/users/${u.id}`, { status });
      invalidateUsers();
      setConfirmDisable(false);
      toast.success(status === 'disabled' ? 'Account disabled' : 'Account enabled');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
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
      <FormDialog<Values>
        open={createOpen || !!u}
        onClose={close}
        title={u ? u.name : 'New user'}
        description={
          u ? (
            <div className="flex flex-wrap items-center gap-2">
              <Avatar name={u.name} size="md" />
              <span>{u.email}</span>
              {u.userType === 'customer' ? <Badge color="teal">Customer · {u.customerName}</Badge> : <Badge color="blue">MSP staff</Badge>}
              <Badge color={STATUS_COLOR[u.status] ?? 'slate'} dot>{titleCase(u.status)}</Badge>
              {u.phone && (
                <Badge color={u.whatsappVerifiedAt ? 'green' : u.whatsappOptIn ? 'amber' : 'gray'} title={u.whatsappVerifiedAt ? `Number verified on ${fmtDateTime(u.whatsappVerifiedAt)}` : 'The person has not verified this number with a code over WhatsApp'}>
                  {u.whatsappVerifiedAt ? 'WhatsApp verified' : u.whatsappOptIn ? 'WhatsApp on · not verified' : 'WhatsApp off'}
                </Badge>
              )}
              <span className="text-[12px] text-subtle">Created {fmtDateTime(u.createdAt)} · last sign-in {u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'never'}</span>
            </div>
          ) : undefined
        }
        fields={fields}
        initial={initial}
        onSubmit={submit}
        variant="drawer"
        width="max-w-2xl"
        submitLabel={u ? 'Save' : 'Create user'}
        extraActions={
          u ? (
            <>
              <Button variant="outline" size="sm" type="button" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setConfirmReset(true)}>Reset password</Button>
              {u.status === 'disabled' ? (
                <Button variant="outline" size="sm" type="button" icon={<UserCheck className="h-3.5 w-3.5" />} loading={busy} onClick={() => void setStatus('active')}>Enable</Button>
              ) : (
                <Button variant="outline" size="sm" type="button" icon={<UserX className="h-3.5 w-3.5" />} disabled={me?.id === u.id} onClick={() => setConfirmDisable(true)}>Disable</Button>
              )}
            </>
          ) : undefined
        }
      />
      <ConfirmDialog open={confirmReset} onClose={() => setConfirmReset(false)} onConfirm={() => void resetPassword()} loading={busy} title="Generate a new temporary password?" description="Existing sessions are signed out. The new password is shown once." confirmLabel="Reset password" />
      <ConfirmDialog open={confirmDisable} onClose={() => setConfirmDisable(false)} onConfirm={() => void setStatus('disabled')} loading={busy} danger title="Disable this account?" description="The user is signed out immediately and can no longer sign in until re-enabled." confirmLabel="Disable account" />
      <ConfirmDialog open={confirmRevoke} onClose={() => setConfirmRevoke(false)} onConfirm={() => void revokeNumber()} loading={busy} danger title="Revoke this number?" description="Chat with Grady on WhatsApp goes off and the verification is cleared, so the person has to prove the number again before chatting. WhatsApp notifications and the number itself are not changed." confirmLabel="Revoke number" />
      <TempPasswordDialog password={tempPassword} onClose={() => setTempPassword(null)} />
    </div>
  );
}

/** Read-only line in the user drawer: whether the number is linked for chatting with Grady, with Revoke for administrators. */
function WhatsAppChatLine({ user, onRevoke }: { user: UserDetail; onRevoke: () => void }) {
  const state = user.whatsappVerifiedAt ? (user.assistantOn ? 'linked' : 'verified') : 'none';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-default bg-surface-2/40 px-3 py-2" data-testid="user-whatsapp-chat">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <Badge color={WHATSAPP_LINK_COLORS[state]} dot>{state === 'linked' ? 'Linked for chat' : state === 'verified' ? 'Verified · chat off' : 'Not verified'}</Badge>
        <span className="text-muted">{user.whatsappVerifiedAt ? `since ${fmtDateTime(user.whatsappVerifiedAt)}` : user.phone ? 'The person verifies the number with a code on their profile.' : 'No mobile number.'}</span>
      </div>
      {user.whatsappVerifiedAt && (
        <Button type="button" size="sm" variant="ghost" icon={<Unlink className="h-3.5 w-3.5" />} onClick={onRevoke} data-testid="revoke-number">
          Revoke number
        </Button>
      )}
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
