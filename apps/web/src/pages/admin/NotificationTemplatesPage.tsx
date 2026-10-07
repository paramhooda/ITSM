import { useMemo } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { NOTIFICATION_EVENTS } from '@itsm/shared';
import { Button, Badge, type Column } from '@/components/ui';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell, MonoCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { eventGroup, eventGroupOptions, channelLabel } from '@/components/admin/notificationEvents';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useConfigKind, useConfigMutations } from '@/components/admin/api';

interface Template {
  id: string;
  event: string;
  channel: string;
  name: string;
  subject: string | null;
  body: string;
  isActive: boolean;
  isSystem: boolean;
}

type Values = Record<string, unknown>;

const COMMON_VARS = ['platformName', 'appUrl', 'actor'];
const EVENT_VARS: Record<string, string[]> = {
  ticket: ['ticket.number', 'ticket.title', 'ticket.typeLabel', 'ticket.status', 'ticket.priority', 'ticket.customerName', 'ticket.service', 'ticket.assignee', 'ticket.link', 'ticket.description'],
  'ticket.status_changed': ['previousStatus'],
  'ticket.customer_comment': ['comment'],
  'ticket.engineer_comment': ['comment'],
  'ticket.resolved': ['ticket.resolutionNotes', 'reopenDays'],
  'ticket.escalated': ['level', 'reason'],
  sla: ['sla.metric', 'sla.pct', 'sla.dueAt'],
  change: ['comment'],
  request: ['comment'],
  contract: ['contract.number', 'contract.name', 'contract.customerName', 'contract.endDate', 'contract.renewalDate', 'contract.link', 'daysLeft'],
  entitlement: ['entitlement.name', 'entitlement.customerName', 'entitlement.contractNumber', 'entitlement.pct', 'entitlement.used', 'entitlement.quantity', 'entitlement.unit'],
  pm: ['pm.programName', 'pm.customerName', 'pm.date'],
  field_visit: ['visit.number', 'visit.title', 'visit.customerName', 'visit.siteName', 'visit.scheduledStart', 'visit.engineer', 'visit.workSummary'],
  report: ['report.name', 'report.period', 'report.summaryHtml'],
  user: ['user.name', 'user.email', 'resetLink', 'temporaryPassword'],
};

export function variablesFor(event: string) {
  const prefix = event.split('.')[0];
  const base = ['sla', 'change', 'request'].includes(prefix) ? EVENT_VARS.ticket : [];
  return [...new Set([...COMMON_VARS, ...base, ...(EVENT_VARS[prefix] ?? []), ...(EVENT_VARS[event] ?? [])])];
}

/** Notification templates by event and channel, with the search, event-group, channel and include-inactive filters in the URL (`q`, `group`, `channel`, `inactive`). */
export default function NotificationTemplatesPage() {
  const q = useConfigKind<Template>('notification-templates');
  const { create, update, remove } = useConfigMutations('notification-templates', { label: 'Template' });
  const editor = useEditor<Template>();
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.event.localeCompare(b.event) || a.channel.localeCompare(b.channel)), [q.data]);
  const groups = useMemo(() => eventGroupOptions(rows.map((t) => t.event)), [rows]);
  const channels = useMemo(() => [...new Set(rows.map((t) => t.channel))].sort().map((c) => ({ value: c, label: channelLabel(c) })), [rows]);
  const f = useConfigFilter(rows, {
    search: [(t) => t.event, (t) => t.name, (t) => t.subject, (t) => channelLabel(t.channel)],
    selects: [
      { key: 'group', label: 'Event group', options: groups, predicate: (t, v) => eventGroup(t.event) === v },
      { key: 'channel', label: 'Channel', options: channels, predicate: (t, v) => t.channel === v },
    ],
    active: (t) => t.isActive,
    noun: ['template', 'templates'],
    searchPlaceholder: 'Search events, templates, subjects',
  });

  const fields: FieldSpec<Values>[] = [
    { key: 'event', label: 'Event', type: 'select', required: true, options: NOTIFICATION_EVENTS.map((e) => ({ value: e, label: e })), disabled: (v) => !!v.id },
    { key: 'channel', label: 'Channel', type: 'select', required: true, options: [{ value: 'email', label: 'Email' }, { value: 'in_app', label: 'In-app' }], disabled: (v) => !!v.id },
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'isActive', label: 'Active', type: 'boolean', placeholder: 'Inactive templates fall back to a plain message' },
    { key: 'subject', label: 'Subject', type: 'text', span: 2, mono: true },
    { key: 'body', label: 'Body (HTML, Handlebars)', type: 'textarea', rows: 14, mono: true, required: true },
    { key: 'vars', label: 'Variables', type: 'custom', render: ({ values }) => <VariableSheet event={String(values.event ?? '')} /> },
  ];

  const initial: Values = editor.row ? { ...editor.row, subject: editor.row.subject ?? '' } : { event: 'ticket.created', channel: 'email', name: '', subject: '', body: '', isActive: true };
  async function submit(v: Values) {
    const body = { name: v.name, subject: v.subject || null, body: v.body, isActive: !!v.isActive };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync({ ...body, event: v.event, channel: v.channel });
  }

  const columns: Column<Template>[] = [
    { key: 'event', header: 'Event', render: (r) => <MonoCell>{r.event}</MonoCell> },
    { key: 'name', header: 'Template', render: (r) => <span className="inline-flex items-center gap-2 font-medium">{r.name}{r.isSystem && <Badge color="slate">system</Badge>}</span> },
    { key: 'channel', header: 'Channel', render: (r) => <Badge color={r.channel === 'email' ? 'blue' : r.channel === 'whatsapp' ? 'green' : 'violet'}>{channelLabel(r.channel)}</Badge> },
    { key: 'subject', header: 'Subject', render: (r) => <MutedCell>{r.subject ?? '—'}</MutedCell> },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  return (
    <div>
      <SectionHeader title="Notification templates" description="Email and in-app message templates per event, rendered with Handlebars. Who receives them is configured under notification rules." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New template</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<Template>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No templates match' : 'No notification templates yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Templates are seeded when the API starts; add one for an event and channel here.'}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, hidden: (r) => r.isSystem, confirm: (r) => ({ title: `Delete template "${r.name}"?`, description: 'Notification rules using it stop sending until they are pointed at another template.', confirmLabel: 'Delete template' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit template' : 'New template'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-3xl" />
    </div>
  );
}

function VariableSheet({ event }: { event: string }) {
  const vars = variablesFor(event);
  return (
    <div className="rounded-lg border border-default bg-surface-2/50 p-2.5 text-[12px]">
      <div className="text-muted mb-1.5">Available variables for <code className="font-mono">{event || 'this event'}</code> — insert as <code className="font-mono">{'{{name}}'}</code>. Helpers: <code className="font-mono">{'{{date x}}'}</code>, <code className="font-mono">{'{{upper x}}'}</code>, <code className="font-mono">{'{{default x "fallback"}}'}</code>, <code className="font-mono">{'{{#if x}}…{{/if}}'}</code>.</div>
      <div className="flex flex-wrap gap-1">
        {vars.map((v) => (
          <code key={v} className="font-mono rounded bg-surface px-1.5 py-0.5 border border-default">{`{{${v}}}`}</code>
        ))}
      </div>
    </div>
  );
}
