import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { FormDialog, type FieldSpec } from '@/components/admin/FormDialog';
import { MultiSelect, timezoneOptions } from '@/components/admin/inputs';
import { errorMessage } from '@/components/admin/api';
import { useEngineers } from '@/hooks/useLookups';
import { oncallApi, oncallKeys, type Rota, type RotaBody } from './api';

type Values = Record<string, unknown>;

/** Ordered participant list: who starts first, then the handoff order. */
function ParticipantsEditor({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: { value: string; label: string; hint?: string }[] }) {
  const move = (i: number, dir: -1 | 1) => {
    const next = [...value];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <MultiSelect value={value} onChange={onChange} options={options} placeholder="Add a person…" maxHeight="max-h-40" />
      {value.length > 0 && (
        <ol className="rounded-lg border border-default divide-y divide-[var(--border)]">
          {value.map((id, i) => (
            <li key={id} className="flex items-center gap-2 px-2 py-1.5 text-[12.5px]">
              <span className="w-5 text-right font-mono text-subtle">{i + 1}.</span>
              <span className="flex-1 truncate">{options.find((o) => o.value === id)?.label ?? id}</span>
              {i === 0 && <span className="text-[11px] text-subtle">starts on the start date</span>}
              <Button variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}><ChevronDown className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => onChange(value.filter((x) => x !== id))}><X className="h-3.5 w-3.5" /></Button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

/** Create or edit a rota (drawer). The team can be preset from the page's team filter. */
export function RotaEditor({ open, onClose, rota, teamId, teams }: { open: boolean; onClose: () => void; rota: Rota | null; teamId?: string | null; teams: { id: string; name: string }[] }) {
  const qc = useQueryClient();
  const engineers = useEngineers();
  const engineerOpts = useMemo(() => (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name, hint: e.email })), [engineers.data]);
  const save = useMutation({
    mutationFn: (body: RotaBody) => (rota ? oncallApi.updateRota(rota.id, body) : oncallApi.createRota(body)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: oncallKeys.all });
      toast.success(rota ? 'Rota updated' : 'Rota created');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const fields: FieldSpec<Values>[] = [
    { key: 'teamId', label: 'Team', type: 'select', required: true, options: teams.map((t) => ({ value: t.id, label: t.name })), disabled: !!rota },
    { key: 'name', label: 'Rota name', type: 'text', required: true, placeholder: 'Primary' },
    { key: 'rotation', label: 'Rotation', type: 'select', required: true, options: [{ value: 'weekly', label: 'Weekly' }, { value: 'daily', label: 'Daily' }, { value: 'custom', label: 'Every N days' }] },
    { key: 'rotationDays', label: 'Days per turn', type: 'number', min: 1, max: 365, visible: (v) => v.rotation === 'custom', required: true },
    { key: 'startDate', label: 'First handoff', type: 'date', required: true, hint: 'The first person in the list starts on this date at the handoff time; a weekly rota hands over on this weekday.' },
    { key: 'handoffTime', label: 'Handoff time', type: 'text', required: true, placeholder: '09:00', mono: true },
    { key: 'timezone', label: 'Timezone', type: 'select', required: true, options: timezoneOptions() },
    { key: 'sortOrder', label: 'Order', type: 'number', min: 0, max: 100, hint: 'The lowest order is the primary rota, paged first' },
    { key: 'hasWindow', label: 'Cover a daily window only', type: 'boolean', placeholder: 'Outside the window nobody from this rota is on call (an overnight window is fine)' },
    { key: 'shiftStart', label: 'Window start', type: 'text', placeholder: '18:00', mono: true, visible: (v) => !!v.hasWindow, required: true },
    { key: 'shiftEnd', label: 'Window end', type: 'text', placeholder: '08:00', mono: true, visible: (v) => !!v.hasWindow, required: true },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'description', label: 'Notes', type: 'textarea', rows: 2, span: 2 },
    { key: 'participants', label: 'People in rotation', type: 'custom', section: 'Rotation order', span: 2, render: ({ value, onChange }) => <ParticipantsEditor value={(value as string[]) ?? []} onChange={onChange} options={engineerOpts} /> },
  ];

  const initial: Values = rota
    ? { ...rota, hasWindow: !!(rota.shiftStart && rota.shiftEnd), participants: rota.participants.map((p) => p.userId) }
    : { teamId: teamId ?? teams[0]?.id ?? '', name: 'Primary', rotation: 'weekly', rotationDays: 7, startDate: today(), handoffTime: '09:00', timezone: 'Asia/Kolkata', sortOrder: 0, hasWindow: false, shiftStart: '', shiftEnd: '', isActive: true, description: '', participants: [] };

  async function submit(v: Values) {
    const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!hm.test(String(v.handoffTime ?? ''))) throw new Error('The handoff time must be HH:mm');
    if (v.hasWindow && (!hm.test(String(v.shiftStart ?? '')) || !hm.test(String(v.shiftEnd ?? '')))) throw new Error('The window start and end must be HH:mm');
    const body: RotaBody = {
      teamId: String(v.teamId),
      name: String(v.name ?? '').trim(),
      description: (v.description as string) || null,
      timezone: String(v.timezone ?? 'Asia/Kolkata'),
      rotation: v.rotation as RotaBody['rotation'],
      rotationDays: Number(v.rotationDays ?? 7) || 7,
      handoffTime: String(v.handoffTime),
      shiftStart: v.hasWindow ? String(v.shiftStart) : null,
      shiftEnd: v.hasWindow ? String(v.shiftEnd) : null,
      startDate: String(v.startDate),
      sortOrder: Number(v.sortOrder ?? 0) || 0,
      isActive: !!v.isActive,
      participants: (v.participants as string[]) ?? [],
    };
    await save.mutateAsync(body);
  }

  return <FormDialog<Values> open={open} onClose={onClose} title={rota ? `Edit ${rota.name}` : 'New rota'} description="Who covers the team and when the shift hands over." fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" submitLabel={rota ? 'Save rota' : 'Create rota'} />;
}
