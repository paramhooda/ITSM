import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { UserPlus, KeyRound, Pencil, UserX, UserCheck, Copy, Users, Unlink } from 'lucide-react';
import { PageHeader, Button, DataTable, Pagination, Badge, Dialog, Drawer, ConfirmDialog, Field, Input, Select, EmptyState, ErrorBlock, ListShell, FilterGroup, FilterOptions, type Column, type AppliedFilter, Checkbox } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { useListState } from '@/hooks/useListState';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { portalApi, pk, ROLE_LABELS, type PortalUser, type PortalRole } from '@/components/portal/api';
import { whatsappApi } from '@/components/whatsapp/api';

const ROLE_OPTIONS = [
  { value: 'customer_user', label: 'User — raises and tracks tickets' },
  { value: 'customer_admin', label: 'Administrator — also approves requests, sees assets and reports, manages users' },
];
const PAGE = 50;

function TempPasswordDialog({ open, onClose, email, password }: { open: boolean; onClose: () => void; email: string; password: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy');
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Temporary password" width="max-w-md" footer={<Button onClick={onClose}>Done</Button>}>
      <div className="text-[13px] text-muted">
        Share this with <span className="text-default font-medium">{email}</span> through a secure channel. It is shown only once; they will be asked to change it after signing in.
      </div>
      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 rounded-md bg-surface-2 border border-default px-3 py-2 font-mono text-[14px] tracking-wide select-all">{password}</code>
        <Button variant="outline" size="icon" onClick={copy} aria-label="Copy password">
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </Dialog>
  );
}

