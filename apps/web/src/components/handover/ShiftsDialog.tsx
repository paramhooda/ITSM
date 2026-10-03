import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Dialog, Button, Badge, EmptyState } from '@/components/ui';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useAdminMutation } from '@/components/admin/api';
import { handoverApi, handoverKeys, type TeamShift } from './api';

const WEEKDAYS = [{ value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' }, { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 7, label: 'Sun' }];
const describeDays = (days: number[]) => (days.length === 7 ? 'every day' : days.length === 5 && !days.includes(6) && !days.includes(7) ? 'weekdays' : days.map((d) => WEEKDAYS[d - 1]?.label).join(', '));
type Values = Record<string, unknown>;

/** The shifts of one team (name, start and end time, weekdays, timezone), edited by people who manage on-call. */
export function ShiftsDialog({ open, onClose, team }: { open: boolean; onClose: () => void; team: { id: string; name: string } | null }) {
  const q = useQuery({ queryKey: handoverKeys.shifts(team?.id), queryFn: () => handoverApi.shifts(team!.id), enabled: open && !!team });
  const editor = useEditor<TeamShift>();
  const invalidate = [['handover']];
  const create = useAdminMutation((body: Values) => handoverApi.createShift(body as Parameters<typeof handoverApi.createShift>[0]), { invalidate, success: 'Shift added' });
  const update = useAdminMutation(({ id, ...body }: Values & { id: string }) => handoverApi.updateShift(id, body as Partial<TeamShift>), { invalidate, success: 'Shift saved' });
  const remove = useAdminMutation((id: string) => handoverApi.deleteShift(id), { invalidate, success: 'Shift removed' });
  const [confirm, setConfirm] = useState<TeamShift | null>(null);
  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Day, Night, Morning…' },
    { key: 'startTime', label: 'Starts (HH:MM)', type: 'text', required: true, placeholder: '08:00' },
    { key: 'endTime', label: 'Ends (HH:MM)', type: 'text', required: true, placeholder: '20:00', hint: 'An end at or before the start means the shift crosses midnight' },
    { key: 'timezone', label: 'Timezone', type: 'text', required: true, hint: 'IANA name, e.g. Asia/Kolkata' },
    { key: 'sortOrder', label: 'Order', type: 'number' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'days', label: 'Days', type: 'custom', render: ({ value, onChange }) => (
      <div className="flex flex-wrap gap-1.5">
        {WEEKDAYS.map((d) => {
          const on = ((value as number[]) ?? []).includes(d.value);
          return (
            <button key={d.value} type="button" onClick={() => onChange(on ? ((value as number[]) ?? []).filter((x) => x !== d.value) : [...((value as number[]) ?? []), d.value].sort())} className={`rounded-md border px-2 py-0.5 text-[12px] ${on ? 'bg-brand-600 border-brand-600 text-white' : 'border-default text-muted hover:bg-surface-2'}`}>
              {d.label}
            </button>
          );
        })}
      </div>
    ) },
  ];
  const initial: Values = editor.row ? { ...editor.row } : { name: '', startTime: '08:00', endTime: '20:00', timezone: 'Asia/Kolkata', sortOrder: ((q.data?.items.length ?? 0) + 1) * 10, isActive: true, days: [1, 2, 3, 4, 5, 6, 7] };
  async function submit(v: Values) {
    const body = { name: v.name, startTime: v.startTime, endTime: v.endTime, timezone: v.timezone, sortOrder: Number(v.sortOrder ?? 0), isActive: !!v.isActive, days: (v.days as number[]) ?? [] };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync({ ...body, teamId: team!.id });
  }
  return (
    <>
      <Dialog open={open} onClose={onClose} title={team ? `Shifts · ${team.name}` : 'Shifts'} width="max-w-2xl" footer={<div className="flex justify-between w-full"><Button variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => editor.create()}>Add shift</Button><Button variant="ghost" onClick={onClose}>Close</Button></div>}>
        {q.data && q.data.items.length === 0 && <EmptyState title="No shifts yet" description="Add the shifts this team works (for example Day 08:00–20:00 and Night 20:00–08:00); the handover page uses them to know which shift is ending." />}
        {q.data && q.data.items.length > 0 && (
          <table className="table">
            <thead><tr><th>Shift</th><th>Hours</th><th>Days</th><th>Timezone</th><th></th></tr></thead>
            <tbody>
              {q.data.items.map((s) => (
                <tr key={s.id} className={s.isActive ? '' : 'opacity-60'}>
                  <td className="font-medium">{s.name}{!s.isActive && <Badge color="slate" className="ml-2">inactive</Badge>}</td>
                  <td className="tabular-nums">{s.startTime} – {s.endTime}{s.endTime <= s.startTime ? <span className="text-subtle text-[11px]"> (+1 day)</span> : null}</td>
                  <td className="text-muted">{describeDays(s.days)}</td>
                  <td className="text-muted">{s.timezone}</td>
                  <td className="text-right whitespace-nowrap">
                    <Button size="icon" variant="ghost" aria-label="Edit shift" onClick={() => editor.edit(s)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" aria-label="Remove shift" onClick={() => setConfirm(s)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {confirm && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] flex items-center justify-between gap-3">
            <span>Remove the {confirm.name} shift? Past handovers keep their text.</span>
            <div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Keep</Button><Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate(confirm.id, { onSuccess: () => setConfirm(null) })}>Remove</Button></div>
          </div>
        )}
      </Dialog>
      <FormDialog open={editor.open} onClose={editor.close} title={editor.row ? `Edit shift · ${editor.row.name}` : `New shift · ${team?.name ?? ''}`} fields={fields} initial={initial} onSubmit={submit} />
    </>
  );
}
