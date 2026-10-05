import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../Panel';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Microscope, Save, Globe, Send, Bug } from 'lucide-react';
import { Button, Field, Textarea, Checkbox, Badge, Select } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { aiApi, aiQk } from '@/components/ai/api';
import { kedbApi, kedbKeys, KE_STATUS_OPTIONS } from '@/components/known-errors/api';
import { KeStatusBadge } from '@/components/known-errors/KeStatusBadge';
import { FixChangePicker, type FixChangeRef } from '@/components/known-errors/FixChangePicker';
import { PublishDialog } from '@/components/known-errors/PublishDialog';
import { ticketsApi } from '../api';
import type { ProblemDetails } from '../types';
import { fmtDate } from '@/lib/format';

const FIELDS: { key: keyof ProblemDetails; label: string; wide?: boolean }[] = [
  { key: 'symptoms', label: 'Symptoms', wide: true },
  { key: 'impactSummary', label: 'Impact summary', wide: true },
  { key: 'investigation', label: 'Investigation', wide: true },
  { key: 'rootCause', label: 'Root cause' },
  { key: 'workaround', label: 'Workaround' },
  { key: 'permanentFix', label: 'Permanent fix', wide: true },
];

/**
 * Problem analysis: the problem record fields, the known-error flag and, once flagged, the known error
 * database fields (lifecycle status, the permanent-fix change, the customer-facing wording) and publication.
 */
