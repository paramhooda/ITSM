import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { Button, Select, Input, Field } from '@/components/ui';
import { FormDialog, type FieldSpec } from '@/components/admin/FormDialog';
import { CheckboxGroup } from '@/components/admin/inputs';
import { errorMessage } from '@/components/admin/api';
import { useEngineers, useLookups } from '@/hooks/useLookups';
import { oncallApi, oncallKeys, CHANNEL_LABELS, STEP_TARGET_LABELS, type Channel, type EscalationStep, type Policy, type PolicyBody } from './api';

type Values = Record<string, unknown>;
const CHANNELS = (Object.keys(CHANNEL_LABELS) as Channel[]).map((c) => ({ value: c, label: CHANNEL_LABELS[c] }));
const TARGETS = (Object.keys(STEP_TARGET_LABELS) as EscalationStep['target'][]).map((t) => ({ value: t, label: STEP_TARGET_LABELS[t] }));
const blankStep = (): EscalationStep => ({ target: 'oncall', channels: ['email', 'in_app', 'whatsapp'], timeoutMinutes: 15, userId: null, teamId: null });

/** The ordered steps of a policy: whom to reach, how, and how long to wait before the next step. */
function StepsEditor({ value, onChange }: { value: EscalationStep[]; onChange: (v: EscalationStep[]) => void }) {
  const engineers = useEngineers();
  const { lookups } = useLookups();
  const people = useMemo(() => (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name })), [engineers.data]);
  const teams = useMemo(() => (lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name })), [lookups?.teams]);
  const patch = (i: number, p: Partial<EscalationStep>) => onChange(value.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      {value.map((s, i) => (
        <div key={i} className="rounded-lg border border-default p-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Step {i + 1}</span>
            <span className="flex-1" />
            <Button variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}><ChevronDown className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="icon" aria-label="Remove step" disabled={value.length === 1} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Reach">
              <Select value={s.target} onChange={(e) => patch(i, { target: e.target.value as EscalationStep['target'], userId: null })} options={TARGETS} />
            </Field>
            {s.target === 'user' ? (
              <Field label="Person" required>
                <Select value={s.userId ?? ''} onChange={(e) => patch(i, { userId: e.target.value || null })} placeholder="Pick a person" options={people} />
              </Field>
            ) : (
              <Field label="Team" hint="Empty = the ticket's assigned team">
                <Select value={s.teamId ?? ''} onChange={(e) => patch(i, { teamId: e.target.value || null })} placeholder="Ticket's assigned team" options={teams} />
              </Field>
            )}
            <Field label="Channels" required>
              <CheckboxGroup value={s.channels} onChange={(v) => patch(i, { channels: v as Channel[] })} options={CHANNELS} columns={3} />
            </Field>
            <Field label="Wait before the next step (minutes)" required>
              <Input type="number" min={1} max={1440} value={s.timeoutMinutes} onChange={(e) => patch(i, { timeoutMinutes: Math.max(1, Math.min(1440, Number(e.target.value) || 1)) })} />
            </Field>
          </div>
        </div>
      ))}
      <div>
        <Button variant="outline" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => onChange([...value, blankStep()])} disabled={value.length >= 10}>Add step</Button>
      </div>
    </div>
  );
}

/** Create or edit an escalation policy (drawer). */
export function PolicyEditor({ open, onClose, policy }: { open: boolean; onClose: () => void; policy: Policy | null }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (body: PolicyBody) => (policy ? oncallApi.updatePolicy(policy.id, body) : oncallApi.createPolicy(body)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: oncallKeys.all });
      toast.success(policy ? 'Policy updated' : 'Policy created');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Policy name', type: 'text', required: true, placeholder: 'NOC critical' },
    { key: 'repeatCount', label: 'Repeat the steps', type: 'number', min: 0, max: 5, hint: 'How many more times the whole list runs when nobody acknowledges' },
    { key: 'assignOnAck', label: 'Assign on acknowledgement', type: 'boolean', placeholder: 'An unassigned ticket goes to whoever acknowledges' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'description', label: 'Notes', type: 'textarea', rows: 2, span: 2 },
    { key: 'steps', label: 'Steps', type: 'custom', section: 'Escalation steps', span: 2, render: ({ value, onChange }) => <StepsEditor value={(value as EscalationStep[]) ?? []} onChange={onChange} /> },
  ];
  const initial: Values = policy
    ? { ...policy, steps: policy.steps.map((s) => ({ target: s.target, userId: s.userId ?? null, teamId: s.teamId ?? null, channels: s.channels, timeoutMinutes: s.timeoutMinutes })) }
    : { name: '', description: '', repeatCount: 0, assignOnAck: true, isActive: true, steps: [blankStep()] };

  async function submit(v: Values) {
    const steps = (v.steps as EscalationStep[]) ?? [];
    if (!steps.length) throw new Error('Add at least one step');
    for (const [i, s] of steps.entries()) {
      if (s.target === 'user' && !s.userId) throw new Error(`Step ${i + 1}: pick the person to page`);
      if (!s.channels.length) throw new Error(`Step ${i + 1}: choose at least one channel`);
    }
    await save.mutateAsync({ name: String(v.name ?? '').trim(), description: (v.description as string) || null, steps, repeatCount: Number(v.repeatCount ?? 0) || 0, assignOnAck: !!v.assignOnAck, isActive: !!v.isActive });
  }

  return <FormDialog<Values> open={open} onClose={onClose} title={policy ? `Edit ${policy.name}` : 'New escalation policy'} description="Who a page reaches, over which channels, and how long to wait before moving on." fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" submitLabel={policy ? 'Save policy' : 'Create policy'} />;
}
