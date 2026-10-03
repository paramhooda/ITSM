import { useMemo } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { NOTIFICATION_EVENTS } from '@itsm/shared';
import { Button, Badge, type Column } from '@/components/ui';
import { useEngineers } from '@/hooks/useLookups';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell, MonoCell } from '@/components/admin/ConfigTable';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { CheckboxGroup } from '@/components/admin/inputs';
import { useRoles } from '@/components/admin/RoleAssignmentsEditor';
import { useConfigKind, useConfigMutations } from '@/components/admin/api';

interface Rule {
  id: string;
  event: string;
  name: string;
  recipients: Record<string, unknown> & { roles?: string[]; users?: string[]; emails?: string[] };
  channels: string[];
  conditions: Record<string, unknown>;
  isActive: boolean;
}

const RECIPIENT_FLAGS = [
  { value: 'requester', label: 'Requester' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'team', label: 'Assigned team' },
  { value: 'watchers', label: 'Watchers' },
  { value: 'manager', label: 'Team manager' },
  { value: 'customerContacts', label: 'Customer contacts' },
  { value: 'accountManager', label: 'Account manager' },
  { value: 'approvers', label: 'Approvers' },
  { value: 'scheduleRecipients', label: 'Schedule recipients' },
];
const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'in_app', label: 'In-app' },
  { value: 'whatsapp', label: 'WhatsApp' },
];

type Values = Record<string, unknown>;

export default function NotificationRulesPage() {
  const q = useConfigKind<Rule>('notification-rules');
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.event.localeCompare(b.event)), [q.data]);
  const { create, update, remove } = useConfigMutations('notification-rules', { label: 'Notification rule' });
  const editor = useEditor<Rule>();
  const roles = useRoles();
  const engineers = useEngineers();

  const fields: FieldSpec<Values>[] = [
    { key: 'event', label: 'Event', type: 'select', required: true, options: NOTIFICATION_EVENTS.map((e) => ({ value: e, label: e })) },
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'flags', label: 'Recipients', type: 'custom', section: 'Who is notified', render: ({ value, onChange }) => <CheckboxGroup value={(value as string[]) ?? []} onChange={onChange} options={RECIPIENT_FLAGS} columns={3} /> },
    { key: 'roles', label: 'Roles', type: 'multiselect', options: (roles.data ?? []).map((r) => ({ value: r.key, label: r.name, hint: r.userType })) },
    { key: 'users', label: 'Specific users', type: 'multiselect', options: (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name, hint: e.email })) },
    { key: 'emails', label: 'Additional emails', type: 'lines', rows: 2, placeholder: 'one address per line' },
    { key: 'channels', label: 'Channels', type: 'custom', section: 'Delivery', render: ({ value, onChange }) => <CheckboxGroup value={(value as string[]) ?? []} onChange={onChange} options={CHANNELS} columns={2} /> },
    { key: 'isActive', label: 'Active', type: 'boolean' },
  ];

  const initial: Values = editor.row
    ? { ...editor.row, flags: RECIPIENT_FLAGS.map((f) => f.value).filter((f) => editor.row!.recipients[f]), roles: editor.row.recipients.roles ?? [], users: editor.row.recipients.users ?? [], emails: editor.row.recipients.emails ?? [], channels: editor.row.channels }
    : { event: 'ticket.created', name: '', flags: ['requester'], roles: [], users: [], emails: [], channels: ['email', 'in_app'], isActive: true };

  async function submit(v: Values) {
    const recipients: Record<string, unknown> = {};
    for (const f of (v.flags as string[]) ?? []) recipients[f] = true;
    if ((v.roles as string[])?.length) recipients.roles = v.roles;
    if ((v.users as string[])?.length) recipients.users = v.users;
    if ((v.emails as string[])?.length) recipients.emails = v.emails;
    const body = { event: v.event, name: v.name, recipients, channels: (v.channels as string[]) ?? [], isActive: !!v.isActive };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync(body);
  }

  const describe = (r: Rule) => {
    const parts = RECIPIENT_FLAGS.filter((f) => r.recipients[f.value]).map((f) => f.label.toLowerCase());
    if (r.recipients.roles?.length) parts.push(`roles: ${r.recipients.roles.join(', ')}`);
    if (r.recipients.users?.length) parts.push(`${r.recipients.users.length} user(s)`);
    if (r.recipients.emails?.length) parts.push(`${r.recipients.emails.length} email(s)`);
    return parts.join(', ') || 'nobody';
  };

  const columns: Column<Rule>[] = [
    { key: 'event', header: 'Event', render: (r) => <MonoCell>{r.event}</MonoCell> },
    { key: 'name', header: 'Rule', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'recipients', header: 'Recipients', render: (r) => <MutedCell>{describe(r)}</MutedCell> },
    { key: 'channels', header: 'Channels', render: (r) => <span className="inline-flex gap-1">{r.channels.map((c) => <Badge key={c} color={c === 'email' ? 'blue' : c === 'whatsapp' ? 'green' : 'violet'}>{c === 'in_app' ? 'in-app' : c}</Badge>)}</span> },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  return (
    <div>
      <SectionHeader title="Notification rules" description="Who receives a notification for each event and through which channels. Several rules per event are allowed." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New rule</Button>} />
      <ConfigTable<Rule>
        columns={columns}
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete rule "${r.name}"?`, description: 'Notifications already queued are still sent.', confirmLabel: 'Delete rule' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit notification rule' : 'New notification rule'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}