export function ProblemForm({ ticketId, ticketNumber, ticketTitle, customerId, customerName, details, canEdit, canPublish }: { ticketId: string; ticketNumber?: string; ticketTitle?: string; customerId: string; customerName?: string | null; details: ProblemDetails | null; canEdit: boolean; canPublish?: boolean }) {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const [f, setF] = useState<Partial<ProblemDetails>>(details ?? {});
  const [fixChange, setFixChange] = useState<FixChangeRef | null>(null);
  const [fixDirty, setFixDirty] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const flagged = !!details?.isKnownError;
  // The known error entry (fix change number, publication) is read from the database once the problem is flagged.
  const ke = useQuery({ queryKey: kedbKeys.detail(ticketId), queryFn: () => kedbApi.get(ticketId), enabled: flagged && (can('kedb:read') || can('problems:manage')), retry: false });
  const aiOn = can('ai:use');
  const aiStatus = useQuery({ queryKey: aiQk.status, queryFn: aiApi.status, staleTime: 60_000, retry: false, enabled: aiOn && flagged && !!canPublish });
  const canDraft = aiOn && (aiStatus.data?.features ?? []).includes('kedb_draft');
  useEffect(() => {
    setF(details ?? {});
    setDirty(false);
  }, [details]);
  useEffect(() => {
    if (ke.data) {
      setFixChange(ke.data.fixChange ? { id: ke.data.fixChange.id, number: ke.data.fixChange.number, title: ke.data.fixChange.title } : null);
      setFixDirty(false);
    }
  }, [ke.data]);
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { symptoms: f.symptoms ?? null, impactSummary: f.impactSummary ?? null, investigation: f.investigation ?? null, rootCause: f.rootCause ?? null, workaround: f.workaround ?? null, permanentFix: f.permanentFix ?? null, isKnownError: !!f.isKnownError };
      if (f.isKnownError) {
        if (f.keStatus) body.keStatus = f.keStatus;
        body.customerSummary = f.customerSummary ?? null;
        body.customerWorkaround = f.customerWorkaround ?? null;
        if (fixDirty) body.fixChangeId = fixChange?.id ?? null;
      }
      return ticketsApi.problem(ticketId, body);
    },
    onSuccess: () => {
      toast.success('Problem details saved');
      setDirty(false);
      setFixDirty(false);
      qc.invalidateQueries({ queryKey: ['tickets', ticketId] });
      qc.invalidateQueries({ queryKey: ['known-errors'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const set = (k: keyof ProblemDetails, v: unknown) => {
    setF((s) => ({ ...s, [k]: v }));
    setDirty(true);
  };
  const published = !!(ke.data?.portalVisible ?? details?.portalVisible);
  // A retired entry never reaches the portal, so there is nothing to publish until it is reopened.
  const publishable = flagged && !!canPublish && (details?.keStatus ?? 'open') !== 'retired';
  return (
    <>
      <Panel
        title={<span className="inline-flex items-center gap-2"><Microscope className="h-4 w-4 text-subtle" /> Problem record {flagged && <Badge color="orange" className="gap-1"><Bug className="h-3 w-3" /> Known error</Badge>}{flagged && published && <Badge color="green" className="gap-1"><Globe className="h-3 w-3" /> Published</Badge>}</span>}
        actions={
          <span className="inline-flex items-center gap-1.5">
            {publishable && (
              <Button size="sm" variant="outline" icon={published ? <Globe className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />} onClick={() => setPublishOpen(true)}>
                {published ? 'Update portal wording' : 'Publish to portal'}
              </Button>
            )}
            {canEdit && (
              <Button size="sm" icon={<Save className="h-3.5 w-3.5" />} onClick={() => save.mutate()} disabled={!dirty && !fixDirty} loading={save.isPending}>
                Save
              </Button>
            )}
          </span>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {FIELDS.map((fd) => (
            <Field key={fd.key} label={fd.label} className={fd.wide ? 'sm:col-span-2' : undefined}>
              {canEdit ? <Textarea value={(f[fd.key] as string) ?? ''} onChange={(e) => set(fd.key, e.target.value)} className="min-h-[64px]" /> : <div className="text-[13px] whitespace-pre-wrap">{(f[fd.key] as string) || <span className="text-subtle">—</span>}</div>}
            </Field>
          ))}
          <div className="sm:col-span-2">
            <Checkbox checked={!!f.isKnownError} disabled={!canEdit} onChange={(e) => set('isKnownError', e.target.checked)} label="Known error (root cause identified, workaround documented)" />
          </div>
          {f.isKnownError && (
            <>
              <div className="sm:col-span-2 border-t border-default pt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                <Bug className="h-3.5 w-3.5 text-orange-500" />
                <span>Known error database entry</span>
                {flagged && (
                  <>
                    <KeStatusBadge status={details?.keStatus ?? 'open'} className="py-0" />
                    {details?.keIdentifiedAt && <span>· identified {fmtDate(details.keIdentifiedAt)}</span>}
                    <Link to={`/knowledge/known-errors/${ticketId}`} className="text-brand-700 hover:underline ml-auto">Open in the known error database</Link>
                  </>
                )}
                {!flagged && <span>· saved with the record; incidents are matched against it from then on</span>}
              </div>
              <Field label="Known-error status" hint="Open until a fix is under way; resolved when the fix change is implemented">
                {canEdit ? <Select value={f.keStatus ?? 'open'} onChange={(e) => set('keStatus', e.target.value)} options={KE_STATUS_OPTIONS} /> : <KeStatusBadge status={f.keStatus ?? 'open'} />}
              </Field>
              <Field label="Permanent fix change" hint={flagged ? 'A change of the same customer; the known error resolves when it is implemented' : 'Set after saving the flag'}>
                {flagged ? (
                  ke.isError ? (
                    <span className="text-[12.5px] text-subtle">Not available</span>
                  ) : (
                    <FixChangePicker
                      customerId={customerId}
                      value={fixChange}
                      disabled={!canEdit}
                      onChange={(v) => {
                        setFixChange(v);
                        setFixDirty(true);
                      }}
                    />
                  )
                ) : (
                  <span className="text-[12.5px] text-subtle">—</span>
                )}
              </Field>
              <Field label="Customer summary" hint="What customers notice; shown in the portal once published" className="sm:col-span-2">
                {canEdit ? <Textarea value={f.customerSummary ?? ''} onChange={(e) => set('customerSummary', e.target.value)} className="min-h-[56px]" placeholder="Plain words, no hostnames or vendor references" /> : <div className="text-[13px] whitespace-pre-wrap">{f.customerSummary || <span className="text-subtle">—</span>}</div>}
              </Field>
              <Field label="Customer workaround" hint="What customers can do in the meantime; shown in the portal once published" className="sm:col-span-2">
                {canEdit ? <Textarea value={f.customerWorkaround ?? ''} onChange={(e) => set('customerWorkaround', e.target.value)} className="min-h-[56px]" /> : <div className="text-[13px] whitespace-pre-wrap">{f.customerWorkaround || <span className="text-subtle">—</span>}</div>}
              </Field>
            </>
          )}
        </div>
      </Panel>
      {publishable && (
        <PublishDialog
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
          target={{ id: ticketId, number: ticketNumber ?? '', title: ticketTitle ?? '', customerName: customerName ?? null, customerSummary: f.customerSummary ?? details?.customerSummary ?? null, customerWorkaround: f.customerWorkaround ?? details?.customerWorkaround ?? null, portalVisible: published }}
          canDraft={canDraft}
        />
      )}
    </>
  );
}
