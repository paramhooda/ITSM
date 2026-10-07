import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, Pencil } from 'lucide-react';
import { post, patch, del } from '@/api/client';
import { Button, Badge, Drawer, Field, Input, Select, Textarea, type Column } from '@/components/ui';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MonoCell, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { PermissionMatrix } from '@/components/admin/PermissionMatrix';
import { useRoles, type RoleRow } from '@/components/admin/RoleAssignmentsEditor';
import { useAdminMutation, slugify } from '@/components/admin/api';
import { CheckboxGroup, KeyInput } from '@/components/admin/inputs';
import { NAV_AREAS, ALL_NAV_AREAS } from '@itsm/shared';

type Values = Record<string, unknown>;

export default function RolesPage() {
  const q = useRoles();
  /** `null` = drawer closed, `'new'` = create, otherwise the role being edited. */
  const [selected, setSelected] = useState<RoleRow | 'new' | null>(null);
  const invalidate = [['iam', 'roles']];
  const remove = useAdminMutation((id: string) => del(`/iam/roles/${id}`), { invalidate, success: 'Role deleted' });
  const all = useMemo(() => q.data ?? [], [q.data]);
  const f = useConfigFilter(all, {
    search: [(r) => r.name, (r) => r.key, (r) => r.description],
    selects: [
      { key: 'userType', label: 'Applies to', options: [{ value: 'msp', label: 'MSP staff' }, { value: 'customer', label: 'Customer portal users' }], predicate: (r, v) => r.userType === v },
      { key: 'kind', label: 'Kind', options: [{ value: 'system', label: 'System roles' }, { value: 'custom', label: 'Custom roles' }], predicate: (r, v) => (v === 'system' ? r.isSystem : !r.isSystem) },
    ],
    noun: ['role', 'roles'],
    searchPlaceholder: 'Search roles',
  });

  const columns: Column<RoleRow>[] = [
    { key: 'name', header: 'Role', render: (r) => (
      <div>
        <div className="inline-flex items-center gap-2 font-medium">{r.name}{r.isSystem && <Badge color="slate">system</Badge>}</div>
        {r.description && <div className="text-[12px] text-muted">{r.description}</div>}
      </div>
    ) },
    { key: 'key', header: 'Key', render: (r) => <MonoCell>{r.key}</MonoCell> },
    { key: 'userType', header: 'Type', render: (r) => (r.userType === 'customer' ? <Badge color="teal">Customer</Badge> : <Badge color="blue">MSP</Badge>) },
    { key: 'permissions', header: 'Permissions', render: (r) => <MutedCell>{r.permissions.length}</MutedCell> },
    { key: 'userCount', header: 'Users', render: (r) => <MutedCell>{r.userCount}</MutedCell> },
  ];

  const current = selected && selected !== 'new' ? q.data?.find((r) => r.id === selected.id) ?? selected : null;

  return (
    <div>
      <SectionHeader title="Roles" description="Bundles of permissions. System roles can be tuned (except Administrator); custom roles can be added for specific needs." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setSelected('new')}>New role</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<RoleRow>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={setSelected}
        emptyTitle={f.filtered ? 'No roles match' : 'No roles yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : undefined}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: setSelected },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, hidden: (r) => r.isSystem, confirm: (r) => ({ title: `Delete role "${r.name}"?`, description: `${r.userCount} user(s) lose it.`, confirmLabel: 'Delete role' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      {selected && <RoleDrawer role={current} onClose={() => setSelected(null)} onCreated={(r) => setSelected(r)} />}
    </div>
  );
}