export default function PortalUsersPage() {
  const qc = useQueryClient();
  const { state, set, page, setPage } = useListState();
  const params = useMemo(() => ({ q: state.q || undefined, status: state.status || undefined, page, pageSize: PAGE }), [state.q, state.status, page]);
  const list = useQuery({ queryKey: pk.users(params), queryFn: () => portalApi.users(params), placeholderData: (p) => p });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['portal', 'users'] });

  const [invite, setInvite] = useState(false);
  const [inv, setInv] = useState({ name: '', email: '', phone: '', title: '', role: 'customer_user' as PortalRole });
  const [edit, setEdit] = useState<PortalUser | null>(null);
  const [ed, setEd] = useState({ name: '', phone: '', title: '', role: 'customer_user' as PortalRole, whatsappOptIn: false });
  const [resetTarget, setResetTarget] = useState<PortalUser | null>(null);
  const [toggleTarget, setToggleTarget] = useState<PortalUser | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PortalUser | null>(null);
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    if (edit) setEd({ name: edit.name, phone: edit.phone ?? '', title: edit.title ?? '', role: edit.role ?? 'customer_user', whatsappOptIn: edit.whatsappOptIn ?? false });
  }, [edit]);

  const create = useMutation({
    mutationFn: () => portalApi.createUser({ name: inv.name.trim(), email: inv.email.trim(), phone: inv.phone.trim() || null, title: inv.title.trim() || null, role: inv.role }),
    onSuccess: (res) => {
      toast.success(`${res.user.name} invited`, { description: 'A welcome e-mail with sign-in details has been sent.' });
      setInvite(false);
      setInv({ name: '', email: '', phone: '', title: '', role: 'customer_user' });
      if (res.temporaryPassword) setTemp({ email: res.user.email, password: res.temporaryPassword });
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: () => portalApi.updateUser(edit!.id, { name: ed.name.trim(), phone: ed.phone.trim() || null, title: ed.title.trim() || null, whatsappOptIn: ed.whatsappOptIn && !!ed.phone.trim(), ...(edit!.isSelf || ed.role === edit!.role ? {} : { role: ed.role }) }),
    onSuccess: () => {
      toast.success('User updated');
      setEdit(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reset = useMutation({
    mutationFn: (u: PortalUser) => portalApi.resetPassword(u.id),
    onSuccess: (res, u) => {
      setResetTarget(null);
      if (res.temporaryPassword) setTemp({ email: u.email, password: res.temporaryPassword });
      else toast.success('Password reset');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: (u: PortalUser) => portalApi.updateUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' }),
    onSuccess: (u) => {
      toast.success(u.status === 'active' ? `${u.name} re-enabled` : `${u.name} disabled`);
      setToggleTarget(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: (u: PortalUser) => whatsappApi.revokePortalUser(u.id),
    onSuccess: (_r, u) => {
      setRevokeTarget(null);
      setEdit((prev) => (prev && prev.id === u.id ? { ...prev, whatsappVerifiedAt: null, assistantOn: false } : prev));
      invalidate();
      toast.success(`${u.name}'s number revoked`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const columns: Column<PortalUser>[] = [
    { key: 'name', header: 'Name', render: (u) => <div><div className="font-medium">{u.name}{u.isSelf && <span className="text-subtle font-normal"> (you)</span>}</div>{u.title && <div className="text-[11.5px] text-muted">{u.title}</div>}</div> },
    { key: 'email', header: 'E-mail', render: (u) => <span className="text-[12.5px]">{u.email}</span> },
    { key: 'role', header: 'Role', render: (u) => <Badge color={u.role === 'customer_admin' ? 'purple' : 'blue'}>{u.role ? ROLE_LABELS[u.role] : u.roleName ?? '—'}</Badge> },
    { key: 'status', header: 'Status', render: (u) => (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Badge color={u.status === 'active' ? 'green' : 'gray'} dot>{u.status === 'active' ? 'Active' : 'Disabled'}</Badge>
        {u.assistantOn && u.whatsappVerifiedAt && <Badge color="green" title="Chats with Grady on WhatsApp from a verified number" data-testid="portal-chat-badge">Chat</Badge>}
      </span>
    ) },
    { key: 'lastLogin', header: 'Last sign-in', render: (u) => <span className="text-[12.5px] text-muted" title={fmtDateTime(u.lastLoginAt)}>{u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'Never'}</span> },
    { key: 'actions', header: '', className: 'text-right', render: (u) => (
      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEdit(u)} title="Edit">
          Edit
        </Button>
        <Button size="sm" variant="ghost" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setResetTarget(u)} title="Reset password">
          Reset
        </Button>
        {!u.isSelf && (
          <Button size="sm" variant="ghost" icon={u.status === 'active' ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />} onClick={() => setToggleTarget(u)} title={u.status === 'active' ? 'Disable' : 'Enable'}>
            {u.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
        )}
      </div>
    ) },
  ];

  const inviteValid = inv.name.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inv.email.trim());
  const activeCount = ['q', 'status'].filter((k) => state[k]).length;
  const applied: AppliedFilter[] = [];
  if (state.q) applied.push({ key: 'q', label: `Search: “${state.q}”`, onRemove: () => set({ q: undefined }) });
  if (state.status) applied.push({ key: 'status', label: state.status === 'active' ? 'Active users' : 'Disabled users', onRemove: () => set({ status: undefined }) });

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Users"
        subtitle="People from your organisation who can sign in to this portal."
        actions={
          <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setInvite(true)}>
            Invite user
          </Button>
        }
      />
      <ListShell
        id="portal-users"
        search={{ value: state.q ?? '', onChange: (q) => set({ q }), placeholder: 'Search name or e-mail…' }}
        activeCount={activeCount}
        onClear={() => set({ q: undefined, status: undefined })}
        applied={applied}
        count={list.data ? `${fmtNumber(list.data.total)} ${list.data.total === 1 ? 'user' : 'users'}` : undefined}
        filters={
          <FilterGroup label="Status">
            <FilterOptions options={[{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }]} value={state.status} onChange={(v) => set({ status: v as string | undefined })} />
          </FilterGroup>
        }
      >
        <div className="card">
          {list.isError ? (
            <ErrorBlock error={list.error} retry={() => list.refetch()} />
          ) : (
            <>
              <DataTable columns={columns} rows={list.data?.items ?? []} loading={list.isLoading} empty={<EmptyState icon={<Users className="h-5 w-5" />} title="No users found" description={activeCount ? 'Adjust or clear the filters.' : undefined} />} onRowClick={(u) => setEdit(u)} />
              <Pagination page={page} pageSize={PAGE} total={list.data?.total ?? 0} onPage={setPage} />
            </>
          )}
        </div>
      </ListShell>

      <Dialog
        open={invite}
        onClose={() => setInvite(false)}
        title="Invite a user"
        footer={
          <>
            <Button variant="ghost" onClick={() => setInvite(false)}>
              Cancel
            </Button>
            <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!inviteValid}>
              Send invitation
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Full name" required>
              <Input autoFocus value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} />
            </Field>
            <Field label="Work e-mail" required>
              <Input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={inv.phone} onChange={(e) => setInv({ ...inv, phone: e.target.value })} />
            </Field>
            <Field label="Job title">
              <Input value={inv.title} onChange={(e) => setInv({ ...inv, title: e.target.value })} />
            </Field>
          </div>
          <Field label="Role" hint="Administrators can approve requests on behalf of your organisation and manage these users.">
            <Select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value as PortalRole })} options={ROLE_OPTIONS} />
          </Field>
        </div>
      </Dialog>

      <Drawer
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit ? `Edit ${edit.name}` : ''}
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button onClick={() => update.mutate()} loading={update.isPending} disabled={!ed.name.trim()}>
              Save changes
            </Button>
          </>
        }
      >
        {edit && (
          <div className="flex flex-col gap-3">
            <Field label="E-mail">
              <Input value={edit.email} disabled />
            </Field>
            <Field label="Full name" required>
              <Input value={ed.name} onChange={(e) => setEd({ ...ed, name: e.target.value })} />
            </Field>
            <Field label="Mobile" hint={ed.whatsappOptIn && !ed.phone.trim() ? 'Needed for WhatsApp notifications' : undefined}>
              <Input value={ed.phone} onChange={(e) => setEd({ ...ed, phone: e.target.value })} placeholder="+91 …" />
            </Field>
            <div className="sm:col-span-2 flex flex-col gap-1">
              <Checkbox label="WhatsApp notifications to this number" checked={ed.whatsappOptIn} onChange={(e) => setEd({ ...ed, whatsappOptIn: e.target.checked })} />
              {edit.phone && (
                <span className="text-[12px] text-subtle" data-testid="portal-user-verified">
                  {edit.whatsappVerifiedAt ? `Number verified by ${edit.name.split(' ')[0]} on ${fmtDateTime(edit.whatsappVerifiedAt)}.` : 'Number not verified yet; the person verifies it with a code on their profile.'} Changing the number clears the verification; which categories reach them is their own choice under Profile & notifications.
                </span>
              )}
              {edit.whatsappVerifiedAt && (
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-default bg-surface-2/40 px-3 py-2" data-testid="portal-user-chat">
                  <span className="inline-flex flex-wrap items-center gap-2 text-[12.5px]">
                    <Badge color={edit.assistantOn ? 'green' : 'blue'} dot>{edit.assistantOn ? 'Chat with Grady on' : 'Chat with Grady off'}</Badge>
                    <span className="text-muted">{edit.assistantOn ? 'Messages from this number are answered by the assistant.' : 'The person can switch it on from their profile.'}</span>
                  </span>
                  <Button type="button" size="sm" variant="ghost" icon={<Unlink className="h-3.5 w-3.5" />} onClick={() => setRevokeTarget(edit)} data-testid="portal-revoke-number">
                    Revoke number
                  </Button>
                </div>
              )}
            </div>
            <Field label="Job title">
              <Input value={ed.title} onChange={(e) => setEd({ ...ed, title: e.target.value })} />
            </Field>
            <Field label="Role" hint={edit.isSelf ? 'You cannot change your own role.' : undefined}>
              <Select value={ed.role} onChange={(e) => setEd({ ...ed, role: e.target.value as PortalRole })} options={ROLE_OPTIONS} disabled={edit.isSelf} />
            </Field>
            <div className="text-[12px] text-muted">
              Status: <Badge color={edit.status === 'active' ? 'green' : 'gray'}>{edit.status === 'active' ? 'Active' : 'Disabled'}</Badge>
              {edit.lastLoginAt ? ` · last signed in ${relativeTime(edit.lastLoginAt)}` : ' · never signed in'}
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDialog open={!!resetTarget} onClose={() => setResetTarget(null)} onConfirm={() => resetTarget && reset.mutate(resetTarget)} loading={reset.isPending} title="Reset password?" confirmLabel="Reset password" description={resetTarget ? `${resetTarget.name} will be signed out everywhere and get a temporary password that you can pass on.` : ''} />
      <ConfirmDialog
        open={!!toggleTarget}
        onClose={() => setToggleTarget(null)}
        onConfirm={() => toggleTarget && toggle.mutate(toggleTarget)}
        loading={toggle.isPending}
        danger={toggleTarget?.status === 'active'}
        title={toggleTarget?.status === 'active' ? 'Disable user?' : 'Re-enable user?'}
        confirmLabel={toggleTarget?.status === 'active' ? 'Disable' : 'Enable'}
        description={toggleTarget ? (toggleTarget.status === 'active' ? `${toggleTarget.name} will no longer be able to sign in. Their tickets stay in place.` : `${toggleTarget.name} will be able to sign in again.`) : ''}
      />
      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget)}
        loading={revoke.isPending}
        danger
        title="Revoke this number?"
        confirmLabel="Revoke number"
        description={revokeTarget ? `${revokeTarget.name} will no longer chat with Grady on WhatsApp until they verify the number again on their profile. Notifications and the number itself are not changed.` : ''}
      />
      <TempPasswordDialog open={!!temp} onClose={() => setTemp(null)} email={temp?.email ?? ''} password={temp?.password ?? ''} />
    </div>
  );
}
