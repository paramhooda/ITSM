import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, RotateCcw, ShieldCheck, ShieldOff, ShieldQuestion, Check, X, MessageSquare, Info, ClipboardCheck, FileSignature } from 'lucide-react';
import { Button, Badge, LoadingBlock, ErrorBlock, Dialog, Textarea, Field } from '@/components/ui';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, ActivityStream, RailTabs, RailCard, RailRows, fromTimeline, type FormSection, type FieldDef } from '@/components/record';
import { useUiStore } from '@/stores/ui';
import { fmtDateTime, fmtDuration, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { SlaCard } from '@/components/tickets/SlaCard';
import { AttachmentsSection } from '@/components/tickets/AttachmentsSection';
import { attachmentsQueryKey, commentWithAttachments } from '@/components/attachments/upload';
import { portalApi, pk, type PortalTicket } from '@/components/portal/api';

const minutesBetween = (a: string, b: string | Date) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000));

/** Contract scope for the customer: in / out / unknown, and which agreement the service levels come from. */
function ScopeCard({ ticket }: { ticket: PortalTicket }) {
  const s = ticket.scope;
  const Icon = s.status === 'in_scope' ? ShieldCheck : s.status === 'out_of_scope' ? ShieldOff : ShieldQuestion;
  const cls = s.status === 'in_scope' ? 'text-emerald-700' : s.status === 'out_of_scope' ? 'text-rose-700' : 'text-muted';
  return (
    <RailCard title={<><FileSignature className="h-3.5 w-3.5 text-subtle" /> Contract</>}>
      <RailRows
        rows={[
          { label: 'Scope', value: <span className={cn('inline-flex items-center gap-1.5', cls)} title={s.status === 'out_of_scope' ? 'Still worked as usual; your account manager will say if a quote is needed' : undefined}><Icon className="h-3.5 w-3.5" /> {s.label}</span> },
          { label: 'Contract', value: ticket.contract ? `${ticket.contract.number} · ${ticket.contract.name}` : s.contract ? `${s.contract.number} · ${s.contract.name}` : null },
          { label: 'Service levels', value: ticket.contract?.slaPolicyName ?? ticket.slaPolicy?.name ?? null },
          { label: 'Service', value: ticket.service?.name, hidden: !ticket.service },
        ]}
      />
    </RailCard>
  );
}

function ReasonDialog({ open, title, label, confirmLabel, required, busy, onClose, onSubmit, intro }: { open: boolean; title: string; label: string; confirmLabel: string; required?: boolean; busy?: boolean; onClose: () => void; onSubmit: (text: string) => Promise<unknown>; intro?: string }) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={required && !text.trim()} onClick={() => void onSubmit(text.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {intro && <div className="text-[13px] text-muted mb-3">{intro}</div>}
      <Field label={label} required={required}>
        <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
    </Dialog>
  );
}

