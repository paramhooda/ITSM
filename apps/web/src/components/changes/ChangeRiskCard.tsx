import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Gauge, AlertTriangle, Ban, CalendarClock, CheckCircle2 } from 'lucide-react';
import { Badge, Button, Select } from '@/components/ui';
import { Panel } from '@/components/tickets/Panel';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CHANGE_RISK_COLORS } from '@/lib/statusColors';
import type { ChangeDetails } from '@/components/tickets/types';
import { changesApi, changeKeys, type Conflict } from './api';

/** The clashes of a window, as a strip: shared systems, the same business service, blackout windows. */
export function ConflictList({ conflicts, className }: { conflicts: Conflict[]; className?: string }) {
  if (!conflicts.length) return null;
  return (
    <ul className={cn('flex flex-col gap-1.5', className)} data-testid="change-conflicts">
      {conflicts.map((c, i) => (
        <li key={i} className={cn('rounded-md border px-3 py-2 text-[12.5px] flex items-start gap-2', c.kind === 'blackout' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-900')}>
          {c.kind === 'blackout' ? <Ban className="h-3.5 w-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
          <span className="min-w-0">
            {c.text}
            {c.ticket && <> · <Link to={`/tickets/${c.ticket.id}?tab=plan`} className="font-mono underline underline-offset-2">{c.ticket.number}</Link> <span className="opacity-70">{fmtDateTime(c.ticket.start)} – {new Date(c.ticket.end).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span></>}
            {c.blackout && <span className="opacity-70"> · {fmtDateTime(c.blackout.start)} – {fmtDateTime(c.blackout.end)}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Risk and scheduling for a change: the questionnaire (answers scored into a level that also
 * sets the Risk field) and the conflicts of the current window. Shown above the change record.
 */
export function ChangeRiskCard({ ticketId, details, canEdit }: { ticketId: string; details: ChangeDetails | null; canEdit: boolean }) {
  const qc = useQueryClient();
  const questionnaire = useQuery({ queryKey: changeKeys.questionnaire, queryFn: changesApi.questionnaire, staleTime: 60_000 });
  const conflicts = useQuery({ queryKey: changeKeys.conflicts(ticketId), queryFn: () => changesApi.conflicts(ticketId), staleTime: 15_000 });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => setAnswers(details?.riskAnswers ?? {}), [details?.riskAnswers]);
  const assess = useMutation({
    mutationFn: () => changesApi.assessRisk(ticketId, answers),
    onSuccess: (r) => {
      toast.success(`Risk assessed: ${r.level} (${r.score}/100)`);
      void qc.invalidateQueries({ queryKey: ['tickets', ticketId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const questions = questionnaire.data?.questions ?? [];
  const thresholds = questionnaire.data?.thresholds;
  const dirty = JSON.stringify(answers) !== JSON.stringify(details?.riskAnswers ?? {});
  const answered = questions.filter((q) => answers[q.key]).length;
  const list = conflicts.data?.conflicts ?? [];
  return (
    <Panel
      title={<><Gauge className="h-4 w-4 text-subtle" /> Risk and scheduling</>}
      actions={
        details?.riskLevel ? (
          <span className="inline-flex items-center gap-2 text-[12px] text-muted">
            <Badge color={CHANGE_RISK_COLORS[details.riskLevel] ?? 'slate'}>{details.riskLevel} · {details.riskScore ?? 0}/100</Badge>
            {thresholds && <span className="hidden sm:inline">medium from {thresholds.medium}, high from {thresholds.high}</span>}
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <div className="text-[11.5px] font-semibold uppercase tracking-wide text-subtle mb-1.5 inline-flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5" /> Scheduling conflicts</div>
          {conflicts.isLoading ? (
            <div className="text-[12.5px] text-subtle">Checking the window…</div>
          ) : !conflicts.data?.window ? (
            <div className="text-[12.5px] text-subtle">No window scheduled yet; set the start and end below to check for clashes.</div>
          ) : list.length ? (
            <ConflictList conflicts={list} />
          ) : (
            <div className="text-[12.5px] text-emerald-700 inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> No clash with another change or a blackout window.</div>
          )}
        </div>
        <div>
          <div className="text-[11.5px] font-semibold uppercase tracking-wide text-subtle mb-1.5">Risk questionnaire</div>
          {questions.length === 0 ? (
            <div className="text-[12.5px] text-subtle">No risk questions are configured (Administration → Change risk questions).</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3" data-testid="risk-questionnaire">
              {questions.map((q) => (
                <label key={q.id} className="flex flex-col gap-1 text-[12.5px]">
                  <span className="text-muted">{q.question}{q.weight > 1 && <span className="text-subtle"> · ×{q.weight}</span>}</span>
                  <Select value={answers[q.key] ?? ''} disabled={!canEdit} onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}>
                    <option value="">—</option>
                    {q.options.map((o) => <option key={o.key} value={o.key}>{o.label} ({o.score})</option>)}
                  </Select>
                  {q.hint && <span className="text-[11.5px] text-subtle">{q.hint}</span>}
                </label>
              ))}
            </div>
          )}
          {questions.length > 0 && canEdit && (
            <div className="flex items-center gap-3 mt-3">
              <Button size="sm" loading={assess.isPending} disabled={!answered} onClick={() => assess.mutate()}>{details?.riskLevel ? 'Re-assess risk' : 'Assess risk'}</Button>
              <span className="text-[12px] text-subtle">{answered}/{questions.length} answered{dirty && details?.riskLevel ? ' · changed since the last assessment' : ''}</span>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
