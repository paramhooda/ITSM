import { useEffect, useMemo, useState, lazy, Suspense, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, Play, CheckCircle2, Ban, RefreshCw, PenLine, FileText, ExternalLink, Pencil, UserCog, MessageSquare, Info, Ticket, Wrench, Gauge, ClipboardList } from 'lucide-react';
import { Button, Badge, LoadingBlock, ErrorBlock, Dialog, Field, Input, Textarea, Select, Avatar, ProgressBar, EmptyState, Checkbox } from '@/components/ui';
import type { MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RelatedTabs, ActivityStream, RailTabs, RailCard, RailRows, useAuditStream, type FormSection, type StreamEntry } from '@/components/record';
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
import type { VisitDetail, VisitNote } from '@/components/field/types';

const AttachmentList = lazy(() => import('@/components/attachments/AttachmentList').then((m) => ({ default: m.AttachmentList ?? m.default })));
const DOC_TYPES = [
  { value: 'photo', label: 'Photo' },
  { value: 'report', label: 'Report' },
  { value: 'signature', label: 'Signature' },
  { value: 'other', label: 'Other' },
];

type DialogKind = 'schedule' | 'reschedule' | 'cancel' | 'acknowledge' | 'complete' | 'edit' | null;

interface Action {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  loading?: boolean;
  danger?: boolean;
}

const minutesBetween = (a: string, b: string | Date) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000));

/** Visit notes in stream shape: customer-visible notes as comments, internal ones as work notes. */
const fromNote = (n: VisitNote): StreamEntry => ({ id: n.id, at: n.createdAt, actor: n.authorName, kind: n.isInternal ? 'note' : 'comment', body: n.body, internal: n.isInternal });

