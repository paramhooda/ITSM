import { useEffect, useState } from 'react';
import { Panel } from '../Panel';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Microscope, Save } from 'lucide-react';
import { Button, Field, Textarea, Checkbox, Badge } from '@/components/ui';
import { ticketsApi } from '../api';
import type { ProblemDetails } from '../types';

const FIELDS: { key: keyof ProblemDetails; label: string; wide?: boolean }[] = [
  { key: 'symptoms', label: 'Symptoms', wide: true },
  { key: 'impactSummary', label: 'Impact summary', wide: true },
  { key: 'investigation', label: 'Investigation', wide: true },
  { key: 'rootCause', label: 'Root cause' },
  { key: 'workaround', label: 'Workaround' },
  { key: 'permanentFix', label: 'Permanent fix', wide: true },
];

export function ProblemForm({ ticketId, details, canEdit }: { ticketId: string; details: ProblemDetails | null; canEdit: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Partial<ProblemDetails>>(details ?? {});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setF(details ?? {});
    setDirty(false);
  }, [details]);
  const save = useMutation({
    mutationFn: () => ticketsApi.problem(ticketId, { symptoms: f.symptoms ?? null, impactSummary: f.impactSummary ?? null, investigation: f.investigation ?? null, rootCause: f.rootCause ?? null, workaround: f.workaround ?? null, permanentFix: f.permanentFix ?? null, isKnownError: !!f.isKnownError }),
    onSuccess: () => {
      toast.success('Problem details saved');
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['tickets', ticketId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const set = (k: keyof ProblemDetails, v: unknown) => {
    setF((s) => ({ ...s, [k]: v }));
    setDirty(true);
  };
  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Microscope className="h-4 w-4 text-subtle" /> Problem record {f.isKnownError && <Badge color="orange">Known error</Badge>}</span>} actions={canEdit ? <Button size="sm" icon={<Save className="h-3.5 w-3.5" />} onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>Save</Button> : undefined}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIELDS.map((fd) => (
          <Field key={fd.key} label={fd.label} className={fd.wide ? 'sm:col-span-2' : undefined}>
            {canEdit ? <Textarea value={(f[fd.key] as string) ?? ''} onChange={(e) => set(fd.key, e.target.value)} className="min-h-[64px]" /> : <div className="text-[13px] whitespace-pre-wrap">{(f[fd.key] as string) || <span className="text-subtle">—</span>}</div>}
          </Field>
        ))}
        <div className="sm:col-span-2">
          <Checkbox checked={!!f.isKnownError} disabled={!canEdit} onChange={(e) => set('isKnownError', e.target.checked)} label="Known error (root cause identified, workaround documented)" />
        </div>
      </div>
    </Panel>
  );
}
