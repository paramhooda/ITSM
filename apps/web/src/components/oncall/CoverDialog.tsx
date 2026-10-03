import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Dialog, Button, Field, Select, Input, Textarea } from '@/components/ui';
import { errorMessage } from '@/components/admin/api';
import { useEngineers } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { oncallApi, oncallKeys, type Rota } from './api';

const toLocal = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Add cover (an override): a person covers a rota between two instants, whatever the rotation says. */
export function CoverDialog({ open, onClose, rotas, preset }: { open: boolean; onClose: () => void; rotas: Rota[]; preset?: { rotaId?: string; start?: Date; end?: Date } | null }) {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const me = useAuthStore((s) => s.user);
  const engineers = useEngineers();
  const manage = can('oncall:manage');
  const [rotaId, setRotaId] = useState('');
  const [userId, setUserId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!open) return;
    const now = new Date();
    const s = preset?.start ?? now;
    const e = preset?.end ?? new Date(s.getTime() + 24 * 3600_000);
    setRotaId(preset?.rotaId ?? rotas[0]?.id ?? '');
    setUserId(manage ? '' : (me?.id ?? ''));
    setStart(toLocal(s));
    setEnd(toLocal(e));
    setReason('');
  }, [open, preset, rotas, manage, me?.id]);
  const people = useMemo(() => {
    const all = (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name }));
    return manage ? all : all.filter((p) => p.value === me?.id);
  }, [engineers.data, manage, me?.id]);
  const save = useMutation({
    mutationFn: () => oncallApi.createOverride({ rotaId, userId, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), reason: reason.trim() || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: oncallKeys.all });
      toast.success('Cover added');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const valid = rotaId && userId && start && end && new Date(end) > new Date(start);
  return (
    <Dialog open={open} onClose={onClose} title="Add cover" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={!valid} loading={save.isPending}>Add cover</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Rota" required>
          <Select value={rotaId} onChange={(e) => setRotaId(e.target.value)} options={rotas.map((r) => ({ value: r.id, label: `${r.name}${r.teamName ? ` · ${r.teamName}` : ''}` }))} placeholder="Pick a rota" />
        </Field>
        <Field label="Who covers" required hint={manage ? undefined : 'You can add cover for yourself; managers can cover anyone.'}>
          <Select value={userId} onChange={(e) => setUserId(e.target.value)} options={people} placeholder="Pick a person" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" required><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Until" required><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <Field label="Reason">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-[60px]" placeholder="Swap with Priya, leave cover, …" />
        </Field>
      </div>
    </Dialog>
  );
}
