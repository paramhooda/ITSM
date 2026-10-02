import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea, Toggle } from '@/components/ui';
import { errorMessage } from '@/components/cmdb/hooks';
import { fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fieldApi } from './api';
import { fromLocalInput, toLocalInput } from './VisitForm';
import type { ChecklistItem, VisitDetail } from './types';

const RESULTS = [
  { value: 'ok', label: 'OK' },
  { value: 'issue', label: 'Issue' },
  { value: 'na', label: 'N/A' },
];

/**
 * Completion dialog: narrative, times, checklist tick-off and the entitlement
 * toggle. Work minutes default to the elapsed time since the visit started.
 */
export function CompleteVisitDialog({ open, onClose, visit, onCompleted }: { open: boolean; onClose: () => void; visit: VisitDetail; onCompleted: (v: VisitDetail) => void }) {
  const [actualEnd, setActualEnd] = useState('');
  const [workMinutes, setWorkMinutes] = useState('');
  const [travelMinutes, setTravelMinutes] = useState('');
  const [workSummary, setWorkSummary] = useState('');
  const [findings, setFindings] = useState('');
  const [recommendations, setRecommendations] = useState('');
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [consume, setConsume] = useState(true);
  const [billable, setBillable] = useState(false);

  useEffect(() => {
    if (!open) return;
    const now = new Date();
    setActualEnd(toLocalInput(now.toISOString()));
    const start = visit.actualStart ?? visit.scheduledStart;
    setWorkMinutes(start ? String(Math.max(0, Math.round((now.getTime() - new Date(start).getTime()) / 60_000))) : '');
    setTravelMinutes(visit.travelMinutes !== null && visit.travelMinutes !== undefined ? String(visit.travelMinutes) : '');
    setWorkSummary(visit.workSummary ?? '');
    setFindings(visit.findings ?? '');
    setRecommendations(visit.recommendations ?? '');
    setChecklist((visit.checklist ?? []).map((c) => ({ ...c, done: !!c.done, result: c.result ?? null, notes: c.notes ?? '' })));
    setConsume(!!visit.entitlement && !visit.consumptionId);
    setBillable(!!visit.billable);
  }, [open, visit]);

  const missingRequired = useMemo(() => checklist.filter((c) => c.required && !c.done).length, [checklist]);
  const ent = visit.entitlement;

  const complete = useMutation({
    mutationFn: () =>
      fieldApi.complete(visit.id, {
        actualEnd: fromLocalInput(actualEnd),
        workMinutes: workMinutes === '' ? null : Number(workMinutes),
        travelMinutes: travelMinutes === '' ? null : Number(travelMinutes),
        workSummary: workSummary.trim(),
        findings: findings.trim() || null,
        recommendations: recommendations.trim() || null,
        checklist: checklist.map((c) => ({ item: c.item, required: !!c.required, done: !!c.done, result: c.result ?? null, notes: c.notes || null })),
        consumeEntitlement: consume,
        billable,
      }),
    onSuccess: (v) => {
      toast.success(`${v.number} completed`);
      onCompleted(v);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const update = (i: number, patch: Partial<ChecklistItem>) => setChecklist((list) => list.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Complete ${visit.number}`}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => complete.mutate()} loading={complete.isPending} disabled={workSummary.trim().length < 3}>
            Complete visit
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Actual end">
            <Input type="datetime-local" className="h-8 py-0 text-[13px]" value={actualEnd} onChange={(e) => setActualEnd(e.target.value)} />
          </Field>
          <Field label="Work minutes" hint="Blank = computed from start/end">
            <Input type="number" min={0} className="h-8 py-0 text-[13px]" value={workMinutes} onChange={(e) => setWorkMinutes(e.target.value)} />
          </Field>
          <Field label="Travel minutes">
            <Input type="number" min={0} className="h-8 py-0 text-[13px]" value={travelMinutes} onChange={(e) => setTravelMinutes(e.target.value)} />
          </Field>
        </div>
        <Field label="Work summary" required>
          <Textarea value={workSummary} onChange={(e) => setWorkSummary(e.target.value)} rows={3} placeholder="What was done on site" autoFocus />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Findings">
            <Textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} />
          </Field>
          <Field label="Recommendations">
            <Textarea value={recommendations} onChange={(e) => setRecommendations(e.target.value)} rows={3} />
          </Field>
        </div>
        {checklist.length > 0 && (
          <Field label={`Checklist${missingRequired ? ` · ${missingRequired} required item${missingRequired > 1 ? 's' : ''} not done` : ''}`}>
            <div className="card divide-y divide-[var(--border)]">
              {checklist.map((c, i) => (
                <div key={i} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', c.required && !c.done && 'bg-amber-50/60 dark:bg-amber-500/5')}>
                  <Checkbox checked={!!c.done} onChange={(e) => update(i, { done: e.target.checked, result: e.target.checked && !c.result ? 'ok' : c.result })} label={<span className={cn(c.done && 'line-through text-muted')}>{c.item}{c.required && <span className="text-red-500 ml-0.5">*</span>}</span>} className="min-w-[200px] flex-1" />
                  <Select className="h-7 py-0 w-24 text-[12.5px]" value={c.result ?? ''} placeholder="Result" options={RESULTS} onChange={(e) => update(i, { result: (e.target.value || null) as ChecklistItem['result'] })} />
                  <Input className="h-7 py-0 text-[12.5px] w-48" placeholder="Notes" value={c.notes ?? ''} onChange={(e) => update(i, { notes: e.target.value })} />
                </div>
              ))}
            </div>
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-4 pt-1">
          {ent ? (
            <Toggle checked={consume} onChange={setConsume} label={<span>Consume 1 {ent.unit === 'hours' ? 'hour block' : 'visit'} from <strong>{ent.name}</strong> <span className="text-subtle">({fmtNumber(ent.utilization.remaining, 0)} of {fmtNumber(ent.utilization.quantity, 0)} left)</span>{visit.consumptionId ? ' · already consumed' : ''}</span>} />
          ) : (
            <span className="text-[12.5px] text-subtle">No entitlement linked: the visit is not metered.</span>
          )}
          <Checkbox checked={billable} onChange={(e) => setBillable(e.target.checked)} label="Billable" />
        </div>
      </div>
    </Dialog>
  );
}
