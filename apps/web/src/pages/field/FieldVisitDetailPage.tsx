import { useEffect, useState, lazy, Suspense } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, Play, CheckCircle2, Ban, RefreshCw, PenLine, FileText, ExternalLink, Pencil, Lock, Globe, ClipboardList, Package, MessageSquare, Clock, Ticket, Wrench, Paperclip, History } from 'lucide-react';
import { PageHeader, Button, Card, KeyValue, Badge, LoadingBlock, ErrorBlock, Dialog, Field, Input, Textarea, Select, Toggle, Avatar, ProgressBar, EmptyState, Checkbox } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useEngineers, useLookups } from '@/hooks/useLookups';
import { errorMessage } from '@/components/cmdb/hooks';
import { fmtDate, fmtDateTime, fmtDuration, fmtNumber, relativeTime, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fieldApi, fieldKeys, openVisitReport } from '@/components/field/api';
import { VisitStatusBadge, Rating } from '@/components/field/VisitStatusBadge';
import { VisitForm, toLocalInput, fromLocalInput } from '@/components/field/VisitForm';
import { CompleteVisitDialog } from '@/components/field/CompleteVisitDialog';
import { PartsTable } from '@/components/field/PartsTable';
import type { VisitDetail } from '@/components/field/types';

const AttachmentList = lazy(() => import('@/components/attachments/AttachmentList').then((m) => ({ default: m.AttachmentList ?? m.default })));
const AuditTrail = lazy(() => import('@/components/audit/AuditTrail').then((m) => ({ default: m.AuditTrail ?? m.default })));
const DOC_TYPES = [
  { value: 'photo', label: 'Photo' },
  { value: 'report', label: 'Report' },
  { value: 'signature', label: 'Signature' },
  { value: 'other', label: 'Other' },
];

type DialogKind = 'schedule' | 'reschedule' | 'cancel' | 'acknowledge' | 'complete' | 'edit' | null;