export default function FieldVisitDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const { data: visit, isLoading, error, refetch } = useQuery({ queryKey: fieldKeys.detail(id), queryFn: () => fieldApi.get(id), enabled: !!id });
  const audit = useAuditStream('field_visit', id);
  const [dialog, setDialog] = useState<DialogKind>(null);

  useEffect(() => {
    if (visit) setAssistantContext({ label: visit.number, entityType: 'field_visit', entityId: visit.id, customerId: visit.customerId });
    return () => setAssistantContext(null);
  }, [visit, setAssistantContext]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: fieldKeys.all });
    qc.invalidateQueries({ queryKey: ['pm'] });
    qc.invalidateQueries({ queryKey: ['audit', 'entity', 'field_visit', id] });
  };
  const onDone = (msg: string) => () => {
    toast.success(msg);
    setDialog(null);
    invalidate();
  };
  const start = useMutation({ mutationFn: () => fieldApi.start(id), onSuccess: onDone('Visit started'), onError: (e) => toast.error(errorMessage(e)) });
  const report = useMutation({ mutationFn: () => fieldApi.generateReport(id), onSuccess: onDone('Report generated and attached'), onError: (e) => toast.error(errorMessage(e)) });
  const addNote = useMutation({ mutationFn: (input: { body: string; isInternal: boolean }) => fieldApi.addNote(id, input), onSuccess: invalidate, onError: (e) => toast.error(errorMessage(e)) });

  const entries = useMemo<StreamEntry[]>(() => [...(visit?.notes ?? []).map(fromNote), ...audit.entries], [visit?.notes, audit.entries]);

  if (isLoading) return <LoadingBlock />;
  if (error || !visit) return <ErrorBlock error={error} retry={() => refetch()} />;
  const p = visit.permissions;
  const canExec = p.canExecute || p.canManage;
  const st = visit.status;
  const canOpenReport = st === 'completed' || st === 'in_progress';

  // ---- header actions: the next step(s) for this state up front, everything else in the overflow menu
  const stateActions: Action[] = [
    ...(p.canSchedule && st === 'requested' ? [{ key: 'schedule', label: 'Schedule', icon: <CalendarClock className="h-3.5 w-3.5" />, onClick: () => setDialog('schedule') }] : []),
    ...(p.canStart ? [{ key: 'start', label: 'Start', icon: <Play className="h-3.5 w-3.5" />, onClick: () => start.mutate(), loading: start.isPending }] : []),
    ...(p.canComplete ? [{ key: 'complete', label: 'Complete', icon: <CheckCircle2 className="h-3.5 w-3.5" />, onClick: () => setDialog('complete') }] : []),
    ...(p.canAcknowledge ? [{ key: 'acknowledge', label: 'Acknowledge', icon: <PenLine className="h-3.5 w-3.5" />, onClick: () => setDialog('acknowledge') }] : []),
    ...(p.canReport ? [{ key: 'report', label: visit.reportGeneratedAt ? 'Regenerate report' : 'Generate report', icon: <FileText className="h-3.5 w-3.5" />, onClick: () => report.mutate(), loading: report.isPending }] : []),
  ];
  const primaryActions = stateActions.slice(0, 2);
  const otherActions: Action[] = [
    ...stateActions.slice(2),
    ...(p.canSchedule && st !== 'requested' ? [{ key: 'reassign', label: 'Re-assign engineer', icon: <UserCog className="h-4 w-4" />, onClick: () => setDialog('schedule') }] : []),
    ...(p.canReschedule ? [{ key: 'reschedule', label: 'Reschedule', icon: <RefreshCw className="h-4 w-4" />, onClick: () => setDialog('reschedule') }] : []),
    ...(canOpenReport ? [{ key: 'open-report', label: 'Open report', icon: <ExternalLink className="h-4 w-4" />, onClick: () => openVisitReport(visit.id).catch((e) => toast.error(errorMessage(e))) }] : []),
    ...(p.canEdit ? [{ key: 'edit', label: 'Edit visit', icon: <Pencil className="h-4 w-4" />, onClick: () => setDialog('edit') }] : []),
    ...(p.canCancel ? [{ key: 'cancel', label: 'Cancel visit', icon: <Ban className="h-4 w-4" />, onClick: () => setDialog('cancel'), danger: true }] : []),
  ];
  const menu: MenuItem[] = otherActions.map((a) => ({ label: a.label, icon: a.icon, onClick: a.onClick, danger: a.danger, disabled: a.loading }));
  const primary = (
    <>
      {primaryActions.map((a, i) => (
        <Button key={a.key} size="sm" variant={i === 0 ? 'primary' : 'outline'} icon={a.icon} onClick={a.onClick} loading={a.loading}>{a.label}</Button>
      ))}
    </>
  );

  // ---- state line under the title
  const controls = (
    <>
      <VisitStatusBadge status={st} />
      {st === 'completed' && !visit.customerAckAt && <Badge color="amber">Awaiting acknowledgement</Badge>}
      {visit.customerAckAt && <Badge color="green" className="gap-1"><PenLine className="h-3 w-3" /> Acknowledged</Badge>}
      {visit.reportGeneratedAt && <Badge color="slate">Report {relativeTime(visit.reportGeneratedAt)}</Badge>}
      {st === 'cancelled' && visit.cancelReason && <span className="text-[12.5px] text-red-700 truncate max-w-[480px]" title={visit.cancelReason}>Cancelled · {visit.cancelReason}</span>}
    </>
  );

  // ---- form
  const person = (name: string | null | undefined) => (name ? <span className="inline-flex items-center gap-1.5"><Avatar name={name} size="xs" /> {name}</span> : null);
  const window_ = (a: string | null, b: string | null, openLabel?: string) => (a ? `${fmtDateTime(a)}${b ? ` – ${fmtDateTime(b)}` : openLabel ? ` (${openLabel})` : ''}` : null);
  const sections: FormSection[] = [
    {
      key: 'visit',
      title: 'Visit',
      fields: [
        { label: 'Customer', value: <Link to={`/customers/${visit.customerId}`} className="hover:underline">{visit.customerName ?? 'Customer'}</Link> },
        { label: 'Site', value: visit.siteName },
        { label: 'Type', value: visit.typeLabel },
        { label: 'Service', value: visit.serviceName },
        { label: 'Scheduled', value: window_(visit.scheduledStart, visit.scheduledEnd) },
        { label: 'Actual', value: window_(visit.actualStart, visit.actualEnd, 'on site'), hidden: !visit.actualStart },
        { label: 'Engineer', value: person(visit.engineerName) ?? <span className="text-amber-700">Unassigned</span> },
        { label: 'Also attending', value: visit.additionalEngineers?.length ? visit.additionalEngineers.map((e) => e.name).join(', ') : null, hidden: !visit.additionalEngineers?.length },
        { label: 'Team', value: visit.teamName },
        { label: 'Requested by', value: visit.requestedByName },
        { label: 'Ticket', value: visit.ticket ? <Link to={`/tickets/${visit.ticket.id}`} className="hover:underline"><span className="font-mono text-[12.5px] text-brand-700">{visit.ticket.number}</span> · {visit.ticket.title}</Link> : null },
        { label: 'Contract', value: visit.contractId ? <Link to={`/contracts/${visit.contractId}`} className="hover:underline">{visit.contractNumber} · {visit.contractName}</Link> : null },
        { label: 'PM program', value: visit.pmOccurrence ? <Link to={`/maintenance?tab=programs&program=${visit.pmOccurrence.programId}`} className="hover:underline">{visit.pmOccurrence.programName}</Link> : visit.pmProgramName, hidden: !visit.pmOccurrence && !visit.pmProgramName },
        { label: 'Billable', value: visit.billable ? 'Yes' : 'No' },
        { label: 'Cancel reason', value: visit.cancelReason ?? '', kind: 'prose', span: 2, hidden: st !== 'cancelled' || !visit.cancelReason },
      ],
    },
    {
      key: 'work',
      title: 'Work performed',
      columns: 1,
      fields: [
        { label: 'Purpose', value: visit.purpose ?? '', kind: 'prose' },
        { label: 'Summary', value: visit.workSummary ?? '', kind: 'prose', hidden: !visit.workSummary && st !== 'completed' },
        { label: 'Findings', value: visit.findings ?? '', kind: 'prose', hidden: !visit.findings && st !== 'completed' },
        { label: 'Recommendations', value: visit.recommendations ?? '', kind: 'prose', hidden: !visit.recommendations && st !== 'completed' },
      ],
    },
  ];

  // ---- related lists
  const done = visit.checklist.filter((c) => c.done).length;
  const timeEntries = visit.timeEntries ?? [];
  const tabs = [
    {
      key: 'checklist',
      label: 'Checklist',
      count: visit.checklist.length,
      content: (
        <section className="card">
          {visit.checklist.length === 0 ? (
            <EmptyState icon={<ClipboardList className="h-5 w-5" />} title="No checklist" description="Checklist items are added when editing the visit." action={p.canEdit ? <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setDialog('edit')}>Edit visit</Button> : undefined} />
          ) : (
            <>
              <div className="px-4 py-2 border-b border-default text-[12.5px] text-muted">{done} of {visit.checklist.length} done</div>
              <ul className="divide-y divide-[var(--border)]">
                {visit.checklist.map((c, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                    <span className={cn('h-4 w-4 rounded border flex items-center justify-center text-[10px]', c.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-default')}>{c.done ? '✓' : ''}</span>
                    <span className={cn('flex-1', c.done && 'text-muted')}>{c.item}{c.required && <span className="text-red-500 ml-0.5">*</span>}</span>
                    {c.result && <Badge color={c.result === 'ok' ? 'green' : c.result === 'issue' ? 'red' : 'slate'}>{c.result.toUpperCase()}</Badge>}
                    {c.notes && <span className="text-[12px] text-muted truncate max-w-[260px]" title={c.notes}>{c.notes}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ),
    },
    { key: 'parts', label: 'Parts', count: visit.parts.length, content: <section className="card"><PartsTable visitId={visit.id} customerId={visit.customerId} parts={visit.parts} canEdit={!!p.canParts} /></section> },
    {
      key: 'time',
      label: 'Time',
      count: timeEntries.length,
      content: (
        <section className="card">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 py-3 border-b border-default">
            {[
              { label: 'Work', value: fmtDuration(visit.workMinutes) },
              { label: 'Travel', value: fmtDuration(visit.travelMinutes) },
              { label: 'Scheduled window', value: visit.scheduledStart && visit.scheduledEnd ? fmtDuration(minutesBetween(visit.scheduledStart, visit.scheduledEnd)) : '—' },
              { label: 'Entries', value: String(timeEntries.length) },
            ].map((s) => (
              <div key={s.label} className="min-w-0"><div className="text-[11.5px] text-muted truncate">{s.label}</div><div className="text-[15px] font-semibold tnum">{s.value}</div></div>
            ))}
          </div>
          {timeEntries.length === 0 ? (
            <EmptyState title="No time logged" description="Time is recorded when the visit is completed." />
          ) : (
            <div className="overflow-auto">
              <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
                <thead><tr><th>Engineer</th><th>Type</th><th>Minutes</th><th>Billable</th><th>Entitlement</th><th>Logged</th></tr></thead>
                <tbody>
                  {timeEntries.map((t) => (
                    <tr key={t.id}><td>{t.userName ?? '—'}</td><td className="capitalize">{t.workType}</td><td className="tnum">{t.minutes}</td><td>{t.billable ? 'Yes' : 'No'}</td><td>{t.consumptionId ? <Badge color="blue">hours consumed</Badge> : <span className="text-subtle">—</span>}</td><td className="text-muted">{relativeTime(t.createdAt)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ),
    },
    {
      key: 'attachments',
      label: 'Attachments',
      count: visit.attachmentCount,
      content: (
        <section className="card px-4 py-3">
          <Suspense fallback={<LoadingBlock />}>
            <AttachmentList entityType="field_visit" entityId={visit.id} customerId={visit.customerId} canUpload={canExec} canDelete={p.canManage} showVisibility compact docTypes={DOC_TYPES} />
          </Suspense>
        </section>
      ),
    },
  ];

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Field service', to: '/field' }, { label: visit.number }]}
            number={visit.number}
            title={visit.title}
            badges={
              <>
                {visit.typeLabel && <Badge color="slate">{visit.typeLabel}</Badge>}
                {visit.billable && <Badge color="amber">Billable</Badge>}
              </>
            }
            controls={controls}
            primary={primary}
            menu={menu}
            createdAt={visit.createdAt}
            createdBy={visit.requestedByName ?? null}
            updatedAt={visit.updatedAt}
          >
            <RecordRibbon items={glance(visit)} columns={5} />
          </RecordHeader>
        }
        main={
          <>
            <RecordForm sections={sections} />
            <RelatedTabs tabs={tabs} />
          </>
        }
        aside={
          <RailTabs
            tabs={[
              {
                key: 'activity',
                label: 'Activity',
                icon: MessageSquare,
                badge: entries.length,
                content: (
                  <ActivityStream
                    entries={entries}
                    loading={audit.isLoading}
                    maxHeight="calc(100vh - 220px)"
                    composer={p.canNote ? { canComment: true, canWorkNote: true, submitting: addNote.isPending, onSubmit: (v) => addNote.mutateAsync({ body: v.body, isInternal: v.kind === 'work_note' }), placeholder: 'Add a note…' } : undefined}
                  />
                ),
              },
              { key: 'details', label: 'Details', icon: Info, content: <VisitDetailsRail visit={visit} onAcknowledge={p.canAcknowledge ? () => setDialog('acknowledge') : undefined} /> },
            ]}
          />
        }
      />

      <ScheduleDialog open={dialog === 'schedule'} visit={visit} onClose={() => setDialog(null)} onDone={onDone(visit.status === 'requested' ? 'Visit scheduled' : 'Visit updated')} />
      <RescheduleDialog open={dialog === 'reschedule'} visit={visit} onClose={() => setDialog(null)} onDone={onDone('Visit rescheduled')} />
      <ReasonDialog open={dialog === 'cancel'} title={`Cancel ${visit.number}`} label="Reason" confirmLabel="Cancel visit" onClose={() => setDialog(null)} action={(reason) => fieldApi.cancel(visit.id, reason)} onDone={onDone('Visit cancelled')} danger />
      <AcknowledgeDialog open={dialog === 'acknowledge'} visit={visit} onClose={() => setDialog(null)} onDone={onDone('Acknowledgement recorded')} />
      <CompleteVisitDialog open={dialog === 'complete'} visit={visit} onClose={() => setDialog(null)} onCompleted={() => { setDialog(null); invalidate(); }} />
      <VisitForm open={dialog === 'edit'} visit={visit} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); invalidate(); }} />
    </>
  );
}

// ---------------------------------------------------------------- at a glance

/** The numbers a dispatcher checks first: when, how long on site, parts, the entitlement meter, sign-off. */
function glance(visit: VisitDetail): { label: string; value: string; tone?: 'good' | 'warn' | 'bad'; hint?: string }[] {
  const now = new Date();
  const onSite = visit.workMinutes ?? (visit.actualStart ? minutesBetween(visit.actualStart, visit.actualEnd ?? now) : null);
  const overdue = visit.status === 'scheduled' && visit.scheduledStart && new Date(visit.scheduledStart) < now;
  const qty = visit.parts.reduce((n, p) => n + (p.quantity ?? 0), 0);
  const ent = visit.entitlement;
  return [
    { label: 'Scheduled', value: visit.scheduledStart ? relativeTime(visit.scheduledStart) : visit.status === 'requested' ? 'not yet' : '—', tone: overdue ? 'warn' : undefined, hint: visit.scheduledStart ? fmtDateTime(visit.scheduledStart) : undefined },
    { label: visit.actualStart && !visit.actualEnd ? 'On site for' : 'Time on site', value: onSite === null ? '—' : fmtDuration(onSite), hint: visit.travelMinutes ? `Travel ${fmtDuration(visit.travelMinutes)}` : undefined },
    { label: 'Parts used', value: visit.parts.length ? `${visit.parts.length} line${visit.parts.length === 1 ? '' : 's'}` : 'none', hint: qty ? `${qty} items` : undefined },
    ent
      ? { label: `Entitlement · ${ent.unit}`, value: `${fmtNumber(ent.utilization.used, 1)} / ${fmtNumber(ent.utilization.quantity, 0)}`, tone: ent.utilization.exhausted ? 'bad' : ent.utilization.overThreshold ? 'warn' : 'good', hint: `${ent.name} · ${ent.utilization.exhausted ? 'exhausted' : `${fmtNumber(ent.utilization.remaining, 1)} remaining`}` }
      : { label: 'Entitlement', value: 'not metered' },
    visit.customerAckAt
      ? { label: 'Acknowledged', value: visit.customerRating ? `${'★'.repeat(visit.customerRating)}` : 'signed', tone: 'good', hint: `${visit.customerAckName ?? ''} · ${fmtDateTime(visit.customerAckAt)}` }
      : { label: 'Acknowledgement', value: visit.status === 'completed' ? 'awaiting' : '—', tone: visit.status === 'completed' ? 'warn' : undefined },
  ];
}

// ---------------------------------------------------------------- rail · details

function VisitDetailsRail({ visit, onAcknowledge }: { visit: VisitDetail; onAcknowledge?: () => void }) {
  const ent = visit.entitlement;
  return (
    <>
      {(visit.customerAckAt || visit.status === 'completed') && (
        <RailCard title={<><PenLine className="h-3.5 w-3.5 text-subtle" /> Customer acknowledgement</>} action={!visit.customerAckAt && onAcknowledge ? <button onClick={onAcknowledge} className="text-[12px] text-brand-700 hover:underline">Record</button> : undefined}>
          {visit.customerAckAt ? (
            <>
              <RailRows rows={[{ label: 'Signed by', value: `${visit.customerAckName ?? ''}${visit.customerAckTitle ? `, ${visit.customerAckTitle}` : ''}` }, { label: 'When', value: fmtDateTime(visit.customerAckAt) }, { label: 'Rating', value: <Rating value={visit.customerRating} /> }]} />
              {visit.customerAckNotes && <div className="text-[12.5px] mt-2 whitespace-pre-wrap">{visit.customerAckNotes}</div>}
            </>
          ) : (
            <div className="text-[12.5px] text-amber-700">Awaiting customer sign-off.</div>
          )}
        </RailCard>
      )}

      {ent && (
        <RailCard title={<><Gauge className="h-3.5 w-3.5 text-subtle" /> Entitlement</>} action={<Link to={`/contracts/${ent.contractId}?tab=entitlements`} className="text-[12px] text-brand-700 hover:underline">Contract</Link>}>
          <div className="flex items-center justify-between text-[12.5px]"><span className="font-medium truncate">{ent.name}</span><span className="tnum text-muted shrink-0">{fmtNumber(ent.utilization.used, 1)} / {fmtNumber(ent.utilization.quantity, 0)} {ent.unit}</span></div>
          <ProgressBar pct={ent.utilization.pct} tone={ent.utilization.exhausted ? 'bad' : ent.utilization.overThreshold ? 'warn' : 'good'} className="mt-1.5" />
          <div className="flex items-center justify-between text-[11px] text-subtle mt-1"><span>{fmtDate(ent.utilization.periodStart)} – {fmtDate(ent.utilization.periodEnd)}</span><span>{ent.utilization.exhausted ? 'Exhausted' : `${fmtNumber(ent.utilization.remaining, 1)} left`}</span></div>
          {visit.consumption && <RailRows rows={[{ label: 'This visit', value: `${visit.consumption.quantity} ${ent.unit} · ${fmtDate(visit.consumption.consumedAt)}` }]} />}
        </RailCard>
      )}

      {visit.ticket && (
        <RailCard title={<><Ticket className="h-3.5 w-3.5 text-subtle" /> Linked ticket</>}>
          <Link to={`/tickets/${visit.ticket.id}`} className="block hover:underline">
            <div className="font-mono text-[12.5px] text-brand-700">{visit.ticket.number}</div>
            <div className="text-[13px] font-medium truncate">{visit.ticket.title}</div>
          </Link>
          <div className="text-[12px] text-muted inline-flex items-center gap-1.5 mt-1">{visit.ticket.status && <Badge color={visit.ticket.statusColor ?? 'slate'} dot>{visit.ticket.status}</Badge>}<span className="capitalize">{visit.ticket.type}</span>{visit.ticket.assigneeName && <span>· {visit.ticket.assigneeName}</span>}</div>
        </RailCard>
      )}

      {visit.pmOccurrence && (
        <RailCard title={<><Wrench className="h-3.5 w-3.5 text-subtle" /> Preventive maintenance</>}>
          <Link to={`/maintenance?tab=programs&program=${visit.pmOccurrence.programId}`} className="text-[13px] font-medium hover:underline">{visit.pmOccurrence.programName}</Link>
          <RailRows rows={[{ label: 'Planned', value: fmtDate(visit.pmOccurrence.plannedDate) }, { label: 'Scheduled', value: visit.pmOccurrence.scheduledDate ? fmtDate(visit.pmOccurrence.scheduledDate) : null, hidden: !visit.pmOccurrence.scheduledDate }, { label: 'Frequency', value: titleCase(visit.pmOccurrence.frequency) }, { label: 'Status', value: <Badge color={visit.pmOccurrence.status === 'completed' ? 'green' : visit.pmOccurrence.status === 'missed' ? 'red' : 'blue'} dot>{titleCase(visit.pmOccurrence.status)}</Badge> }]} />
        </RailCard>
      )}

      <RailCard title={<><Info className="h-3.5 w-3.5 text-subtle" /> Record</>}>
        <RailRows
          rows={[
            { label: 'Created', value: <span title={fmtDateTime(visit.createdAt)}>{relativeTime(visit.createdAt)}</span> },
            { label: 'Updated', value: <span title={fmtDateTime(visit.updatedAt)}>{relativeTime(visit.updatedAt)}</span> },
            { label: 'Requested by', value: visit.requestedByName },
            { label: 'Report', value: visit.reportGeneratedAt ? <span title={fmtDateTime(visit.reportGeneratedAt)}>{relativeTime(visit.reportGeneratedAt)}</span> : null, hidden: !visit.reportGeneratedAt },
            { label: 'Attachments', value: String(visit.attachmentCount) },
          ]}
        />
      </RailCard>
    </>
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
        <Field label="Team" hint="The engineer and the customer's contacts are notified"><Select value={teamId} placeholder="No team" options={(lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(e) => setTeamId(e.target.value)} /></Field>
      </div>
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
