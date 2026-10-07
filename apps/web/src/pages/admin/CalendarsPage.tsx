import { useMemo } from 'react';
import { Plus, Pencil, Trash2, Star } from 'lucide-react';
import { Button, Badge, type Column } from '@/components/ui';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { WeeklyHoursEditor, summarizeHours, type WeeklyHours } from '@/components/admin/WeeklyHoursEditor';
import { timezoneOptions } from '@/components/admin/inputs';
import { useConfigKind, useConfigMutations } from '@/components/admin/api';

interface Calendar {
  id: string;
  name: string;
  description: string | null;
  timezone: string;
  is24x7: boolean;
  hours: WeeklyHours;
  holidayCalendarId: string | null;
  isDefault: boolean;
}

type Values = Record<string, unknown>;
const DEFAULT_HOURS: WeeklyHours = { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']] };

/** Business calendars with the search and coverage filters in the URL (`q`, `coverage`). */
export default function CalendarsPage() {
  const q = useConfigKind<Calendar>('calendars');
  const holidayCals = useConfigKind<{ id: string; name: string }>('holiday-calendars');
  const { create, update, remove } = useConfigMutations('calendars', { lookups: true, label: 'Calendar' });
  const editor = useEditor<Calendar>();
  const tz = timezoneOptions();
  const holidayName = (id: string | null) => holidayCals.data?.find((h) => h.id === id)?.name;
  const all = useMemo(() => q.data ?? [], [q.data]);
  const f = useConfigFilter(all, {
    search: [(r) => r.name, (r) => r.description, (r) => r.timezone, (r) => holidayName(r.holidayCalendarId), (r) => (r.is24x7 ? '24x7' : summarizeHours(r.hours))],
    selects: [{ key: 'coverage', label: 'Coverage', options: [{ value: '24x7', label: '24x7' }, { value: 'hours', label: 'Business hours' }], predicate: (r, v) => (r.is24x7 ? '24x7' : 'hours') === v }],
    noun: ['calendar', 'calendars'],
    searchPlaceholder: 'Search calendars, timezones',
  });

  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'timezone', label: 'Timezone', type: 'select', required: true, options: tz },
    { key: 'description', label: 'Description', type: 'text', span: 2 },
    { key: 'is24x7', label: 'Coverage', type: 'boolean', placeholder: 'Round-the-clock (24x7)' },
    { key: 'isDefault', label: 'Default', type: 'boolean', placeholder: 'Platform default calendar' },
    { key: 'holidayCalendarId', label: 'Holiday calendar', type: 'select', options: (holidayCals.data ?? []).map((h) => ({ value: h.id, label: h.name })), visible: (v) => !v.is24x7, span: 2 },
    { key: 'hours', label: 'Weekly working hours', type: 'custom', visible: (v) => !v.is24x7, render: ({ value, onChange }) => <WeeklyHoursEditor value={(value as WeeklyHours) ?? {}} onChange={onChange} /> },
  ];

  const initial: Values = editor.row ? { ...editor.row, hours: editor.row.hours ?? {} } : { name: '', description: '', timezone: 'Asia/Kolkata', is24x7: false, hours: DEFAULT_HOURS, holidayCalendarId: null, isDefault: false };

  async function submit(v: Values) {
    const body = { name: v.name, description: v.description || null, timezone: v.timezone, is24x7: !!v.is24x7, hours: v.is24x7 ? {} : (v.hours as WeeklyHours) ?? {}, holidayCalendarId: v.is24x7 ? null : v.holidayCalendarId || null, isDefault: !!v.isDefault };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync(body);
  }

  const columns: Column<Calendar>[] = [
    { key: 'name', header: 'Calendar', render: (r) => (
      <div>
        <div className="inline-flex items-center gap-2 font-medium">{r.name}{r.isDefault && <Badge color="amber"><Star className="h-3 w-3" /> default</Badge>}</div>
        {r.description && <div className="text-[12px] text-muted">{r.description}</div>}
      </div>
    ) },
    { key: 'timezone', header: 'Timezone', render: (r) => <MutedCell>{r.timezone}</MutedCell> },
    { key: 'hours', header: 'Working hours', render: (r) => (r.is24x7 ? <Badge color="green">24x7</Badge> : <MutedCell>{summarizeHours(r.hours)}</MutedCell>) },
    { key: 'holidays', header: 'Holidays', render: (r) => <MutedCell>{holidayName(r.holidayCalendarId) ?? '—'}</MutedCell> },
  ];

  return (
    <div>
      <SectionHeader title="Business calendars" description="Working hours per timezone used by SLA policies, contracts and sites. Holidays come from the linked holiday calendar." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New calendar</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<Calendar>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No calendars match' : 'No business calendars yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Add the working hours SLA policies, contracts and sites count against.'}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, disabled: (r) => r.isDefault, confirm: (r) => ({ title: `Delete calendar "${r.name}"?`, description: 'SLA policies using it fall back to the platform default.', confirmLabel: 'Delete calendar' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit calendar' : 'New calendar'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}
