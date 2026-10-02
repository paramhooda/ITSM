import { useEffect, useState } from 'react';
import { Plus, Trash2, Save, Pencil } from 'lucide-react';
import { post, patch, del } from '@/api/client';
import { Button, Badge, Drawer, Field, Input, Textarea, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MonoCell, MutedCell } from '@/components/admin/ConfigTable';
import { FormDialog, type FieldSpec } from '@/components/admin/FormDialog';
import { PermissionMatrix } from '@/components/admin/PermissionMatrix';
import { useRoles, type RoleRow } from '@/components/admin/RoleAssignmentsEditor';
import { useAdminMutation } from '@/components/admin/api';
import { CheckboxGroup } from '@/components/admin/inputs';
import { NAV_AREAS, ALL_NAV_AREAS } from '@itsm/shared';

type Values = Record<string, unknown>;

export default function RolesPage() {
  const q = useRoles();
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<RoleRow | null>(null);
  const invalidate = [['iam', 'roles']];
  const create = useAdminMutation((body: Values) => post<RoleRow>('/iam/roles', body), { invalidate, success: 'Role created', onSuccess: (r) => setSelected({ ...r, userCount: 0, permissions: (r.permissions as string[]) ?? [] }) });
  const remove = useAdminMutation((id: string) => del(`/iam/roles/${id}`), { invalidate, success: 'Role deleted' });

  const createFields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'key', label: 'Key', type: 'key', required: true },
    { key: 'userType', label: 'Applies to', type: 'select', required: true, options: [{ value: 'msp', label: 'MSP staff' }, { value: 'customer', label: 'Customer portal users' }] },
    { key: 'description', label: 'Description', type: 'text' },
  ];

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

  return (
    <div>
      <SectionHeader title="Roles" description="Bundles of permissions. System roles can be tuned (except Administrator); custom roles can be added for specific needs." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New role</Button>} />
      <ConfigTable<RoleRow>
        columns={columns}
        rows={q.data ?? []}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={setSelected}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: setSelected },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, hidden: (r) => r.isSystem, onClick: (r) => { if (confirm(`Delete role "${r.name}"? ${r.userCount} user(s) lose it.`)) remove.mutate(r.id); } },
        ]}
      />
      <FormDialog<Values> open={createOpen} onClose={() => setCreateOpen(false)} title="New role" fields={createFields} initial={{ name: '', key: '', userType: 'msp', description: '' }} onSubmit={(v) => create.mutateAsync({ ...v, description: v.description || undefined, permissions: [] })} submitLabel="Create and edit permissions" />
      {selected && <RoleDrawer role={q.data?.find((r) => r.id === selected.id) ?? selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function RoleDrawer({ role, onClose }: { role: RoleRow; onClose: () => void }) {
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? '');
  const [perms, setPerms] = useState<string[]>(role.permissions);
  const [areas, setAreas] = useState<string[] | null>(role.navAreas ?? null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setName(role.name);
    setDescription(role.description ?? '');
    setPerms(role.permissions);
    setAreas(role.navAreas ?? null);
    setDirty(false);
  }, [role.id, role.name, role.description, role.permissions, role.navAreas]);
  const locked = role.key === 'admin';
  const save = useAdminMutation((body: Values) => patch(`/iam/roles/${role.id}`, body), { invalidate: [['iam', 'roles']], success: 'Role saved', onSuccess: () => setDirty(false) });
  return (
    <Drawer
      open
      onClose={onClose}
      title={role.name}
      width="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-[12px] text-subtle">{perms.length} permission(s) · {role.userCount} user(s)</span>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button icon={<Save className="h-4 w-4" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate({ name, description, navAreas: areas, ...(locked ? {} : { permissions: perms }) })}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name"><Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} /></Field>
          <Field label="Key"><Input value={role.key} disabled className="font-mono text-[12.5px]" /></Field>
          <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} /></Field>
        </div>
        {role.userType === 'msp' && (
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
        <PermissionMatrix value={perms} onChange={(v) => { setPerms(v); setDirty(true); }} readOnly={locked} userType={role.userType} />
      </div>
    </Drawer>
  );
}
