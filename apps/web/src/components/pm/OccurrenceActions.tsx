import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/components/cmdb/hooks';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { pmApi } from './api';
import type { OccurrenceRow } from './types';

type Occ = Pick<OccurrenceRow, 'id' | 'programName' | 'plannedDate' | 'scheduledDate' | 'customerName' | 'fieldVisitNumber' | 'fieldVisitStatus'>;
const RESULTS = [{ value: 'ok', label: 'OK' }, { value: 'issue', label: 'Issue' }, { value: 'na', label: 'N/A' }];
interface Result { item: string; required?: boolean; done: boolean; result: 'ok' | 'issue' | 'na' | null; notes: string }

/** Completes an occurrence handled without a field visit (checklist results + notes). */
export function CompleteOccurrenceDialog({ open, occurrence, onClose, onDone }: { open: boolean; occurrence: Occ | null; onClose: () => void; onDone: (o: OccurrenceRow) => void }) {
  const detail = useQuery({ queryKey: ['pm', 'occurrence', occurrence?.id, 'checklist'], queryFn: () => pmApi.occurrence(occurrence!.id), enabled: open && !!occurrence });
  const [completedAt, setCompletedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [consume, setConsume] = useState(true);
  const [results, setResults] = useState<Result[]>([]);
  useEffect(() => {
    if (!open) return;
    setCompletedAt(new Date().toISOString().slice(0, 10));
    setNotes('');
    setConsume(true);
  }, [open]);
  useEffect(() => {
    if (detail.data) setResults((detail.data.checklist ?? []).map((c) => ({ item: c.item, required: !!c.required, done: true, result: 'ok', notes: '' })));
  }, [detail.data]);
  const update = (i: number, patch: Partial<Result>) => setResults((r) => r.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const m = useMutation({
    mutationFn: () => pmApi.complete(occurrence!.id, { completedAt: completedAt ? new Date(completedAt + 'T12:00:00').toISOString() : undefined, notes: notes.trim() || null, consumeEntitlement: consume, checklistResults: results.map((r) => ({ item: r.item, required: r.required, done: r.done, result: r.result, notes: r.notes || null })) }),
    onSuccess: (o) => {
      toast.success('Occurrence completed');
      onDone(o);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!occurrence) return null;
  const blocked = !!occurrence.fieldVisitNumber && !['completed', 'cancelled'].includes(occurrence.fieldVisitStatus ?? '');
  return (
    <Dialog open={open} onClose={onClose} title={`Complete · ${occurrence.programName}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={blocked}>Mark completed</Button></>}>
      <div className="text-[12.5px] text-muted mb-3">{occurrence.customerName} · planned {fmtDate(occurrence.plannedDate)}</div>
      {blocked && <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">Field visit {occurrence.fieldVisitNumber} is linked: complete the visit instead; the occurrence follows automatically.</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Completed on"><Input type="date" value={completedAt} onChange={(e) => setCompletedAt(e.target.value)} /></Field>
        <div className="flex items-end pb-1"><Checkbox checked={consume} onChange={(e) => setConsume(e.target.checked)} label="Consume 1 PM visit from the entitlement" /></div>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was done" /></Field>
      </div>
      {results.length > 0 && (
        <Field label="Checklist" className="mt-3">
          <div className="card divide-y divide-[var(--border)]">
            {results.map((c, i) => (
              <div key={i} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', c.required && !c.done && 'bg-amber-50/60')}>
                <Checkbox checked={c.done} onChange={(e) => update(i, { done: e.target.checked })} label={<span className={cn(c.done && 'text-muted')}>{c.item}{c.required && <span className="text-red-500 ml-0.5">*</span>}</span>} className="min-w-[200px] flex-1" />
                <Select className="h-7 py-0 w-24 text-[12.5px]" value={c.result ?? ''} placeholder="Result" options={RESULTS} onChange={(e) => update(i, { result: (e.target.value || null) as Result['result'] })} />
                <Input className="h-7 py-0 text-[12.5px] w-44" placeholder="Notes" value={c.notes} onChange={(e) => update(i, { notes: e.target.value })} />
              </div>
            ))}
          </div>
        </Field>
      )}
    </Dialog>
  );
}

export function RescheduleOccurrenceDialog({ open, occurrence, onClose, onDone }: { open: boolean; occurrence: Occ | null; onClose: () => void; onDone: (o: OccurrenceRow) => void }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open && occurrence) {
      setDate(occurrence.scheduledDate ?? occurrence.plannedDate);
      setReason('');
    }
  }, [open, occurrence]);
  const m = useMutation({ mutationFn: () => pmApi.reschedule(occurrence!.id, { scheduledDate: date, reason: reason.trim() }), onSuccess: (o) => { toast.success('Occurrence rescheduled'); onDone(o); }, onError: (e) => toast.error(errorMessage(e)) });
  if (!occurrence) return null;
  return (
    <Dialog open={open} onClose={onClose} title={`Reschedule · ${occurrence.programName}`} width="max-w-md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!date || !reason.trim()}>Reschedule</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="New date" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
        {occurrence.fieldVisitNumber && <div className="text-[12px] text-subtle">Linked visit {occurrence.fieldVisitNumber} moves to the same date (same local start time). The history is kept in the occurrence notes and the audit trail.</div>}
      </div>
    </Dialog>
  );
}

export function CancelOccurrenceDialog({ open, occurrence, onClose, onDone }: { open: boolean; occurrence: Occ | null; onClose: () => void; onDone: (o: OccurrenceRow) => void }) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const m = useMutation({ mutationFn: () => pmApi.cancel(occurrence!.id, reason.trim()), onSuccess: (o) => { toast.success('Occurrence cancelled'); onDone(o); }, onError: (e) => toast.error(errorMessage(e)) });
  if (!occurrence) return null;
  return (
    <Dialog open={open} onClose={onClose} title={`Cancel · ${occurrence.programName} ${fmtDate(occurrence.plannedDate)}`} width="max-w-md" footer={<><Button variant="ghost" onClick={onClose}>Back</Button><Button variant="danger" onClick={() => m.mutate()} loading={m.isPending} disabled={!reason.trim()}>Cancel occurrence</Button></>}>
      <Field label="Reason" required><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      {occurrence.fieldVisitNumber && <div className="text-[12px] text-subtle mt-2">The linked visit {occurrence.fieldVisitNumber} is cancelled as well when it is still open.</div>}
    </Dialog>
  );
}
