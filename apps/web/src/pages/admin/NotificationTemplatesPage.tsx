import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { NOTIFICATION_EVENTS } from '@itsm/shared';
import { Button, Badge, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell, MonoCell } from '@/components/admin/ConfigTable';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useConfigKind, useConfigMutations } from '@/components/admin/api';
import { cn } from '@/lib/utils';

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

const eventGroup = (e: string) => e.split('.')[0];

export default function NotificationTemplatesPage() {
  const q = useConfigKind<Template>('notification-templates');
  const { create, update, remove } = useConfigMutations('notification-templates', { label: 'Template' });
  const editor = useEditor<Template>();
  const [group, setGroup] = useState<string>('');
  const rows = useMemo(() => [...(q.data ?? [])].filter((t) => !group || eventGroup(t.event) === group).sort((a, b) => a.event.localeCompare(b.event) || a.channel.localeCompare(b.channel)), [q.data, group]);
  const groups = useMemo(() => [...new Set((q.data ?? []).map((t) => eventGroup(t.event)))].sort(), [q.data]);

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
    { key: 'channel', header: 'Channel', render: (r) => <Badge color={r.channel === 'email' ? 'blue' : 'violet'}>{r.channel}</Badge> },
    { key: 'subject', header: 'Subject', render: (r) => <MutedCell>{r.subject ?? '—'}</MutedCell> },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  return (
    <div>
      <SectionHeader title="Notification templates" description="Email and in-app message templates per event, rendered with Handlebars. Who receives them is configured under notification rules." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New template</Button>} />
      <ConfigTable<Template>
        toolbar={
          <div className="flex flex-wrap gap-1">
            <button onClick={() => setGroup('')} className={cn('px-2.5 py-1 rounded-md text-[12.5px]', !group ? 'bg-brand-600/10 text-brand-700 font-medium' : 'text-muted hover:bg-surface-2')}>All</button>
            {groups.map((g) => (
              <button key={g} onClick={() => setGroup(g)} className={cn('px-2.5 py-1 rounded-md text-[12.5px]', group === g ? 'bg-brand-600/10 text-brand-700 font-medium' : 'text-muted hover:bg-surface-2')}>
                {g.replace('_', ' ')}
              </button>
            ))}
          </div>
        }
        columns={columns}
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
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
