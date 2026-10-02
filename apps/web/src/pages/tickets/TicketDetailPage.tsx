import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, Flame, AlertTriangle, CheckCircle2, RotateCcw, Ban, Eye, EyeOff, UserPlus, Pencil, Check, X, Lock, ArrowUpRight } from 'lucide-react';
import { Button, Badge, LoadingBlock, ErrorBlock, Textarea, Input } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { useLookups } from '@/hooks/useLookups';
import { fmtDateTime, fmtDuration, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Panel } from '@/components/tickets/Panel';
import { ticketsApi, qk } from '@/components/tickets/api';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { ScopeBadge } from '@/components/tickets/ScopeBadge';
import { TimelineItem } from '@/components/tickets/TimelineItem';
import { Composer } from '@/components/tickets/Composer';
import { CatalogFormValues } from '@/components/tickets/CatalogForm';
import { ApprovalsPanel } from '@/components/tickets/detail/ApprovalsPanel';
import { TasksPanel } from '@/components/tickets/detail/TasksPanel';
import { TimeEntriesPanel } from '@/components/tickets/detail/TimeEntriesPanel';
import { LinksPanel } from '@/components/tickets/detail/LinksPanel';
import { CisAssetsPanel } from '@/components/tickets/detail/CisAssetsPanel';
import { ProblemForm } from '@/components/tickets/detail/ProblemForm';
import { ChangeForm } from '@/components/tickets/detail/ChangeForm';
import { ContextPanel } from '@/components/tickets/detail/ContextPanel';
import { ResolveDialog, CommentDialog, ScopeDialog } from '@/components/tickets/detail/ActionDialogs';
import type { TicketDetail, CatalogField } from '@/components/tickets/types';