export default function PortalTicketDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const ticketQ = useQuery({ queryKey: pk.ticket(id), queryFn: () => portalApi.ticket(id), enabled: !!id, refetchInterval: 60_000 });
  const ticket = ticketQ.data;

  useEffect(() => {
    if (ticket) setAssistantContext({ label: ticket.number, entityType: 'ticket', entityId: ticket.id });
    return () => setAssistantContext(null);
  }, [ticket?.id, ticket?.number, setAssistantContext, ticket]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: pk.ticket(id) });
    qc.invalidateQueries({ queryKey: ['portal', 'tickets'] });
    qc.invalidateQueries({ queryKey: pk.me });
    qc.invalidateQueries({ queryKey: pk.approvals });
  };
  // A reply with files: the files go up first (always visible to the customer's own organisation), then the note naming them.
  const comment = useMutation({
    mutationFn: (input: { body: string; files: File[] }) => commentWithAttachments({ text: input.body, files: input.files, target: { entityType: 'ticket', entityId: id, customerVisible: true }, post: (body) => portalApi.comment(id, body) }),
    onSuccess: (outcome) => {
      // A reply on a ticket that was waiting on the customer sends it back to the service desk (the API changes the status).
      if (ticketQ.data?.status?.key === 'pending_customer') toast.success('Thanks — your reply is with the service desk and the ticket is back in progress');
      invalidate();
      if (outcome.ok.length) qc.invalidateQueries({ queryKey: attachmentsQueryKey('ticket', id) });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reopen = useMutation({ mutationFn: (reason: string) => portalApi.reopen(id, reason), onSuccess: () => { toast.success('Ticket reopened'); setDialog(null); invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const confirm = useMutation({ mutationFn: (text: string) => portalApi.confirmClose(id, text), onSuccess: () => { toast.success('Thanks — the ticket is closed'); setDialog(null); invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const decide = useMutation({
    mutationFn: (v: { approvalId: string; decision: 'approved' | 'rejected' }) => portalApi.decide(id, v.approvalId, v.decision, approvalComment),
    onSuccess: (_r, v) => { toast.success(v.decision === 'approved' ? 'Request approved' : 'Request rejected'); setApprovalComment(''); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const [dialog, setDialog] = useState<null | 'reopen' | 'confirm'>(null);
  const [approvalComment, setApprovalComment] = useState('');
  const entries = useMemo(() => (ticket?.timeline ?? []).map(fromTimeline), [ticket?.timeline]);

  if (ticketQ.isLoading) return <LoadingBlock label="Loading ticket…" />;
  if (ticketQ.isError || !ticket) return <ErrorBlock error={ticketQ.error} retry={() => ticketQ.refetch()} />;

  const cat = ticket.status?.category ?? 'open';
  const isResolved = cat === 'resolved';
  const closedLike = cat === 'closed' || cat === 'cancelled';
  const ended = isResolved || closedLike;
  const a = ticket.actions;
  const fmtValue = (v: unknown) => (v === true ? 'Yes' : v === false ? 'No' : v === null || v === undefined || v === '' ? null : Array.isArray(v) ? v.join(', ') : String(v));
  const who = ticket.assignee ? `${ticket.assignee.firstName ?? ticket.assignee.name}${ticket.team ? ` · ${ticket.team.name}` : ''}` : ticket.team?.name ?? null;

  // ---- header: the one or two things a customer can do, plus a short state line
  const primary = (
    <>
      {a.confirmClose && <Button size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setDialog('confirm')}>Confirm it&apos;s fixed</Button>}
      {a.reopen && <Button size="sm" variant="outline" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setDialog('reopen')}>Reopen</Button>}
    </>
  );
  const controls = (
    <>
      <TicketStatusBadge status={ticket.status} />
      <PriorityBadge priority={ticket.priority} />
      {ticket.category && <Badge color="slate">{ticket.category.label}</Badge>}
      {ticket.status?.key === 'pending_customer' && <Badge color="amber">Waiting for your reply</Badge>}
      {ticket.approvalStatus && ticket.approvalStatus !== 'none' && <Badge color={ticket.approvalStatus === 'approved' ? 'green' : ticket.approvalStatus === 'rejected' ? 'red' : 'amber'}>Approval: {ticket.approvalStatus}</Badge>}
      {isResolved && a.confirmClose && <span className="text-[12.5px] text-emerald-700">Confirm the fix to close, or reopen if it still fails · closes automatically after a few days</span>}
      {closedLike && !a.reopen && ticket.resolvedAt && <span className="text-[12.5px] text-muted">Reopen window of {a.reopenWindowDays} days has passed · raise a new ticket if it returns</span>}
    </>
  );

  // ---- form: what it is about and who has it (Details), then the text, files and the outcome
  const sections: FormSection[] = [
    {
      key: 'details',
      title: 'Details',
      fields: [
        { label: 'Raised by', value: ticket.requester ? (ticket.isMine ? `You (${ticket.requester.name})` : ticket.requester.name) : ticket.requesterContact?.name },
        { label: 'Site', value: ticket.site?.name },
        { label: 'Service', value: ticket.service?.name },
        { label: 'Type', value: ticket.typeLabel },
        { label: 'Category', value: ticket.category?.label },
        { label: 'Affected', value: [...ticket.cis.map((c) => c.name), ...ticket.assets.map((x) => `${x.name} (${x.tag})`)].join(', '), hidden: !ticket.cis.length && !ticket.assets.length },
      ],
      right: [
        { label: 'Status', value: <TicketStatusBadge status={ticket.status} /> },
        { label: 'Priority', value: <PriorityBadge priority={ticket.priority} /> },
        { label: 'Engineer', value: who ?? <span className="text-muted">Being assigned</span> },
        { label: 'Raised', value: <span title={fmtDateTime(ticket.createdAt)}>{fmtDateTime(ticket.createdAt)}</span> },
        { label: 'Last update', value: <span title={fmtDateTime(ticket.lastActivityAt)}>{relativeTime(ticket.lastActivityAt)}</span> },
        { label: 'Due', value: ticket.dueAt ? fmtDateTime(ticket.dueAt) : null, hidden: !ticket.dueAt || ended },
        { label: 'Resolved', value: ticket.resolvedAt ? fmtDateTime(ticket.resolvedAt) : null, hidden: !ticket.resolvedAt },
        { label: 'Closed', value: ticket.closedAt ? fmtDateTime(ticket.closedAt) : null, hidden: !ticket.closedAt },
      ],
    },
    {
      key: 'resolution',
      title: 'Resolution',
      hidden: !ended || (!ticket.resolutionNotes && !ticket.resolutionCode),
      fields: [
        { label: 'What we did', kind: 'prose', value: ticket.resolutionNotes ?? '', span: 2 },
        { label: 'Resolution code', value: ticket.resolutionCode?.label, hidden: !ticket.resolutionCode },
        { label: 'Fixed on', value: ticket.resolvedAt ? fmtDateTime(ticket.resolvedAt) : null, hidden: !ticket.resolvedAt },
      ],
    },
    {
      key: 'description',
      title: 'Description',
      columns: 1,
      fields: [{ label: 'Description', kind: 'prose', value: ticket.description ?? '' }],
    },
    {
      key: 'request',
      title: 'Request details',
      description: ticket.catalogItem?.name,
      hidden: ticket.form.length === 0,
      fields: ticket.form.map((f): FieldDef => ({ label: f.label, value: fmtValue(f.value), kind: f.type === 'textarea' ? 'prose' : 'text', span: f.type === 'textarea' ? 2 : 1 })),
    },
    {
      key: 'attachments',
      fields: [],
      children: (
        <div className="py-2.5">
          <AttachmentsSection entityType="ticket" entityId={ticket.id} canUpload={a.comment || ticket.attachments.canUpload} showVisibility={false} />
        </div>
      ),
    },
  ];

  const pending = a.approve ? ticket.pendingForMe[0] : undefined;
  const details = (
    <>
      <SlaCard slas={ticket.slas} policyName={ticket.slaPolicy?.name ?? null} />
      <ScopeCard ticket={ticket} />
      {ticket.approvals.length > 0 && (
        <RailCard title={<><ClipboardCheck className="h-3.5 w-3.5 text-subtle" /> Approval</>}>
          <div className="flex flex-col gap-2">
            {ticket.approvals.map((ap) => (
              <div key={ap.id} className="text-[12.5px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{ap.stepName ?? `Step ${ap.step}`}</span>
                  <Badge color={{ pending: 'amber', approved: 'green', rejected: 'red' }[ap.status] ?? 'slate'}>{ap.status}</Badge>
                </div>
                <div className="text-muted">
                  {ap.status === 'pending' ? `Waiting for ${ap.approverLabel}` : `${ap.decidedByName ?? ap.approverLabel}${ap.decidedAt ? ` · ${fmtDateTime(ap.decidedAt)}` : ''}`}
                </div>
                {ap.comment && <div className="text-muted italic">“{ap.comment}”</div>}
              </div>
            ))}
            {pending && (
              <div className="mt-1 pt-2 border-t border-default">
                <Textarea value={approvalComment} onChange={(e) => setApprovalComment(e.target.value)} placeholder="Comment (optional)" className="min-h-[56px] text-[12.5px]" />
                <div className="flex gap-2 mt-2">
                  <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} loading={decide.isPending} onClick={() => decide.mutate({ approvalId: pending.id, decision: 'approved' })}>
                    Approve
                  </Button>
                  <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={decide.isPending} onClick={() => decide.mutate({ approvalId: pending.id, decision: 'rejected' })}>
                    Reject
                  </Button>
                </div>
              </div>
            )}
          </div>
        </RailCard>
      )}
    </>
  );

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'My tickets', to: '/portal/tickets' }, { label: ticket.number }]}
            number={ticket.number}
            title={ticket.title}
            badges={
              <>
                <TypeBadge type={ticket.type} />
                {ticket.reopenCount > 0 && <Badge color="slate">Reopened ×{ticket.reopenCount}</Badge>}
              </>
            }
            controls={controls}
            primary={primary}
            createdAt={ticket.createdAt}
            createdBy={ticket.requester ? (ticket.isMine ? 'you' : ticket.requester.name) : ticket.requesterContact?.name ?? null}
            updatedAt={ticket.updatedAt}
          >
            <RecordRibbon items={glance(ticket)} columns={4} />
          </RecordHeader>
        }
        main={
          <RecordForm sections={sections} />
        }
        aside={
          <RailTabs
            tabs={[
              {
                key: 'activity',
                label: 'Conversation',
                icon: MessageSquare,
                badge: entries.length,
                content: (
                  <ActivityStream
                    title="Conversation"
                    entries={entries}
                    emptyText="No updates yet."
                    maxHeight="calc(100vh - 220px)"
                    composer={a.comment ? { canComment: true, canWorkNote: false, canAttach: true, submitting: comment.isPending, placeholder: 'Write a reply to the service desk…', hints: { comment: 'Sent to the service desk' }, onSubmit: (v) => comment.mutateAsync({ body: v.body, files: v.files }) } : undefined}
                  />
                ),
              },
              { key: 'details', label: 'Details', icon: Info, content: details },
            ]}
          />
        }
      />

      <ReasonDialog open={dialog === 'reopen'} onClose={() => setDialog(null)} title={`Reopen ${ticket.number}`} label="What is still wrong?" confirmLabel="Reopen ticket" required busy={reopen.isPending} onSubmit={(t) => reopen.mutateAsync(t)} />
      <ReasonDialog open={dialog === 'confirm'} onClose={() => setDialog(null)} title="Confirm the fix" intro={`Closes the ticket in your name; you can reopen it within ${a.reopenWindowDays} days if the problem returns.`} label="Comment (optional)" confirmLabel="Yes, it's fixed" busy={confirm.isPending} onSubmit={(t) => confirm.mutateAsync(t)} />
    </>
  );
}

// ---------------------------------------------------------------- at a glance

/** What a customer checks first: how long it has been open, whether we have replied, when it is due, when it was fixed. */
function glance(ticket: PortalTicket): { label: string; value: string; tone?: 'good' | 'warn' | 'bad'; hint?: string }[] {
  const ended = ticket.resolvedAt ?? ticket.closedAt ?? null;
  const age = minutesBetween(ticket.createdAt, ended ?? new Date());
  const firstResponse = ticket.firstResponseAt ? minutesBetween(ticket.createdAt, ticket.firstResponseAt) : null;
  const overdue = !!ticket.dueAt && !ended && new Date(ticket.dueAt) < new Date();
  return [
    { label: ended ? 'Time to fix' : 'Open for', value: fmtDuration(age) },
    { label: 'First reply', value: firstResponse === null ? (ended ? '—' : 'pending') : fmtDuration(firstResponse), tone: firstResponse === null && !ended ? 'warn' : undefined, hint: ticket.firstResponseAt ? fmtDateTime(ticket.firstResponseAt) : undefined },
    { label: 'Due', value: ended ? '—' : ticket.dueAt ? relativeTime(ticket.dueAt) : '—', tone: overdue ? 'bad' : undefined, hint: ticket.dueAt ? fmtDateTime(ticket.dueAt) : undefined },
    { label: 'Last update', value: relativeTime(ticket.lastActivityAt), hint: fmtDateTime(ticket.lastActivityAt) },
  ];
}