/** Same editor for create (`role === null`) and edit: identity, navigation areas and the permission matrix. */
function RoleDrawer({ role, onClose, onCreated }: { role: RoleRow | null; onClose: () => void; onCreated: (r: RoleRow) => void }) {
  const isNew = !role;
  const [name, setName] = useState(role?.name ?? '');
  const [key, setKey] = useState(role?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(!isNew);
  const [userType, setUserType] = useState<'msp' | 'customer'>(role?.userType ?? 'msp');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [areas, setAreas] = useState<string[] | null>(role?.navAreas ?? null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!role) return;
    setName(role.name);
    setKey(role.key);
    setUserType(role.userType);
    setDescription(role.description ?? '');
    setPerms(role.permissions);
    setAreas(role.navAreas ?? null);
    setDirty(false);
  }, [role?.id, role?.name, role?.description, role?.permissions, role?.navAreas]); // eslint-disable-line react-hooks/exhaustive-deps
  const locked = role?.key === 'admin';
  const save = useAdminMutation((body: Values) => patch(`/iam/roles/${role!.id}`, body), { invalidate: [['iam', 'roles']], success: 'Role saved', onSuccess: () => setDirty(false) });
  const create = useAdminMutation((body: Values) => post<RoleRow>('/iam/roles', body), {
    invalidate: [['iam', 'roles']],
    success: 'Role created',
    onSuccess: (r) => onCreated({ ...r, userCount: 0, permissions: (r.permissions as string[]) ?? [], navAreas: (r.navAreas as string[] | null) ?? null }),
  });
  const submit = () => {
    if (isNew) create.mutate({ name: name.trim(), key: key.trim(), userType, description: description.trim() || undefined, permissions: perms, navAreas: userType === 'msp' ? areas : null });
    else save.mutate({ name, description, navAreas: areas, ...(locked ? {} : { permissions: perms }) });
  };
  const canSubmit = isNew ? !!name.trim() && /^[a-z0-9_]+$/.test(key) : dirty;
  return (
    <Drawer
      open
      onClose={onClose}
      title={isNew ? 'New role' : role.name}
      width="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-[12px] text-subtle">{perms.length} permission(s){role ? ` · ${role.userCount} user(s)` : ''}</span>
          <Button variant="ghost" onClick={onClose}>{isNew ? 'Cancel' : 'Close'}</Button>
          <Button icon={<Save className="h-4 w-4" />} disabled={!canSubmit} loading={save.isPending || create.isPending} onClick={submit}>
            {isNew ? 'Create role' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name" required><Input value={name} autoFocus={isNew} onChange={(e) => { setName(e.target.value); if (isNew && !keyTouched) setKey(slugify(e.target.value)); setDirty(true); }} /></Field>
          <Field label="Key" required={isNew} hint={isNew ? 'Lowercase letters, digits and underscores' : undefined}>
            {isNew ? <KeyInput value={key} onChange={(e) => { setKey(e.target.value); setKeyTouched(true); }} /> : <Input value={key} disabled className="font-mono text-[12.5px]" />}
          </Field>
          <Field label="Applies to" required={isNew}>
            <Select value={userType} disabled={!isNew} options={[{ value: 'msp', label: 'MSP staff' }, { value: 'customer', label: 'Customer portal users' }]} onChange={(e) => { setUserType(e.target.value as 'msp' | 'customer'); setPerms([]); setAreas(null); }} />
          </Field>
          <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} /></Field>
        </div>
        {userType === 'msp' && (
          <div className="rounded-lg border border-default p-3">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <div className="text-[13px] font-medium">Navigation areas</div>
                <div className="text-[12px] text-muted">What holders of this role see in the sidebar. Permissions still guard every page; this keeps the workspace focused on their area.</div>
              </div>
              <label className="inline-flex items-center gap-2 text-[12.5px] cursor-pointer select-none shrink-0"><input type="checkbox" className="h-4 w-4 rounded accent-brand-600" checked={areas === null} onChange={(e) => { setAreas(e.target.checked ? null : [...ALL_NAV_AREAS]); setDirty(true); }} /> Everything permissions allow</label>
            </div>
            {areas !== null && <CheckboxGroup columns={3} value={areas} onChange={(v) => { setAreas(v); setDirty(true); }} options={ALL_NAV_AREAS.map((a) => ({ value: a, label: NAV_AREAS[a] }))} />}
          </div>
        )}
        {locked && <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">The Administrator role always holds every permission; its permissions cannot be changed.</div>}
        <PermissionMatrix value={perms} onChange={(v) => { setPerms(v); setDirty(true); }} readOnly={locked} userType={userType} />
      </div>
    </Drawer>
  );
}