export default function TicketDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user)!;
  const isCustomer = user.userType === 'customer';
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const { options } = useLookups();

  const ticketQ = useQuery({ queryKey: qk.detail(id), queryFn: () => ticketsApi.get(id), enabled: !!id, refetchInterval: 60_000 });
  const timelineQ = useQuery({ queryKey: qk.timeline(id), queryFn: () => ticketsApi.timeline(id), enabled: !!id, refetchInterval: 60_000 });
  const ticket = ticketQ.data;

  useEffect(() => {
    if (ticket) setAssistantContext({ label: ticket.number, entityType: 'ticket', entityId: ticket.id });
    return () => setAssistantContext(null);
  }, [ticket?.id, ticket?.number, setAssistantContext, ticket]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.detail(id) });
    qc.invalidateQueries({ queryKey: qk.timeline(id) });
    qc.invalidateQueries({ queryKey: ['tickets', 'list'] });
    qc.invalidateQueries({ queryKey: ['tickets', 'stats'] });
  };
  const act = <T,>(fn: (vars: T) => Promise<unknown>, okMsg?: string) =>
    useMutation({
      mutationFn: fn,
      onSuccess: () => {
        if (okMsg) toast.success(okMsg);
        invalidate();
      },
      onError: (e: Error) => toast.error(e.message),
    });
  const status = act((statusId: string) => ticketsApi.status(id, { statusId }));
  const update = act((body: Record<string, unknown>) => ticketsApi.update(id, body));
  const resolve = act((v: { resolutionCodeId: string | null; resolutionNotes: string }) => ticketsApi.resolve(id, v), 'Resolved');
  const close = act((v: { comment: string; codeId: string | null }) => ticketsApi.close(id, { closureCodeId: v.codeId, comment: v.comment || null }), 'Closed');
  const reopen = act((v: { comment: string }) => ticketsApi.reopen(id, { comment: v.comment || null }), 'Reopened');
  const cancel = act((v: { comment: string; codeId: string | null }) => ticketsApi.cancel(id, { closureCodeId: v.codeId, comment: v.comment || null }), 'Cancelled');
  const escalate = act((v: { comment: string }) => ticketsApi.escalate(id, { reason: v.comment }), 'Escalated');
  const scope = act((v: { scopeStatus: string; scopeNote: string }) => ticketsApi.scope(id, { scopeStatus: v.scopeStatus, scopeNote: v.scopeNote || null }), 'Scope updated');
  const assignMe = act(() => ticketsApi.assign(id, { assigneeId: user.id, autoProgress: true }), 'Assigned to you');
  const watch = act((remove: boolean) => (remove ? ticketsApi.unwatch(id) : ticketsApi.watch(id)));
  const comment = useMutation({
    mutationFn: (input: { kind: string; body: string; minutesSpent?: number | null }) => ticketsApi.comment(id, input),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: qk.time(id) });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [dialog, setDialog] = useState<null | 'resolve' | 'close' | 'reopen' | 'cancel' | 'escalate' | 'scope'>(null);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState<string | null>(null);

  const timelineItems = useMemo(() => timelineQ.data?.items ?? [], [timelineQ.data]);

  if (ticketQ.isLoading) return <LoadingBlock label="Loading ticket…" />;
  if (ticketQ.isError || !ticket) return <ErrorBlock error={ticketQ.error} retry={() => ticketQ.refetch()} />;

  const p = ticket.permissions;
  const cat = ticket.status?.category ?? 'open';
  const isResolved = cat === 'resolved';
  const isClosed = cat === 'closed' || cat === 'cancelled';
  const isOpen = !isResolved && !isClosed;
  const closureCodes = options('closure_code').map((c) => ({ id: c.id, label: c.label }));
  const resolveLabel = ticket.type === 'request' ? 'Fulfil' : ticket.type === 'change' ? 'Implemented' : 'Resolve';
  const statusChoices = ticket.statuses.filter((s) => s.id !== ticket.statusId && (p.update || (p.resolve && ['resolved', 'closed', 'cancelled'].includes(s.category ?? '')) || (isCustomer && p.reopen && (isResolved || isClosed) && ['open', 'new'].includes(s.category ?? ''))));

  return (
    <div className="flex flex-col gap-3 max-w-[1500px]">
      {/* header */}
      <div className="card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
          <Link to={isCustomer ? '/portal/tickets' : '/tickets'} className="hover:underline">Tickets</Link>
          <span>/</span>
          <span className="font-mono font-medium text-default">{ticket.number}</span>
          <TypeBadge type={ticket.type} />
          {ticket.isMajor && (
            <Badge color="red" className="gap-1">
              <Flame className="h-3 w-3" /> Major incident
            </Badge>
          )}
          {ticket.escalationLevel > 0 && (
            <Badge color="amber" className="gap-1">
              <AlertTriangle className="h-3 w-3" /> Escalation L{ticket.escalationLevel}
            </Badge>
          )}
          {ticket.reopenCount > 0 && <Badge color="slate">Reopened ×{ticket.reopenCount}</Badge>}
          <span className="ml-auto text-subtle" title={fmtDateTime(ticket.createdAt)}>
            Created {relativeTime(ticket.createdAt)} · updated {relativeTime(ticket.updatedAt)}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[260px]">
            {editTitle !== null ? (
              <div className="flex items-center gap-2">
                <Input autoFocus value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="text-base font-semibold" onKeyDown={(e) => { if (e.key === 'Enter' && editTitle.trim().length >= 3) { update.mutate({ title: editTitle.trim() }); setEditTitle(null); } if (e.key === 'Escape') setEditTitle(null); }} />
                <Button size="icon" variant="ghost" onClick={() => { if (editTitle.trim().length >= 3) { update.mutate({ title: editTitle.trim() }); setEditTitle(null); } }} aria-label="Save title"><Check className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" onClick={() => setEditTitle(null)} aria-label="Cancel"><X className="h-4 w-4" /></Button>
              </div>
            ) : (
              <h1 className={cn('text-lg font-semibold leading-snug group flex items-start gap-2', p.update && 'cursor-text')} onClick={() => p.update && setEditTitle(ticket.title)} title={p.update ? 'Click to edit' : undefined}>
                <span>{ticket.title}</span>
                {p.update && <Pencil className="h-3.5 w-3.5 text-subtle opacity-0 group-hover:opacity-100 mt-1.5 shrink-0" />}
              </h1>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {statusChoices.length > 0 ? (
                <Menu
                  align="left"
                  trigger={
                    <button className="inline-flex items-center gap-1 rounded-md hover:bg-surface-2 pr-1" disabled={status.isPending}>
                      <TicketStatusBadge status={ticket.status} />
                      <ChevronDown className="h-3.5 w-3.5 text-subtle" />
                    </button>
                  }
                  items={statusChoices.map((s) => ({
                    label: <TicketStatusBadge status={s} />,
                    onClick: () => {
                      if (s.category === 'resolved') setDialog('resolve');
                      else if (s.category === 'closed') setDialog('close');
                      else if (s.category === 'cancelled') setDialog('cancel');
                      else status.mutate(s.id);
                    },
                  }))}
                />
              ) : (
                <TicketStatusBadge status={ticket.status} />
              )}
              {p.update ? (
                <Menu
                  align="left"
                  trigger={
                    <button className="inline-flex items-center gap-1 rounded-md hover:bg-surface-2 pr-1">
                      <PriorityBadge priority={ticket.priority} />
                      <ChevronDown className="h-3.5 w-3.5 text-subtle" />
                    </button>
                  }
                  items={options('ticket_priority').map((o) => ({ label: o.label, onClick: () => update.mutate({ priorityId: o.id }) }))}
                />
              ) : (
                <PriorityBadge priority={ticket.priority} />
              )}
              {!isCustomer && (
                <ScopeBadge
                  status={ticket.scopeStatus}
                  detail={ticket.scopeContract ? `Contract ${ticket.scopeContract.number}` : ticket.contract ? `Contract ${ticket.contract.number}` : null}
                  title={`${ticket.scopeNote ?? ''}${ticket.scopeClassifiedByUser ? ` (set by ${ticket.scopeClassifiedByUser.name})` : ''}` || undefined}
                  onClick={p.scope ? () => setDialog('scope') : undefined}
                />
              )}
              {ticket.category && <Badge color="slate">{ticket.category.label}{ticket.subcategory ? ` / ${ticket.subcategory.label}` : ''}</Badge>}
              {ticket.securitySeverity && <Badge color={ticket.securitySeverity.color ?? undefined}>Severity: {ticket.securitySeverity.label}</Badge>}
            </div>
          </div>
          {/* actions */}
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            {!isCustomer && p.assign && ticket.assigneeId !== user.id && isOpen && (
              <Button size="sm" variant="outline" icon={<UserPlus className="h-3.5 w-3.5" />} onClick={() => assignMe.mutate(undefined)} loading={assignMe.isPending}>
                Assign to me
              </Button>
            )}
            {p.escalate && isOpen && (
              <Button size="sm" variant="outline" icon={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => setDialog('escalate')}>
                Escalate
              </Button>
            )}
            {p.resolve && isOpen && (
              <Button size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setDialog('resolve')}>
                {resolveLabel}
              </Button>
            )}
            {p.close && isResolved && (
              <Button size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setDialog('close')}>
                Close
              </Button>
            )}
            {p.reopen && (isResolved || isClosed) && (
              <Button size="sm" variant="outline" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setDialog('reopen')}>
                Reopen
              </Button>
            )}
            {p.cancel && isOpen && (
              <Button size="sm" variant="ghost" icon={<Ban className="h-3.5 w-3.5" />} onClick={() => setDialog('cancel')}>
                Cancel
              </Button>
            )}
            {p.watch && (
              <Button size="sm" variant="ghost" icon={ticket.isWatching ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} onClick={() => watch.mutate(ticket.isWatching)} title={ticket.isWatching ? 'Stop watching' : 'Watch this ticket'}>
                {ticket.isWatching ? 'Watching' : 'Watch'}
              </Button>
            )}
          </div>
        </div>
        <TicketGlance ticket={ticket} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-3 items-start">
        {/* main column */}
        <div className="flex flex-col gap-3 min-w-0">
          <Panel title="Description" actions={p.update && editDesc === null ? <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditDesc(ticket.description ?? '')}>Edit</Button> : undefined}>
            {editDesc !== null ? (
              <div className="flex flex-col gap-2">
                <Textarea autoFocus value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="min-h-[120px]" />
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="ghost" onClick={() => setEditDesc(null)}>Cancel</Button>
                  <Button size="sm" onClick={() => { update.mutate({ description: editDesc.trim() || null }); setEditDesc(null); }}>Save</Button>
                </div>
              </div>
            ) : (
              <div className="text-[13.5px] whitespace-pre-wrap break-words">{ticket.description || <span className="text-subtle">No description.</span>}</div>
            )}
            {ticket.catalogItem && (
              <div className="mt-3 pt-3 border-t border-default">
                <div className="text-[12.5px] font-medium mb-2">{ticket.catalogItem.name}</div>
                <CatalogFormValues schema={(ticket.catalogItem.formSchema ?? []) as unknown as CatalogField[]} value={ticket.formData ?? {}} />
                {ticket.catalogItem.fulfilmentInstructions && !isCustomer && (
                  <div className="mt-2 text-[12.5px] text-muted rounded-md bg-surface-2 px-3 py-2 inline-flex items-start gap-2">
                    <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {ticket.catalogItem.fulfilmentInstructions}
                  </div>
                )}
              </div>
            )}
            {(isResolved || isClosed) && ticket.resolutionNotes && (
              <div className="mt-3 pt-3 border-t border-default">
                <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Resolution{ticket.resolutionCode ? ` · ${ticket.resolutionCode.label}` : ''}</div>
                <div className="text-[13.5px] whitespace-pre-wrap mt-0.5">{ticket.resolutionNotes}</div>
                {ticket.closureCode && <div className="text-[12px] text-subtle mt-1">Closure: {ticket.closureCode.label}</div>}
              </div>
            )}
          </Panel>

          {(ticket.approvals.length > 0 || (!isCustomer && (ticket.type === 'change' || ticket.type === 'request'))) && (
            <ApprovalsPanel ticket={ticket} approvals={ticket.approvals} canApprove={p.approve} canRequest={!isCustomer && (p.change || p.update)} />
          )}

          {ticket.type === 'problem' && <ProblemForm ticketId={ticket.id} details={ticket.problem} canEdit={p.problem} />}
          {ticket.type === 'change' && <ChangeForm ticketId={ticket.id} details={ticket.change} canEdit={p.change} />}

          {/* timeline + composer */}
          <Panel title={<span>Activity <span className="text-subtle font-normal">{timelineItems.length}</span></span>}>
            {timelineQ.isLoading ? (
              <LoadingBlock />
            ) : (
              <div>
                {timelineItems.map((it, i) => (
                  <TimelineItem key={it.id} item={it} isLast={i === timelineItems.length - 1} />
                ))}
              </div>
            )}
            <div className="mt-3">
              <Composer canComment={p.comment} canWorkNote={p.workNote} canTime={p.time} submitting={comment.isPending} onSubmit={(v) => comment.mutateAsync(v)} />
            </div>
          </Panel>

          {!isCustomer && <TasksPanel ticketId={ticket.id} tasks={ticket.tasks} canEdit={p.tasks && !isClosed} />}
          {!isCustomer && <TimeEntriesPanel ticketId={ticket.id} contractId={ticket.contractId} canEdit={p.time} />}
          {!isCustomer && <LinksPanel ticket={ticket} links={ticket.links} canEdit={p.links} />}
          <CisAssetsPanel ticket={ticket} canEdit={p.update} />
        </div>

        {/* context panel */}
        <aside className="xl:sticky xl:top-4 min-w-0">
          <ContextPanel ticket={ticket} />
        </aside>
      </div>

      <ResolveDialog open={dialog === 'resolve'} onClose={() => setDialog(null)} ticket={ticket} busy={resolve.isPending} onSubmit={(v) => resolve.mutateAsync(v).then(() => setDialog(null))} />
      <CommentDialog open={dialog === 'close'} onClose={() => setDialog(null)} title={`Close ${ticket.number}`} confirmLabel="Close ticket" busy={close.isPending} codes={closureCodes} label="Closing comment" onSubmit={(v) => close.mutateAsync(v).then(() => setDialog(null))} />
      <CommentDialog open={dialog === 'reopen'} onClose={() => setDialog(null)} title={`Reopen ${ticket.number}`} confirmLabel="Reopen" busy={reopen.isPending} label="Why is this being reopened?" required onSubmit={(v) => reopen.mutateAsync({ comment: v.comment }).then(() => setDialog(null))} />
      <CommentDialog open={dialog === 'cancel'} onClose={() => setDialog(null)} title={`Cancel ${ticket.number}`} confirmLabel="Cancel ticket" danger busy={cancel.isPending} codes={isCustomer ? undefined : closureCodes} label="Reason" required onSubmit={(v) => cancel.mutateAsync(v).then(() => setDialog(null))} />
      <CommentDialog open={dialog === 'escalate'} onClose={() => setDialog(null)} title={`Escalate ${ticket.number} to level ${ticket.escalationLevel + 1}`} confirmLabel="Escalate" busy={escalate.isPending} label="Reason" required onSubmit={(v) => escalate.mutateAsync({ comment: v.comment }).then(() => setDialog(null))} />
      <ScopeDialog open={dialog === 'scope'} onClose={() => setDialog(null)} ticket={ticket} busy={scope.isPending} onSubmit={(v) => scope.mutateAsync(v).then(() => setDialog(null))} />
    </div>
  );
}

