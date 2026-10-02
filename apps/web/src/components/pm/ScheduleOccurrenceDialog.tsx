import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea, Toggle } from '@/components/ui';
import { useEngineers } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/components/cmdb/hooks';
import { fmtDate } from '@/lib/format';
import { pmApi } from './api';
import type { OccurrenceRow } from './types';

type Occ = Pick<OccurrenceRow, 'id' | 'programName' | 'plannedDate' | 'scheduledDate' | 'engineerId' | 'requiresSiteVisit' | 'fieldVisitId' | 'fieldVisitNumber' | 'customerName' | 'status'>;

/** Schedule dialog: date (+ local start time), engineer and whether to create / move the field visit. */
export function ScheduleOccurrenceDialog({ open, occurrence, onClose, onDone }: { open: boolean; occurrence: Occ | null; onClose: () => void; onDone: (o: OccurrenceRow) => void }) {
  const engineers = useEngineers();
  const can = useAuthStore((s) => s.can);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('10:00');
  const [duration, setDuration] = useState('120');
  const [engineerId, setEngineerId] = useState('');
  const [createVisit, setCreateVisit] = useState(true);
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (!open || !occurrence) return;
    const today = new Date().toISOString().slice(0, 10);
    setDate(occurrence.scheduledDate ?? (occurrence.plannedDate >= today ? occurrence.plannedDate : today));
    setTime('10:00');
    setDuration('120');
    setEngineerId(occurrence.engineerId ?? '');
    setCreateVisit(occurrence.requiresSiteVisit && can('field:manage'));
    setNotes('');
  }, [open, occurrence, can]);
  const m = useMutation({
    mutationFn: () => pmApi.schedule(occurrence!.id, { scheduledDate: date, scheduledTime: time, durationMinutes: Number(duration) || 120, engineerId: engineerId || null, createVisit, notes: notes.trim() || null }),
    onSuccess: (o) => {
      toast.success(o.fieldVisitNumber ? `Scheduled · visit ${o.fieldVisitNumber}` : 'Occurrence scheduled');
      onDone(o);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!occurrence) return null;
  const hasOpenVisit = !!occurrence.fieldVisitId && !['completed', 'cancelled'].includes(occurrence.status);
  return (
    <Dialog open={open} onClose={onClose} title={`Schedule · ${occurrence.programName}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!date}>Schedule</Button></>}>
      <div className="text-[12.5px] text-muted mb-3">{occurrence.customerName} · planned {fmtDate(occurrence.plannedDate)}{occurrence.fieldVisitNumber ? ` · visit ${occurrence.fieldVisitNumber}` : ''}</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Date" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Start (customer local time)"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        <Field label="Duration (min)"><Input type="number" min={15} step={15} value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
        <Field label="Engineer" className="sm:col-span-3"><Select value={engineerId} placeholder="Program default / unassigned" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} onChange={(e) => setEngineerId(e.target.value)} /></Field>
        <Field label="Note" className="sm:col-span-3"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional note kept on the occurrence" /></Field>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {hasOpenVisit ? (
          <div className="text-[12.5px] text-muted">The linked field visit {occurrence.fieldVisitNumber} will be moved to the new date.</div>
        ) : can('field:manage') ? (
          <Toggle checked={createVisit} onChange={setCreateVisit} label={<span className="text-[13px]">Create a preventive maintenance field visit (checklist copied, PM entitlement linked)</span>} />
        ) : (
          <Checkbox checked={false} disabled label={<span className="text-subtle">Creating a field visit requires the field:manage permission</span>} />
        )}
        <div className="text-[12px] text-subtle">The customer's primary / escalation contacts and the engineer receive the pm.scheduled notification.</div>
      </div>
    </Dialog>
  );
}
