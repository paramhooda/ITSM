import { useEffect, useState } from 'react';
import { Panel } from '../Panel';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { GitBranch, Save } from 'lucide-react';
import { Button, Field, Textarea, Select, Input, Badge } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { ticketsApi } from '../api';
import type { ChangeDetails } from '../types';

const toLocal = (v: string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 16) : '');
const toIso = (v: string) => (v ? new Date(v).toISOString() : null);

const TEXT_FIELDS: { key: keyof ChangeDetails; label: string; wide?: boolean; group: 'assessment' | 'plans' | 'review' }[] = [
  { key: 'justification', label: 'Justification', wide: true, group: 'assessment' },
  { key: 'riskAssessment', label: 'Risk assessment', group: 'assessment' },
  { key: 'impactAssessment', label: 'Impact assessment', group: 'assessment' },
  { key: 'implementationPlan', label: 'Implementation plan', group: 'plans' },
  { key: 'testPlan', label: 'Test plan', group: 'plans' },
  { key: 'backoutPlan', label: 'Backout plan', group: 'plans' },
  { key: 'communicationPlan', label: 'Communication plan', group: 'plans' },
  { key: 'cabNotes', label: 'CAB notes', wide: true, group: 'review' },
  { key: 'implementationNotes', label: 'Implementation notes', wide: true, group: 'review' },
  { key: 'pirNotes', label: 'Post-implementation review', wide: true, group: 'review' },
];

export function ChangeForm({ ticketId, details, canEdit }: { ticketId: string; details: ChangeDetails | null; canEdit: boolean }) {
  const qc = useQueryClient();
  const { options } = useLookups();
  const [f, setF] = useState<Partial<ChangeDetails>>(details ?? {});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setF(details ?? {});
    setDirty(false);
  }, [details]);
  const set = (k: keyof ChangeDetails, v: unknown) => {
    setF((s) => ({ ...s, [k]: v }));
    setDirty(true);
  };
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { changeType: f.changeType ?? 'normal', riskId: f.riskId ?? null, downtimeExpectedMinutes: f.downtimeExpectedMinutes ?? null, pirOutcome: f.pirOutcome ?? null };
      for (const t of TEXT_FIELDS) body[t.key] = (f[t.key] as string) ?? null;
      for (const k of ['scheduledStart', 'scheduledEnd', 'actualStart', 'actualEnd'] as const) body[k] = f[k] ? new Date(f[k]!).toISOString() : null;
      return ticketsApi.change(ticketId, body);
    },
    onSuccess: () => {
      toast.success('Change details saved');
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['tickets', ticketId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const text = (key: keyof ChangeDetails, label: string, wide?: boolean) => (
    <Field key={key} label={label} className={wide ? 'sm:col-span-2' : undefined}>
      {canEdit ? <Textarea value={(f[key] as string) ?? ''} onChange={(e) => set(key, e.target.value)} className="min-h-[64px]" /> : <div className="text-[13px] whitespace-pre-wrap">{(f[key] as string) || <span className="text-subtle">—</span>}</div>}
    </Field>
  );
  const dt = (key: 'scheduledStart' | 'scheduledEnd' | 'actualStart' | 'actualEnd', label: string) => (
    <Field key={key} label={label}>
      {canEdit ? <Input type="datetime-local" value={toLocal(f[key])} onChange={(e) => set(key, toIso(e.target.value))} /> : <div className="text-[13px]">{f[key] ? new Date(f[key]!).toLocaleString() : '—'}</div>}
    </Field>
  );
  return (
    <Panel
      title={<span className="inline-flex items-center gap-2"><GitBranch className="h-4 w-4 text-subtle" /> Change record <Badge color={f.changeType === 'emergency' ? 'red' : f.changeType === 'standard' ? 'green' : 'blue'} className="capitalize">{f.changeType ?? 'normal'}</Badge></span>}
      actions={canEdit ? <Button size="sm" icon={<Save className="h-3.5 w-3.5" />} onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>Save</Button> : undefined}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Change type">
          <Select value={f.changeType ?? 'normal'} disabled={!canEdit} onChange={(e) => set('changeType', e.target.value)} options={[{ value: 'standard', label: 'Standard (pre-approved)' }, { value: 'normal', label: 'Normal' }, { value: 'emergency', label: 'Emergency' }]} />
        </Field>
        <Field label="Risk">
          <Select value={f.riskId ?? ''} disabled={!canEdit} onChange={(e) => set('riskId', e.target.value || null)} placeholder="—" options={options('change_risk').map((o) => ({ value: o.id, label: o.label }))} />
        </Field>
        {dt('scheduledStart', 'Scheduled start')}
        {dt('scheduledEnd', 'Scheduled end')}
        {dt('actualStart', 'Actual start')}
        {dt('actualEnd', 'Actual end')}
        <Field label="Expected downtime (minutes)">
          {canEdit ? <Input type="number" min={0} value={f.downtimeExpectedMinutes ?? ''} onChange={(e) => set('downtimeExpectedMinutes', e.target.value === '' ? null : Number(e.target.value))} /> : <div className="text-[13px]">{f.downtimeExpectedMinutes ?? '—'}</div>}
        </Field>
        <Field label="PIR outcome">
          <Select value={f.pirOutcome ?? ''} disabled={!canEdit} onChange={(e) => set('pirOutcome', e.target.value || null)} placeholder="—" options={[{ value: 'successful', label: 'Successful' }, { value: 'successful_with_issues', label: 'Successful with issues' }, { value: 'failed', label: 'Failed' }, { value: 'backed_out', label: 'Backed out' }]} />
        </Field>
        <div className="sm:col-span-2 text-[11.5px] uppercase tracking-wide text-subtle font-medium pt-1">Assessment</div>
        {TEXT_FIELDS.filter((t) => t.group === 'assessment').map((t) => text(t.key, t.label, t.wide))}
        <div className="sm:col-span-2 text-[11.5px] uppercase tracking-wide text-subtle font-medium pt-1">Plans</div>
        {TEXT_FIELDS.filter((t) => t.group === 'plans').map((t) => text(t.key, t.label, t.wide))}
        <div className="sm:col-span-2 text-[11.5px] uppercase tracking-wide text-subtle font-medium pt-1">Review</div>
        {TEXT_FIELDS.filter((t) => t.group === 'review').map((t) => text(t.key, t.label, t.wide))}
      </div>
    </Panel>
  );
}
