import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, RotateCcw, ShieldCheck, ShieldOff, ShieldQuestion, Check, X, UserRound, Users, MapPin, Layers } from 'lucide-react';
import { Button, Badge, LoadingBlock, ErrorBlock, Dialog, Textarea, Field, KeyValue } from '@/components/ui';
import { useUiStore } from '@/stores/ui';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Panel } from '@/components/tickets/Panel';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { SlaCard } from '@/components/tickets/SlaCard';
import { TimelineItem } from '@/components/tickets/TimelineItem';
import { Composer } from '@/components/tickets/Composer';
import { AttachmentsSection } from '@/components/tickets/AttachmentsSection';
import { portalApi, pk, type PortalTicket } from '@/components/portal/api';

function ScopeCard({ ticket }: { ticket: PortalTicket }) {
  const s = ticket.scope;
  const Icon = s.status === 'in_scope' ? ShieldCheck : s.status === 'out_of_scope' ? ShieldOff : ShieldQuestion;
  const cls = s.status === 'in_scope' ? 'text-emerald-700' : s.status === 'out_of_scope' ? 'text-rose-700' : 'text-muted';
  return (
    <Panel title="Contract">
      <div className={cn('flex items-start gap-2 text-[13px]', cls)}>
        <Icon className="h-4 w-4 mt-0.5 shrink-0" />
        <span>{s.label}</span>
      </div>
      {ticket.contract && (
        <div className="mt-2 text-[12px] text-muted">
          Service levels from <span className="text-default">{ticket.contract.slaPolicyName ?? ticket.contract.name}</span>
          {ticket.service ? ` · ${ticket.service.name}` : ''}
        </div>
      )}
      {s.status === 'out_of_scope' && <div className="mt-2 text-[12px] text-muted">Nothing is blocked: we still work the ticket and your account manager will let you know if a quote is needed.</div>}
    </Panel>
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
  const comment = useMutation({ mutationFn: (body: string) => portalApi.comment(id, body), onSuccess: invalidate, onError: (e: Error) => toast.error(e.message) });
  const reopen = useMutation({ mutationFn: (reason: string) => portalApi.reopen(id, reason), onSuccess: () => { toast.success('Ticket reopened'); setDialog(null); invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const confirm = useMutation({ mutationFn: (text: string) => portalApi.confirmClose(id, text), onSuccess: () => { toast.success('Thanks — the ticket is closed'); setDialog(null); invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const decide = useMutation({
    mutationFn: (v: { approvalId: string; decision: 'approved' | 'rejected' }) => portalApi.decide(id, v.approvalId, v.decision, approvalComment),
    onSuccess: (_r, v) => { toast.success(v.decision === 'approved' ? 'Request approved' : 'Request rejected'); setApprovalComment(''); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const [dialog, setDialog] = useState<null | 'reopen' | 'confirm'>(null);
  const [approvalComment, setApprovalComment] = useState('');

  if (ticketQ.isLoading) return <LoadingBlock label="Loading ticket…" />;
  if (ticketQ.isError || !ticket) return <ErrorBlock error={ticketQ.error} retry={() => ticketQ.refetch()} />;

  const cat = ticket.status?.category ?? 'open';
  const closedLike = cat === 'closed' || cat === 'cancelled';
  const a = ticket.actions;

  return (
    <div className="flex flex-col gap-3 max-w-6xl">
      <div className="card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
          <Link to="/portal/tickets" className="hover:underline">My tickets</Link>
          <span>/</span>
          <span className="font-mono font-medium text-default">{ticket.number}</span>
          <TypeBadge type={ticket.type} />
          {ticket.reopenCount > 0 && <Badge color="slate">Reopened</Badge>}
          <span className="ml-auto text-subtle" title={fmtDateTime(ticket.createdAt)}>
            Raised {relativeTime(ticket.createdAt)}{ticket.requester ? ` by ${ticket.isMine ? 'you' : ticket.requester.name}` : ''}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[240px]">
            <h1 className="text-lg font-semibold leading-snug">{ticket.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <TicketStatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
              {ticket.category && <Badge color="slate">{ticket.category.label}</Badge>}
              {ticket.status?.key === 'pending_customer' && <Badge color="amber">Waiting for your reply</Badge>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            {a.confirmClose && (
              <Button size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setDialog('confirm')}>
                Confirm it&apos;s fixed
              </Button>
            )}
            {a.reopen && (
              <Button size="sm" variant="outline" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setDialog('reopen')}>
                Reopen
              </Button>
            )}
          </div>
        </div>
        {cat === 'resolved' && (
          <div className="mt-3 rounded-md bg-emerald-50 text-emerald-800 text-[12.5px] px-3 py-2">
            We believe this is resolved. If everything works, confirm so we can close it; otherwise reopen and tell us what is still wrong. Unconfirmed tickets close automatically after a few days.
          </div>
        )}
        {closedLike && !a.reopen && ticket.resolvedAt && <div className="mt-3 text-[12px] text-muted">This ticket can no longer be reopened (the {a.reopenWindowDays}-day window has passed). Please raise a new ticket if the problem returns.</div>}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-3 items-start">
        <div className="flex flex-col gap-3 min-w-0">
          <Panel title="Description">
            <div className="text-[13.5px] whitespace-pre-wrap break-words">{ticket.description || <span className="text-subtle">No description.</span>}</div>
            {ticket.form.length > 0 && (
              <div className="mt-3 pt-3 border-t border-default">
                {ticket.catalogItem && <div className="text-[12.5px] font-medium mb-2">{ticket.catalogItem.name}</div>}
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                  {ticket.form.map((f) => (
                    <div key={f.key}>
                      <dt className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">{f.label}</dt>
                      <dd className="text-[13px] break-words">{f.value === true ? 'Yes' : f.value === false ? 'No' : f.value === null || f.value === undefined || f.value === '' ? '—' : String(f.value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {(cat === 'resolved' || closedLike) && ticket.resolutionNotes && (
              <div className="mt-3 pt-3 border-t border-default">
                <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">What we did</div>
                <div className="text-[13.5px] whitespace-pre-wrap mt-0.5">{ticket.resolutionNotes}</div>
              </div>
            )}
          </Panel>

          <Panel title={<span>Conversation <span className="text-subtle font-normal">{ticket.timeline.length}</span></span>}>
            <div>
              {ticket.timeline.map((it, i) => (
                <TimelineItem key={it.id} item={it} isLast={i === ticket.timeline.length - 1} />
              ))}
              {ticket.timeline.length === 0 && <div className="text-[12.5px] text-muted">No updates yet.</div>}
            </div>
            {a.comment && (
              <div className="mt-3">
                <Composer canComment canWorkNote={false} submitting={comment.isPending} placeholder="Write a reply to the service desk…" onSubmit={(v) => comment.mutateAsync(v.body)} />
              </div>
            )}
          </Panel>

          <Panel title="Attachments">
            <AttachmentsSection entityType="ticket" entityId={ticket.id} canUpload={a.comment} showVisibility={false} />
          </Panel>
        </div>

        <aside className="xl:sticky xl:top-4 min-w-0 flex flex-col gap-3">
          <Panel title="Status">
            <KeyValue
              columns={1}
              items={[
                { label: 'Status', value: <TicketStatusBadge status={ticket.status} /> },
                { label: 'Priority', value: <PriorityBadge priority={ticket.priority} /> },
                { label: 'Engineer', value: ticket.assignee ? <span className="inline-flex items-center gap-1.5"><UserRound className="h-3.5 w-3.5 text-subtle" /> {ticket.assignee.firstName ?? ticket.assignee.name}{ticket.team ? <span className="text-muted"> · {ticket.team.name}</span> : null}</span> : ticket.team ? <span className="inline-flex items-center gap-1.5"><Users className="h-3.5 w-3.5 text-subtle" /> {ticket.team.name}</span> : <span className="text-muted">Being assigned</span> },
                ...(ticket.site ? [{ label: 'Site', value: <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-subtle" /> {ticket.site.name}</span> }] : []),
                ...(ticket.service ? [{ label: 'Service', value: <span className="inline-flex items-center gap-1.5"><Layers className="h-3.5 w-3.5 text-subtle" /> {ticket.service.name}</span> }] : []),
                ...(ticket.cis.length || ticket.assets.length ? [{ label: 'Affected', value: [...ticket.cis.map((c) => c.name), ...ticket.assets.map((x) => `${x.name} (${x.tag})`)].join(', ') }] : []),
                { label: 'Last update', value: <span title={fmtDateTime(ticket.lastActivityAt)}>{relativeTime(ticket.lastActivityAt)}</span> },
              ]}
            />
          </Panel>

          <SlaCard slas={ticket.slas} policyName={ticket.slaPolicy?.name ?? null} />

          <ScopeCard ticket={ticket} />

          {ticket.approvals.length > 0 && (
            <Panel title="Approval">
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
                {a.approve && ticket.pendingForMe.length > 0 && (
                  <div className="mt-1 pt-2 border-t border-default">
                    <div className="text-[12.5px] text-muted mb-1.5">This request needs your decision.</div>
                    <Textarea value={approvalComment} onChange={(e) => setApprovalComment(e.target.value)} placeholder="Comment (optional)" className="min-h-[56px] text-[12.5px]" />
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} loading={decide.isPending} onClick={() => decide.mutate({ approvalId: ticket.pendingForMe[0].id, decision: 'approved' })}>
                        Approve
                      </Button>
                      <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={decide.isPending} onClick={() => decide.mutate({ approvalId: ticket.pendingForMe[0].id, decision: 'rejected' })}>
                        Reject
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </Panel>
          )}
        </aside>
      </div>

      <ReasonDialog open={dialog === 'reopen'} onClose={() => setDialog(null)} title={`Reopen ${ticket.number}`} label="What is still wrong?" confirmLabel="Reopen ticket" required busy={reopen.isPending} onSubmit={(t) => reopen.mutateAsync(t)} />
      <ReasonDialog open={dialog === 'confirm'} onClose={() => setDialog(null)} title="Confirm the fix" intro="Confirming closes the ticket with your name on it. You can still reopen it within the reopen window if the problem comes back." label="Comment (optional)" confirmLabel="Yes, it's fixed" busy={confirm.isPending} onSubmit={(t) => confirm.mutateAsync(t)} />
    </div>
  );
}