export default function FieldVisitDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const { data: visit, isLoading, error, refetch } = useQuery({ queryKey: fieldKeys.detail(id), queryFn: () => fieldApi.get(id), enabled: !!id });
  const [dialog, setDialog] = useState<DialogKind>(null);

  useEffect(() => {
    if (visit) setAssistantContext({ label: visit.number, entityType: 'field_visit', entityId: visit.id, customerId: visit.customerId });
    return () => setAssistantContext(null);
  }, [visit, setAssistantContext]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: fieldKeys.all });
    qc.invalidateQueries({ queryKey: ['pm'] });
  };
  const onDone = (msg: string) => () => {
    toast.success(msg);
    setDialog(null);
    invalidate();
  };
  const start = useMutation({ mutationFn: () => fieldApi.start(id), onSuccess: onDone('Visit started'), onError: (e) => toast.error(errorMessage(e)) });
  const report = useMutation({ mutationFn: () => fieldApi.generateReport(id), onSuccess: onDone('Report generated and attached'), onError: (e) => toast.error(errorMessage(e)) });

  if (isLoading) return <LoadingBlock />;
  if (error || !visit) return <ErrorBlock error={error} retry={() => refetch()} />;
  const p = visit.permissions;
  const canExec = p.canExecute || p.canManage;

  return (
    <div>
      <PageHeader
        breadcrumb={<Link to="/field" className="hover:underline">Field service</Link>}
        title={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <span className="font-mono text-brand-700 dark:text-brand-300">{visit.number}</span>
            <span>{visit.title}</span>
            <VisitStatusBadge status={visit.status} />
            {visit.typeLabel && <Badge color="slate">{visit.typeLabel}</Badge>}
            {visit.billable && <Badge color="amber">Billable</Badge>}
          </span>
        }
        subtitle={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <Link to={`/customers/${visit.customerId}`} className="hover:underline">{visit.customerName ?? 'Customer'}</Link>
            {visit.siteName && <span>· {visit.siteName}</span>}
            {visit.contractId && <span>· <Link to={`/contracts/${visit.contractId}`} className="hover:underline">{visit.contractNumber}</Link></span>}
            {visit.engineerName && <span className="inline-flex items-center gap-1">· <Avatar name={visit.engineerName} size="xs" /> {visit.engineerName}</span>}
            {visit.scheduledStart && <span className="text-subtle">· {fmtDateTime(visit.scheduledStart)}</span>}
          </span>
        }
        actions={
          <>
            {p.canSchedule && <Button size="sm" variant={visit.status === 'requested' ? 'primary' : 'outline'} icon={<CalendarClock className="h-4 w-4" />} onClick={() => setDialog('schedule')}>{visit.status === 'requested' ? 'Schedule' : 'Re-assign'}</Button>}
            {p.canStart && <Button size="sm" variant={visit.status === 'scheduled' ? 'primary' : 'outline'} icon={<Play className="h-4 w-4" />} onClick={() => start.mutate()} loading={start.isPending}>Start</Button>}
            {p.canComplete && <Button size="sm" variant={visit.status === 'in_progress' ? 'primary' : 'outline'} icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setDialog('complete')}>Complete</Button>}
            {p.canReschedule && <Button size="sm" variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={() => setDialog('reschedule')}>Reschedule</Button>}
            {p.canAcknowledge && <Button size="sm" variant="outline" icon={<PenLine className="h-4 w-4" />} onClick={() => setDialog('acknowledge')}>Acknowledge</Button>}
            {p.canReport && <Button size="sm" variant="outline" icon={<FileText className="h-4 w-4" />} onClick={() => report.mutate()} loading={report.isPending}>{visit.reportGeneratedAt ? 'Regenerate report' : 'Generate report'}</Button>}
            {(visit.status === 'completed' || visit.status === 'in_progress') && <Button size="sm" variant="ghost" icon={<ExternalLink className="h-4 w-4" />} onClick={() => openVisitReport(visit.id).catch((e) => toast.error(errorMessage(e)))}>Open report</Button>}
            {p.canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setDialog('edit')}>Edit</Button>}
            {p.canCancel && <Button size="sm" variant="ghost" className="text-red-600" icon={<Ban className="h-4 w-4" />} onClick={() => setDialog('cancel')}>Cancel</Button>}
          </>
        }
      />

      {visit.status === 'cancelled' && visit.cancelReason && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-500/10 dark:border-red-500/30 px-3 py-2 text-[13px] text-red-700 dark:text-red-300">Cancelled: {visit.cancelReason}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-3 items-start">
        <div className="flex flex-col gap-3 min-w-0">
          <Card title="Details">
            <KeyValue
              columns={3}
              items={[
                { label: 'Customer', value: <Link to={`/customers/${visit.customerId}`} className="hover:underline">{visit.customerName}</Link> },
                { label: 'Site', value: visit.siteName ?? '—' },
                { label: 'Service', value: visit.serviceName ?? '—' },
                { label: 'Engineer', value: visit.engineerName ? <span className="inline-flex items-center gap-1.5"><Avatar name={visit.engineerName} size="xs" />{visit.engineerName}</span> : <span className="text-subtle">Unassigned</span> },
                { label: 'Additional engineers', value: visit.additionalEngineers?.length ? visit.additionalEngineers.map((e) => e.name).join(', ') : '—' },
                { label: 'Team', value: visit.teamName ?? '—' },
                { label: 'Scheduled', value: visit.scheduledStart ? `${fmtDateTime(visit.scheduledStart)}${visit.scheduledEnd ? ` – ${fmtDateTime(visit.scheduledEnd)}` : ''}` : '—' },
                { label: 'Actual', value: visit.actualStart ? `${fmtDateTime(visit.actualStart)}${visit.actualEnd ? ` – ${fmtDateTime(visit.actualEnd)}` : ' (on site)'}` : '—' },
                { label: 'Requested by', value: visit.requestedByName ?? '—' },
                { label: 'Contract', value: visit.contractId ? <Link to={`/contracts/${visit.contractId}`} className="hover:underline">{visit.contractNumber} · {visit.contractName}</Link> : <span className="text-subtle">None</span> },
                { label: 'Entitlement', value: visit.entitlement ? `${visit.entitlement.name}${visit.consumption ? ' · consumed' : ''}` : <span className="text-subtle">Not metered</span> },
                { label: 'Created', value: <span title={fmtDateTime(visit.createdAt)}>{relativeTime(visit.createdAt)}</span> },
                { label: 'Purpose', value: visit.purpose ? <span className="whitespace-pre-wrap">{visit.purpose}</span> : '—', span: 3 },
              ]}
            />
          </Card>

          {(visit.workSummary || visit.findings || visit.recommendations) && (
            <Card title={<span className="inline-flex items-center gap-2"><Wrench className="h-4 w-4 text-subtle" />Work performed</span>}>
              <KeyValue columns={1} items={[{ label: 'Summary', value: <span className="whitespace-pre-wrap">{visit.workSummary ?? '—'}</span> }, { label: 'Findings', value: <span className="whitespace-pre-wrap">{visit.findings ?? '—'}</span> }, { label: 'Recommendations', value: <span className="whitespace-pre-wrap">{visit.recommendations ?? '—'}</span> }]} />
            </Card>
          )}

          <Card title={<span className="inline-flex items-center gap-2"><ClipboardList className="h-4 w-4 text-subtle" />Checklist <span className="text-subtle font-normal">{visit.checklist.filter((c) => c.done).length}/{visit.checklist.length}</span></span>} padded={false}>
            {visit.checklist.length === 0 ? (
              <EmptyState title="No checklist" description="Add checklist items when editing the visit." />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {visit.checklist.map((c, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                    <span className={cn('h-4 w-4 rounded border flex items-center justify-center text-[10px]', c.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-default')}>{c.done ? '✓' : ''}</span>
                    <span className={cn('flex-1', c.done && 'text-muted')}>{c.item}{c.required && <span className="text-red-500 ml-0.5">*</span>}</span>
                    {c.result && <Badge color={c.result === 'ok' ? 'green' : c.result === 'issue' ? 'red' : 'slate'}>{c.result.toUpperCase()}</Badge>}
                    {c.notes && <span className="text-[12px] text-muted truncate max-w-[260px]">{c.notes}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={<span className="inline-flex items-center gap-2"><Package className="h-4 w-4 text-subtle" />Parts used <span className="text-subtle font-normal">{visit.parts.length}</span></span>} padded={false}>
            <PartsTable visitId={visit.id} customerId={visit.customerId} parts={visit.parts} canEdit={!!p.canParts} />
          </Card>

          <NotesCard visit={visit} canNote={p.canNote} onChanged={invalidate} />

          <Card title={<span className="inline-flex items-center gap-2"><Clock className="h-4 w-4 text-subtle" />Time</span>}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[13px]">
              <div><div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Work</div><div className="text-lg font-semibold">{fmtDuration(visit.workMinutes)}</div></div>
              <div><div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Travel</div><div className="text-lg font-semibold">{fmtDuration(visit.travelMinutes)}</div></div>
              <div><div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Scheduled window</div><div className="text-lg font-semibold">{visit.scheduledStart && visit.scheduledEnd ? fmtDuration((new Date(visit.scheduledEnd).getTime() - new Date(visit.scheduledStart).getTime()) / 60_000) : '—'}</div></div>
              <div><div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Time entries</div><div className="text-lg font-semibold">{visit.timeEntries?.length ?? 0}</div></div>
            </div>
            {!!visit.timeEntries?.length && (
              <table className="table mt-3 [&_td]:py-1.5 [&_th]:py-1.5">
                <thead><tr><th>Engineer</th><th>Type</th><th>Minutes</th><th>Billable</th><th>Entitlement</th><th>Logged</th></tr></thead>
                <tbody>
                  {visit.timeEntries.map((t) => (
                    <tr key={t.id}><td>{t.userName ?? '—'}</td><td className="capitalize">{t.workType}</td><td className="tabular-nums">{t.minutes}</td><td>{t.billable ? 'Yes' : 'No'}</td><td>{t.consumptionId ? <Badge color="blue">hours consumed</Badge> : <span className="text-subtle">—</span>}</td><td className="text-muted">{relativeTime(t.createdAt)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <aside className="xl:sticky xl:top-4 flex flex-col gap-3 min-w-0">
          {visit.customerAckAt ? (
            <Card title={<span className="inline-flex items-center gap-2"><PenLine className="h-4 w-4 text-subtle" />Customer acknowledgement</span>}>
              <div className="text-[13px]"><strong>{visit.customerAckName}</strong>{visit.customerAckTitle ? `, ${visit.customerAckTitle}` : ''}</div>
              <div className="text-[12px] text-muted">{fmtDateTime(visit.customerAckAt)} · <Rating value={visit.customerRating} /></div>
              {visit.customerAckNotes && <div className="text-[12.5px] mt-1.5 whitespace-pre-wrap">{visit.customerAckNotes}</div>}
            </Card>
          ) : visit.status === 'completed' ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-200">Awaiting customer acknowledgement.</div>
          ) : null}

          <Card title={<span className="inline-flex items-center gap-2"><Ticket className="h-4 w-4 text-subtle" />Linked ticket</span>}>
            {visit.ticket ? (
              <Link to={`/tickets/${visit.ticket.id}`} className="block hover:underline">
                <div className="font-mono text-[12.5px] text-brand-700 dark:text-brand-300">{visit.ticket.number}</div>
                <div className="text-[13px] font-medium truncate">{visit.ticket.title}</div>
                <div className="text-[12px] text-muted inline-flex items-center gap-1.5 mt-1">{visit.ticket.status && <Badge color={visit.ticket.statusColor ?? 'slate'} dot>{visit.ticket.status}</Badge>}<span className="capitalize">{visit.ticket.type}</span>{visit.ticket.assigneeName && <span>· {visit.ticket.assigneeName}</span>}</div>
              </Link>
            ) : (
              <div className="text-[12.5px] text-subtle">No ticket linked.</div>
            )}
          </Card>

          {visit.pmOccurrence && (
            <Card title={<span className="inline-flex items-center gap-2"><Wrench className="h-4 w-4 text-subtle" />Preventive maintenance</span>}>
              <Link to={`/maintenance?tab=programs&program=${visit.pmOccurrence.programId}`} className="text-[13px] font-medium hover:underline">{visit.pmOccurrence.programName}</Link>
              <div className="text-[12px] text-muted mt-0.5">Planned {fmtDate(visit.pmOccurrence.plannedDate)}{visit.pmOccurrence.scheduledDate ? ` · scheduled ${fmtDate(visit.pmOccurrence.scheduledDate)}` : ''} · {titleCase(visit.pmOccurrence.frequency)}</div>
              <div className="mt-1"><Badge color={visit.pmOccurrence.status === 'completed' ? 'green' : visit.pmOccurrence.status === 'missed' ? 'red' : 'blue'} dot>{titleCase(visit.pmOccurrence.status)}</Badge></div>
            </Card>
          )}

          <Card title="Entitlement">
            {visit.entitlement ? (
              <div>
                <div className="flex items-center justify-between text-[12.5px]"><span className="font-medium">{visit.entitlement.name}</span><span className="tabular-nums text-muted">{fmtNumber(visit.entitlement.utilization.used, 1)} / {fmtNumber(visit.entitlement.utilization.quantity, 0)} {visit.entitlement.unit}</span></div>
                <ProgressBar pct={visit.entitlement.utilization.pct} className="mt-1.5" />
                <div className="flex items-center justify-between text-[11px] text-subtle mt-1"><span>{fmtDate(visit.entitlement.utilization.periodStart)} – {fmtDate(visit.entitlement.utilization.periodEnd)}</span><span>{visit.entitlement.utilization.exhausted ? 'Exhausted' : `${fmtNumber(visit.entitlement.utilization.remaining, 1)} left`}</span></div>
                {visit.consumption && <div className="text-[11.5px] text-muted mt-1.5">This visit consumed {visit.consumption.quantity} on {fmtDate(visit.consumption.consumedAt)}.</div>}
                <Link to={`/contracts/${visit.entitlement.contractId}?tab=entitlements`} className="text-[12px] text-brand-700 dark:text-brand-300 hover:underline mt-1 inline-block">Open contract</Link>
              </div>
            ) : (
              <div className="text-[12.5px] text-subtle">No entitlement linked: the visit is not metered against the contract.</div>
            )}
          </Card>

          <Card title={<span className="inline-flex items-center gap-2"><Paperclip className="h-4 w-4 text-subtle" />Attachments <span className="text-subtle font-normal">{visit.attachmentCount}</span></span>}>
            <Suspense fallback={<LoadingBlock />}>
              <AttachmentList entityType="field_visit" entityId={visit.id} customerId={visit.customerId} canUpload={canExec} canDelete={p.canManage} showVisibility compact docTypes={DOC_TYPES} />
            </Suspense>
          </Card>

          <Card title={<span className="inline-flex items-center gap-2"><History className="h-4 w-4 text-subtle" />History</span>}>
            <Suspense fallback={<LoadingBlock />}>
              <AuditTrail entityType="field_visit" entityId={visit.id} compact limit={30} />
            </Suspense>
          </Card>
        </aside>
      </div>

      <ScheduleDialog open={dialog === 'schedule'} visit={visit} onClose={() => setDialog(null)} onDone={onDone(visit.status === 'requested' ? 'Visit scheduled' : 'Visit updated')} />
      <RescheduleDialog open={dialog === 'reschedule'} visit={visit} onClose={() => setDialog(null)} onDone={onDone('Visit rescheduled')} />
      <ReasonDialog open={dialog === 'cancel'} title={`Cancel ${visit.number}`} label="Reason" confirmLabel="Cancel visit" onClose={() => setDialog(null)} action={(reason) => fieldApi.cancel(visit.id, reason)} onDone={onDone('Visit cancelled')} danger />
      <AcknowledgeDialog open={dialog === 'acknowledge'} visit={visit} onClose={() => setDialog(null)} onDone={onDone('Acknowledgement recorded')} />
      <CompleteVisitDialog open={dialog === 'complete'} visit={visit} onClose={() => setDialog(null)} onCompleted={() => { setDialog(null); invalidate(); }} />
      <VisitForm open={dialog === 'edit'} visit={visit} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); invalidate(); }} />
      {user && visit.status === 'requested' && !p.canSchedule && p.canExecute && <div className="hidden" />}
    </div>
  );
}

// ---------------------------------------------------------------- notes

function NotesCard({ visit, canNote, onChanged }: { visit: VisitDetail; canNote: boolean; onChanged: () => void }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const add = useMutation({
    mutationFn: () => fieldApi.addNote(visit.id, { body: body.trim(), isInternal: internal }),
    onSuccess: () => {
      setBody('');
      onChanged();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card title={<span className="inline-flex items-center gap-2"><MessageSquare className="h-4 w-4 text-subtle" />Notes <span className="text-subtle font-normal">{visit.notes.length}</span></span>} padded={false}>
      <ul className="divide-y divide-[var(--border)]">
        {visit.notes.length === 0 && <li className="px-4 py-3 text-[12.5px] text-subtle">No notes yet.</li>}
        {visit.notes.map((n) => (
          <li key={n.id} className={cn('px-4 py-2.5', n.isInternal && 'bg-amber-50/50 dark:bg-amber-500/5')}>
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <Avatar name={n.authorName} size="xs" />
              <span className="font-medium text-default">{n.authorName ?? 'Unknown'}</span>
              <span title={fmtDateTime(n.createdAt)}>{relativeTime(n.createdAt)}</span>
              {n.isInternal ? <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"><Lock className="h-3 w-3" />Internal</span> : <span className="inline-flex items-center gap-1"><Globe className="h-3 w-3" />Customer visible</span>}
            </div>
            <div className="text-[13px] mt-1 whitespace-pre-wrap">{n.body}</div>
          </li>
        ))}
      </ul>
      {canNote && (
        <div className="px-4 py-3 border-t border-default flex flex-col gap-2">
          <Textarea rows={2} placeholder={internal ? 'Internal work note (hidden from the customer)' : 'Note visible to the customer'} value={body} onChange={(e) => setBody(e.target.value)} className={cn(internal && 'border-amber-300')} />
          <div className="flex items-center justify-between gap-2">
            <Toggle checked={internal} onChange={setInternal} label={<span className="inline-flex items-center gap-1 text-[12.5px]">{internal ? <Lock className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}{internal ? 'Internal' : 'Customer visible'}</span>} />
            <Button size="sm" onClick={() => add.mutate()} loading={add.isPending} disabled={!body.trim()}>Add note</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- dialogs

function ScheduleDialog({ open, visit, onClose, onDone }: { open: boolean; visit: VisitDetail; onClose: () => void; onDone: () => void }) {
  const engineers = useEngineers();
  const { lookups } = useLookups();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [engineerId, setEngineerId] = useState('');
  const [teamId, setTeamId] = useState('');
  useEffect(() => {
    if (!open) return;
    const s = visit.scheduledStart ? new Date(visit.scheduledStart) : new Date(Date.now() + 86_400_000);
    if (!visit.scheduledStart) s.setHours(10, 0, 0, 0);
    setStart(toLocalInput(s.toISOString()));
    setEnd(toLocalInput(visit.scheduledEnd ?? new Date(s.getTime() + 2 * 3_600_000).toISOString()));
    setEngineerId(visit.engineerId ?? '');
    setTeamId(visit.teamId ?? '');
  }, [open, visit]);
  const m = useMutation({ mutationFn: () => fieldApi.schedule(visit.id, { scheduledStart: fromLocalInput(start), scheduledEnd: fromLocalInput(end), engineerId, teamId: teamId || null }), onSuccess: onDone, onError: (e) => toast.error(errorMessage(e)) });
  return (
    <Dialog open={open} onClose={onClose} title={`Schedule ${visit.number}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!start || !engineerId}>Schedule</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Start" required><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="End"><Input type="datetime-local" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
        <Field label="Engineer" required><Select value={engineerId} placeholder="Select engineer…" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} onChange={(e) => setEngineerId(e.target.value)} /></Field>
        <Field label="Team"><Select value={teamId} placeholder="No team" options={(lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(e) => setTeamId(e.target.value)} /></Field>
      </div>
      <div className="text-[12px] text-subtle mt-3">The engineer and the customer's primary / escalation contacts are notified.</div>
    </Dialog>
  );
}

function RescheduleDialog({ open, visit, onClose, onDone }: { open: boolean; visit: VisitDetail; onClose: () => void; onDone: () => void }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!open) return;
    setStart(toLocalInput(visit.scheduledStart));
    setEnd(toLocalInput(visit.scheduledEnd));
    setReason('');
  }, [open, visit]);
  const m = useMutation({ mutationFn: () => fieldApi.reschedule(visit.id, { scheduledStart: fromLocalInput(start), scheduledEnd: fromLocalInput(end), reason: reason.trim() }), onSuccess: onDone, onError: (e) => toast.error(errorMessage(e)) });
  return (
    <Dialog open={open} onClose={onClose} title={`Reschedule ${visit.number}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!start || !reason.trim()}>Reschedule</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="New start" required><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="New end"><Input type="datetime-local" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
        <Field label="Reason" required className="sm:col-span-2"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      </div>
    </Dialog>
  );
}

function AcknowledgeDialog({ open, visit, onClose, onDone }: { open: boolean; visit: VisitDetail; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [rating, setRating] = useState(0);
  useEffect(() => {
    if (open) {
      setName('');
      setTitle('');
      setNotes('');
      setRating(0);
    }
  }, [open]);
  const m = useMutation({ mutationFn: () => fieldApi.acknowledge(visit.id, { name: name.trim(), title: title.trim() || null, notes: notes.trim() || null, rating: rating || null }), onSuccess: onDone, onError: (e) => toast.error(errorMessage(e)) });
  return (
    <Dialog open={open} onClose={onClose} title={`Customer acknowledgement · ${visit.number}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!name.trim()}>Record acknowledgement</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" required><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer representative" /></Field>
        <Field label="Title / role"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Rating" className="sm:col-span-2">
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" onClick={() => setRating(n === rating ? 0 : n)} className={cn('text-2xl leading-none', n <= rating ? 'text-amber-500' : 'text-subtle hover:text-amber-400')} aria-label={`${n} star${n > 1 ? 's' : ''}`}>★</button>
            ))}
            <span className="text-[12px] text-subtle ml-2">{rating ? `${rating}/5` : 'optional'}</span>
          </div>
        </Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Customer remarks" /></Field>
      </div>
    </Dialog>
  );
}

export function ReasonDialog({ open, title, label, confirmLabel, onClose, action, onDone, danger }: { open: boolean; title: string; label: string; confirmLabel: string; onClose: () => void; action: (reason: string) => Promise<unknown>; onDone: () => void; danger?: boolean }) {
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  useEffect(() => {
    if (open) {
      setReason('');
      setAck(false);
    }
  }, [open]);
  const m = useMutation({ mutationFn: () => action(reason.trim()), onSuccess: onDone, onError: (e) => toast.error(errorMessage(e)) });
  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-md" footer={<><Button variant="ghost" onClick={onClose}>Back</Button><Button variant={danger ? 'danger' : 'primary'} onClick={() => m.mutate()} loading={m.isPending} disabled={!reason.trim() || (danger && !ack)}>{confirmLabel}</Button></>}>
      <Field label={label} required><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      {danger && <div className="mt-3"><Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} label="I understand this cannot be undone" /></div>}
    </Dialog>
  );
}
