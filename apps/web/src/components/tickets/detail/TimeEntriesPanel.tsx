import { useState } from 'react';
import { Panel } from '../Panel';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Timer, Plus, Trash2 } from 'lucide-react';
import { Button, Input, Select, Checkbox } from '@/components/ui';
import { fmtDateTime, fmtDuration } from '@/lib/format';
import { get } from '@/api/client';
import { ticketsApi, qk, itemsOf } from '../api';

/** Time entries table with inline add (optionally consuming a contract entitlement). */
export function TimeEntriesPanel({ ticketId, contractId, canEdit }: { ticketId: string; contractId: string | null; canEdit: boolean }) {
  const qc = useQueryClient();
  const time = useQuery({ queryKey: qk.time(ticketId), queryFn: () => ticketsApi.time(ticketId) });
  const entitlements = useQuery({ queryKey: ['contracts', contractId, 'entitlements'], queryFn: () => get<unknown>(`/contracts/${contractId}/entitlements`).then((d) => itemsOf<{ id: string; name: string; unit: string }>(d)), enabled: !!contractId && canEdit, retry: false });
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [description, setDescription] = useState('');
  const [workType, setWorkType] = useState('remote');
  const [billable, setBillable] = useState(false);
  const [entitlementId, setEntitlementId] = useState('');
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.time(ticketId) });
    qc.invalidateQueries({ queryKey: ['tickets', ticketId, 'timeline'] });
  };
  const add = useMutation({
    mutationFn: () => ticketsApi.addTime(ticketId, { minutes: Number(minutes), description: description || null, workType, billable, entitlementId: entitlementId || null }),
    onSuccess: () => {
      setMinutes('');
      setDescription('');
      setOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: (id: string) => ticketsApi.deleteTime(ticketId, id), onSuccess: invalidate, onError: (e: Error) => toast.error(e.message) });
  const items = time.data?.items ?? [];
  return (
    <Panel
      title={<span className="inline-flex items-center gap-2"><Timer className="h-4 w-4 text-subtle" /> Time {time.data ? <span className="text-subtle font-normal">{fmtDuration(time.data.totalMinutes)}{time.data.billableMinutes ? ` · ${fmtDuration(time.data.billableMinutes)} billable` : ''}</span> : null}</span>}
      actions={canEdit ? <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen((o) => !o)}>Log time</Button> : undefined}
      padded={false}
    >
      {open && canEdit && (
        <div className="px-4 py-3 border-b border-default grid grid-cols-2 sm:grid-cols-[90px_1fr_120px_auto] gap-2 items-end">
          <Input type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="Minutes" autoFocus />
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was done" />
          <Select value={workType} onChange={(e) => setWorkType(e.target.value)} options={[{ value: 'remote', label: 'Remote' }, { value: 'onsite', label: 'On-site' }, { value: 'travel', label: 'Travel' }, { value: 'other', label: 'Other' }]} />
          <Button size="sm" onClick={() => add.mutate()} disabled={!minutes || Number(minutes) <= 0} loading={add.isPending}>
            Save
          </Button>
          <div className="col-span-2 sm:col-span-4 flex flex-wrap items-center gap-4">
            <Checkbox checked={billable} onChange={(e) => setBillable(e.target.checked)} label="Billable" />
            {(entitlements.data ?? []).length > 0 && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                Consume entitlement
                <Select value={entitlementId} onChange={(e) => setEntitlementId(e.target.value)} placeholder="None" className="h-7 py-0 w-56 text-[12.5px]" options={(entitlements.data ?? []).map((en) => ({ value: en.id, label: `${en.name} (${en.unit})` }))} />
              </div>
            )}
          </div>
        </div>
      )}
      {items.length === 0 ? (
        <div className="px-4 py-3 text-[12.5px] text-muted">No time logged.</div>
      ) : (
        <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Type</th>
              <th>Description</th>
              <th className="text-right">Minutes</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td className="text-[12.5px] text-muted whitespace-nowrap">{fmtDateTime(e.startedAt ?? e.createdAt)}</td>
                <td className="text-[13px]">{e.userName ?? '—'}</td>
                <td className="text-[12.5px] capitalize">{e.workType}{e.billable ? ' · billable' : ''}</td>
                <td className="text-[13px]">{e.description ?? '—'}</td>
                <td className="text-right tabular-nums text-[13px]">{e.minutes}</td>
                {canEdit && (
                  <td className="text-right">
                    <button onClick={() => remove.mutate(e.id)} className="text-subtle hover:text-red-600" aria-label="Delete entry">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
