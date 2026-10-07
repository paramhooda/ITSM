import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Button, Badge, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useAdminMutation } from '@/components/admin/api';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { fmtDateTime } from '@/lib/format';
import { changesApi, changeKeys, type Blackout } from '@/components/changes/api';

type Values = Record<string, unknown>;
const toLocal = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Change freezes: periods when normal changes must not be implemented, for one customer or everyone; the search, customer and include-inactive filters live in the URL (`q`, `customerId`, `inactive`). */
export default function ChangeBlackoutsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: changeKeys.blackouts({ all: true }), queryFn: () => changesApi.blackouts({ all: true }) });
  const editor = useEditor<Blackout>();
  const customers = useCustomersLookup();
  const invalidate = [['changes']];
  const create = useAdminMutation((body: Values) => changesApi.createBlackout(body), { invalidate, success: 'Blackout window created' });
  const update = useAdminMutation(({ id, ...body }: Values & { id: string }) => changesApi.updateBlackout(id, body), { invalidate, success: 'Blackout window updated' });
  const remove = useAdminMutation((id: string) => changesApi.deleteBlackout(id), { invalidate, success: 'Blackout window deleted' });
  const customerOpts = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }));
  // A window is in force while it is switched on and has not ended; past windows are inactive and hidden until "Include inactive".
  const inForce = (r: Blackout) => r.isActive && new Date(r.endsAt).getTime() > Date.now();
  const all = useMemo(() => q.data?.items ?? [], [q.data]);
  const f = useConfigFilter(all, {
    search: [(r) => r.name, (r) => r.reason, (r) => r.customerName ?? (r.customerId ? '' : 'Every customer')],
    selects: [{ key: 'customerId', label: 'Customer', options: [{ value: 'everyone', label: 'Every customer' }, ...customerOpts], predicate: (r, v) => (v === 'everyone' ? r.customerId === null : r.customerId === v) }],
    active: inForce,
    noun: ['window', 'windows'],
    searchPlaceholder: 'Search windows, reasons',
  });

  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Month-end freeze' },
    { key: 'customerId', label: 'Customer', type: 'select', options: customerOpts, hint: 'Empty = every customer' },
    { key: 'startsAt', label: 'From', type: 'datetime', required: true },
    { key: 'endsAt', label: 'Until', type: 'datetime', required: true },
    { key: 'reason', label: 'Reason', type: 'textarea', rows: 2, span: 2, placeholder: 'Shown on the conflict warning' },
    { key: 'allowEmergency', label: 'Emergency changes may go ahead', type: 'boolean' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
  ];
  const initial: Values = editor.row
    ? { ...editor.row, customerId: editor.row.customerId ?? '', startsAt: toLocal(editor.row.startsAt), endsAt: toLocal(editor.row.endsAt) }
    : { name: '', customerId: '', startsAt: '', endsAt: '', reason: '', allowEmergency: true, isActive: true };
  async function submit(v: Values) {
    const body = { name: v.name, customerId: (v.customerId as string) || null, startsAt: new Date(String(v.startsAt)).toISOString(), endsAt: new Date(String(v.endsAt)).toISOString(), reason: (v.reason as string) || null, allowEmergency: !!v.allowEmergency, isActive: !!v.isActive };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync(body);
    await qc.invalidateQueries({ queryKey: ['changes'] });
  }
  const columns: Column<Blackout>[] = [
    { key: 'name', header: 'Window', render: (r) => <div><div className="font-medium">{r.name}</div>{r.reason && <MutedCell>{r.reason}</MutedCell>}</div> },
    { key: 'customer', header: 'Customer', render: (r) => <MutedCell>{r.customerName ?? (r.customerId ? '…' : 'Every customer')}</MutedCell> },
    { key: 'when', header: 'From → until', render: (r) => <span className="text-[12.5px] whitespace-nowrap">{fmtDateTime(r.startsAt)} → {fmtDateTime(r.endsAt)}</span> },
    { key: 'emergency', header: 'Emergency', render: (r) => <Badge color={r.allowEmergency ? 'green' : 'red'}>{r.allowEmergency ? 'allowed' : 'blocked'}</Badge> },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={inForce(r)} /> },
  ];
  return (
    <div>
      <SectionHeader title="Change blackout windows" description="Periods when normal changes must not be implemented. A change scheduled inside one gets a warning on its record and on the calendar; emergency changes may be let through." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New window</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<Blackout>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No windows match' : 'No blackout windows'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Add a change freeze such as a month-end close or a public holiday.'}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete "${r.name}"?`, confirmLabel: 'Delete' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? `Edit ${editor.row.name}` : 'New blackout window'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}