export type { TicketDetail };

// ---------------------------------------------------------------- at a glance

const minutesBetween = (a: string, b: string | Date) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000));

/** Compact numbers strip under the ticket title: how old, how fast we responded, where the clocks stand. */
function TicketGlance({ ticket }: { ticket: TicketDetail }) {
  const ended = ticket.resolvedAt ?? ticket.closedAt ?? null;
  const age = minutesBetween(ticket.createdAt, ended ?? new Date());
  const firstResponse = ticket.firstResponseAt ? minutesBetween(ticket.createdAt, ticket.firstResponseAt) : null;
  const running = ticket.slas.filter((s) => s.state === 'running' || s.state === 'paused');
  const breached = ticket.slas.filter((s) => s.state === 'breached').length;
  const met = ticket.slas.filter((s) => s.state === 'met').length;
  const next = running.length ? running.reduce((a, b) => (a.remainingMinutes < b.remainingMinutes ? a : b)) : null;
  const items: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }[] = [
    { label: ended ? 'Time to resolve' : 'Age', value: fmtDuration(age) },
    { label: 'First response', value: firstResponse === null ? (ended ? '—' : 'pending') : fmtDuration(firstResponse), tone: firstResponse === null && !ended ? 'warn' : undefined },
    next
      ? { label: `Next target · ${next.label.toLowerCase()}`, value: next.state === 'paused' ? 'paused' : next.remainingMinutes < 0 ? `${fmtDuration(-next.remainingMinutes)} over` : `${fmtDuration(next.remainingMinutes)} left`, tone: next.remainingMinutes < 0 ? 'bad' : next.remainingMinutes < next.targetMinutes * (1 - next.warnPct / 100) ? 'warn' : 'good' }
      : { label: 'SLA targets', value: ticket.slas.length ? `${met} met · ${breached} breached` : 'none', tone: breached > 0 ? 'bad' : met > 0 ? 'good' : undefined },
    { label: 'Due', value: ticket.dueAt ? relativeTime(ticket.dueAt) : '—', tone: ticket.dueAt && new Date(ticket.dueAt) < new Date() && !ended ? 'bad' : undefined },
    { label: 'Reopened', value: ticket.reopenCount ? `${ticket.reopenCount}×` : 'never', tone: ticket.reopenCount > 1 ? 'warn' : undefined },
  ];
  return (
    <div className="mt-3 pt-3 border-t border-default grid grid-cols-2 sm:grid-cols-5 gap-x-6 gap-y-2">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <div className="text-[11.5px] text-muted truncate">{it.label}</div>
          <div className={cn('text-[15px] font-semibold tracking-[-0.01em] tnum', it.tone === 'bad' ? 'text-red-600' : it.tone === 'warn' ? 'text-amber-600' : it.tone === 'good' ? 'text-emerald-600' : 'text-default')}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}
