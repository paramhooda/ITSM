import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, Flame, AlertTriangle, CheckCircle2, RotateCcw, Ban, Eye, EyeOff, UserPlus, Pencil, Lock, ArrowUpRight, MessageSquare, Info, Sparkles, X, Mail, Phone, Undo2, BellRing } from 'lucide-react';
import { Button, Badge, LoadingBlock, ErrorBlock, Textarea, Select, Input, Avatar } from '@/components/ui';
import { Menu, type MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RecordAttention, RelatedTabs, ActivityStream, RailTabs, fromTimeline, type FormSection, type FieldDef } from '@/components/record';
import { ticketAttention } from '@/components/record/attention';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import { fmtDuration, relativeTime, fmtDateTime } from '@/lib/format';
import { ticketsApi, qk } from '@/components/tickets/api';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { ScopeBadge } from '@/components/tickets/ScopeBadge';
import { CatalogFormValues } from '@/components/tickets/CatalogForm';
import { AttachmentsSection } from '@/components/tickets/AttachmentsSection';
import { attachmentsQueryKey, commentWithAttachments } from '@/components/attachments/upload';
import type { ComposerInput } from '@/components/tickets/Composer';
import { ApprovalsPanel } from '@/components/tickets/detail/ApprovalsPanel';
import { TasksPanel } from '@/components/tickets/detail/TasksPanel';
import { TimeEntriesPanel } from '@/components/tickets/detail/TimeEntriesPanel';
import { LinksPanel } from '@/components/tickets/detail/LinksPanel';
import { CisAssetsPanel } from '@/components/tickets/detail/CisAssetsPanel';
import { ProblemForm } from '@/components/tickets/detail/ProblemForm';
import { ChangeForm } from '@/components/tickets/detail/ChangeForm';
import { MajorIncidentPanel } from '@/components/tickets/detail/MajorIncidentPanel';
import { TicketDetailsRail, TicketAssistRail } from '@/components/tickets/detail/TicketRail';
import { ResolveDialog, CommentDialog, ScopeDialog } from '@/components/tickets/detail/ActionDialogs';
import { SlaCard } from '@/components/tickets/SlaCard';
import { PageDialog } from '@/components/oncall/PageDialog';
import { PagesPanel } from '@/components/oncall/PagesPanel';
import { oncallApi, oncallKeys } from '@/components/oncall/api';
import { LINK_TYPE_LABELS, type TicketDetail, type CatalogField, type LinkedTicket } from '@/components/tickets/types';

/** In-place select for a form field (ServiceNow edits on the form, not in a dialog). */
function FieldSelect({ value, options, onChange, disabled, placeholder = '—' }: { value: string | null | undefined; options: { value: string; label: string }[]; onChange: (v: string | null) => void; disabled?: boolean; placeholder?: string }) {
  if (disabled) return <span>{options.find((o) => o.value === value)?.label ?? <span className="text-subtle">{placeholder}</span>}</span>;
  return <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} placeholder={placeholder} className="h-7 py-0 text-[12.5px] w-full max-w-[260px]" options={options} />;
}

/** A person with their contact handles, as on the rail. */
function Person({ p }: { p: { name: string; email?: string | null; phone?: string | null } | null | undefined }) {
  if (!p) return <span className="text-subtle">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <Avatar name={p.name} size="xs" /> <span className="truncate">{p.name}</span>
      {p.email && <a href={`mailto:${p.email}`} className="text-subtle hover:text-default" title={p.email}><Mail className="h-3 w-3" /></a>}
      {p.phone && <a href={`tel:${p.phone}`} className="text-subtle hover:text-default" title={p.phone}><Phone className="h-3 w-3" /></a>}
    </span>
  );
}

/** One linked ticket on a row: type, number, title, state. */
function TicketRef({ t }: { t: LinkedTicket['ticket'] | { id: string; number: string; title: string; type?: TicketDetail['type']; status?: LinkedTicket['ticket']['status'] } }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0" title={`${t.number} · ${t.title}`}>
      {t.type && <TypeBadge type={t.type} short className="px-1 py-0 text-[10px] shrink-0" />}
      <Link to={`/tickets/${t.id}`} className="font-mono text-[12.5px] text-brand-700 hover:underline whitespace-nowrap shrink-0">{t.number}</Link>
      <span className="truncate flex-1 min-w-0">{t.title}</span>
      {t.status && <span className="shrink-0"><TicketStatusBadge status={t.status} /></span>}
    </span>
  );
}

/** How a link reads from the other end: incidents "of" a problem, changes "for" a ticket, duplicates, children… */
const INBOUND_LINK_LABELS: Record<string, string> = { problem_of: 'Incidents', change_for: 'Changes', caused_by: 'Caused', duplicate_of: 'Duplicates', blocks: 'Blocked by', child_of: 'Children', resolved_by: 'Resolves', related: 'Related to' };

export default function TicketDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user)!;
  const isCustomer = user.userType === 'customer';
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const { options, lookups } = useLookups();
  const engineers = useEngineers();

  const ticketQ = useQuery({ queryKey: qk.detail(id), queryFn: () => ticketsApi.get(id), enabled: !!id, refetchInterval: 60_000 });
  const timelineQ = useQuery({ queryKey: qk.timeline(id), queryFn: () => ticketsApi.timeline(id), enabled: !!id, refetchInterval: 60_000 });
  const pagesQ = useQuery({ queryKey: oncallKeys.pages({ ticketId: id, limit: 20 }), queryFn: () => oncallApi.pages({ ticketId: id, limit: 20 }), enabled: !!id && !isCustomer, refetchInterval: 60_000 });
  const ticket = ticketQ.data;

  useEffect(() => {
    if (ticket) setAssistantContext({ label: ticket.number, entityType: 'ticket', entityId: ticket.id });
    return () => setAssistantContext(null);
  }, [ticket?.id, ticket?.number, setAssistantContext, ticket]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.detail(id) });
    qc.invalidateQueries({ queryKey: qk.timeline(id) });
    qc.invalidateQueries({ queryKey: qk.major(id) });
    qc.invalidateQueries({ queryKey: ['tickets', 'list'] });
    qc.invalidateQueries({ queryKey: ['tickets', 'stats'] });
    qc.invalidateQueries({ queryKey: ['major-incidents'] });
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
  const assign = act((body: Record<string, unknown>) => ticketsApi.assign(id, body));
  const resolve = act((v: { resolutionCodeId: string | null; resolutionNotes: string }) => ticketsApi.resolve(id, v), 'Resolved');
  const close = act((v: { comment: string; codeId: string | null }) => ticketsApi.close(id, { closureCodeId: v.codeId, comment: v.comment || null }), 'Closed');
  const reopen = act((v: { comment: string }) => ticketsApi.reopen(id, { comment: v.comment || null }), 'Reopened');
  const cancel = act((v: { comment: string; codeId: string | null }) => ticketsApi.cancel(id, { closureCodeId: v.codeId, comment: v.comment || null }), 'Cancelled');
  const escalate = act((v: { comment: string }) => ticketsApi.escalate(id, { reason: v.comment }), 'Escalated');
  const scope = act((v: { scopeStatus: string; scopeNote: string }) => ticketsApi.scope(id, { scopeStatus: v.scopeStatus, scopeNote: v.scopeNote || null }), 'Scope updated');
  const assignMe = act(() => ticketsApi.assign(id, { assigneeId: user.id, autoProgress: true }), 'Assigned to you');
  const declareMajor = act((v: { comment: string }) => ticketsApi.declareMajor(id, { reason: v.comment || null }), 'Declared a major incident');
  const demoteMajor = act((v: { comment: string }) => ticketsApi.demoteMajor(id, { reason: v.comment || null }), 'No longer a major incident');
  const watch = act((remove: boolean) => (remove ? ticketsApi.unwatch(id) : ticketsApi.watch(id)));
  // A note with files: the files go up first and follow the note's audience (a reply is customer-visible, a work note is not).
  const comment = useMutation({
    mutationFn: (input: ComposerInput) =>
      commentWithAttachments({
        text: input.body,
        files: input.files,
        target: { entityType: 'ticket', entityId: id, customerId: ticket?.customerId, customerVisible: isCustomer ? true : input.kind === 'comment' },
        post: (body) => ticketsApi.comment(id, { kind: input.kind, body, minutesSpent: input.minutesSpent }),
      }),
    onSuccess: (outcome) => {
      invalidate();
      qc.invalidateQueries({ queryKey: qk.time(id) });
      if (outcome.ok.length) qc.invalidateQueries({ queryKey: attachmentsQueryKey('ticket', id) });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [dialog, setDialog] = useState<null | 'resolve' | 'close' | 'reopen' | 'cancel' | 'escalate' | 'scope' | 'major-declare' | 'major-demote' | 'page'>(null);
  const [editDesc, setEditDesc] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const entries = useMemo(() => (timelineQ.data?.items ?? []).map(fromTimeline), [timelineQ.data]);
  // "Nudge customer" lands the cursor in the reply composer, which lives in the Activity rail tab.
  const railRef = useRef<HTMLDivElement>(null);
  const focusComposer = () => railRef.current?.querySelector('textarea')?.focus();

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
  const priorityChoices = options('ticket_priority');
  const subcats = options('ticket_subcategory').filter((o) => o.parentId === ticket.categoryId);
  const isSoc = ticket.domain === 'soc' || ticket.category?.domain === 'soc';
  const teamEngineers = (engineers.data ?? []).filter((e) => !ticket.assignedTeamId || e.teamIds.includes(ticket.assignedTeamId) || e.id === ticket.assigneeId);
  const opt = (type: string) => options(type).map((o) => ({ value: o.id, label: o.label }));
  const primaryCi = ticket.cis.find((c) => c.id === ticket.primaryCiId) ?? ticket.cis[0] ?? null;
  const primaryAsset = ticket.assets.find((a) => a.id === ticket.primaryAssetId) ?? ticket.assets[0] ?? null;

  // ---- what needs attention (MSP staff only): breached clocks, no assignee, waiting on the customer…
  const attention = isCustomer
    ? []
    : ticketAttention(ticket, Date.now(), {
        onAssignMe: p.assign && isOpen && ticket.assigneeId !== user.id ? () => assignMe.mutate(undefined) : undefined,
        onEscalate: p.escalate && isOpen ? () => setDialog('escalate') : undefined,
        onNudge: p.comment ? focusComposer : undefined,
        onScope: p.update ? () => setDialog('scope') : undefined,
        onDeclareMajor: p.major && ticket.type === 'incident' && !ticket.isMajor && isOpen ? () => setDialog('major-declare') : undefined,
      });

  // ---- header actions: two primary, the rest in the overflow menu
  const primary = (
    <>
      {p.resolve && isOpen && <Button size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setDialog('resolve')}>{resolveLabel}</Button>}
      {p.close && isResolved && <Button size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setDialog('close')}>Close</Button>}
      {p.reopen && (isResolved || isClosed) && <Button size="sm" variant="outline" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setDialog('reopen')}>Reopen</Button>}
      {!isCustomer && p.assign && ticket.assigneeId !== user.id && isOpen && <Button size="sm" variant="outline" icon={<UserPlus className="h-3.5 w-3.5" />} onClick={() => assignMe.mutate(undefined)} loading={assignMe.isPending}>Assign to me</Button>}
    </>
  );
  const menu: MenuItem[] = [
    ...(p.major && !ticket.isMajor && isOpen ? [{ label: 'Declare major incident…', icon: <Flame className="h-4 w-4" />, onClick: () => setDialog('major-declare') }] : []),
    ...(p.major && ticket.isMajor ? [{ label: 'Not a major incident…', icon: <Undo2 className="h-4 w-4" />, onClick: () => setDialog('major-demote') }] : []),
    ...(p.escalate && isOpen ? [{ label: `Escalate to level ${ticket.escalationLevel + 1}`, icon: <ArrowUpRight className="h-4 w-4" />, onClick: () => setDialog('escalate') }] : []),
    ...(p.escalate && isOpen && !isCustomer ? [{ label: 'Page on-call…', icon: <BellRing className="h-4 w-4" />, onClick: () => setDialog('page') }] : []),
    ...(p.watch ? [{ label: ticket.isWatching ? 'Stop watching' : 'Watch this ticket', icon: ticket.isWatching ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />, onClick: () => watch.mutate(ticket.isWatching) }] : []),
    ...(p.update && !isCustomer ? [{ label: 'Classify scope…', icon: <Pencil className="h-4 w-4" />, onClick: () => setDialog('scope') }] : []),
    ...(p.cancel && isOpen ? [{ label: 'Cancel ticket', icon: <Ban className="h-4 w-4" />, onClick: () => setDialog('cancel'), danger: true }] : []),
  ];

  // ---- state controls under the title
  const controls = (
    <>
      {statusChoices.length > 0 ? (
        <Menu align="left" trigger={<button className="inline-flex items-center gap-1 rounded-md hover:bg-surface-2 pr-1" disabled={status.isPending}><TicketStatusBadge status={ticket.status} /><ChevronDown className="h-3 w-3 text-subtle" /></button>} items={statusChoices.map((s) => ({ label: s.label, onClick: () => (['resolved'].includes(s.category ?? '') && p.resolve ? setDialog('resolve') : ['closed'].includes(s.category ?? '') && p.close ? setDialog('close') : ['cancelled'].includes(s.category ?? '') && p.cancel ? setDialog('cancel') : status.mutate(s.id)) }))} />
      ) : (
        <TicketStatusBadge status={ticket.status} />
      )}
      {p.update && !isClosed && priorityChoices.length > 0 ? (
        <Menu align="left" trigger={<button className="inline-flex items-center gap-1 rounded-md hover:bg-surface-2 pr-1"><PriorityBadge priority={ticket.priority} /><ChevronDown className="h-3 w-3 text-subtle" /></button>} items={priorityChoices.map((o) => ({ label: o.label, onClick: () => update.mutate({ priorityId: o.id }) }))} />
      ) : (
        <PriorityBadge priority={ticket.priority} />
      )}
      {!isCustomer && <ScopeBadge status={ticket.scopeStatus} detail={ticket.scopeContract?.number ?? null} onClick={p.update ? () => setDialog('scope') : undefined} />}
      {ticket.securitySeverity && <Badge color={ticket.securitySeverity.color ?? undefined}>Severity: {ticket.securitySeverity.label}</Badge>}
      {ticket.approvalStatus && ticket.approvalStatus !== 'none' && <Badge color={ticket.approvalStatus === 'approved' ? 'green' : ticket.approvalStatus === 'rejected' ? 'red' : 'amber'}>Approval: {ticket.approvalStatus}</Badge>}
    </>
  );

  // ---- Details: who it is for and what it concerns (left), its state and who owns it (right)
  const tagsField = (
    <div className="flex flex-wrap items-center gap-1">
      {ticket.tags.map((t) => (
        <Badge key={t} color="slate" className="gap-1">
          {t}
          {p.update && <button onClick={() => update.mutate({ tags: ticket.tags.filter((x) => x !== t) })} aria-label={`Remove ${t}`} className="opacity-60 hover:opacity-100"><X className="h-3 w-3" /></button>}
        </Badge>
      ))}
      {p.update && <Input value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="+ tag" className="h-6 py-0 w-20 text-[12px] px-1.5" onKeyDown={(e) => { if (e.key === 'Enter' && tagInput.trim()) { update.mutate({ tags: [...new Set([...ticket.tags, tagInput.trim()])] }); setTagInput(''); } }} />}
      {!p.update && !ticket.tags.length && <span className="text-subtle">—</span>}
    </div>
  );
  const details: FormSection = {
    key: 'details',
    title: 'Details',
    fields: [
      { label: 'Customer', value: isCustomer ? ticket.customer?.name : ticket.customer ? <Link to={`/customers/${ticket.customerId}`} className="hover:underline font-medium">{ticket.customer.name}</Link> : null },
      { label: 'Site', value: ticket.site?.name },
      { label: 'Requester', value: <Person p={ticket.requester ?? ticket.requesterContact} /> },
      { label: 'Service', value: ticket.service?.name },
      { label: 'Contract', value: ticket.contract ? (isCustomer ? ticket.contract.number : <Link to={`/contracts/${ticket.contract.id}`} className="hover:underline">{ticket.contract.number} · {ticket.contract.name}</Link>) : <span className="text-amber-700">No active contract</span>, hidden: isCustomer && !ticket.contract },
      {
        label: 'Configuration item',
        value: primaryCi ? (
          <span className="inline-flex items-center gap-1.5 min-w-0">
            {isCustomer ? <span>{primaryCi.name}</span> : <Link to={`/cmdb/cis/${primaryCi.id}`} className="hover:underline">{primaryCi.name}</Link>}
            {primaryCi.hostname && <span className="text-subtle font-mono text-[12px]">{primaryCi.hostname}</span>}
            {ticket.cis.length > 1 && <span className="text-subtle text-[12px]">+{ticket.cis.length - 1} more</span>}
          </span>
        ) : null,
        hidden: isCustomer && !primaryCi,
      },
      {
        label: 'Asset',
        value: primaryAsset ? (
          <span className="inline-flex items-center gap-1.5 min-w-0">
            {isCustomer ? <span>{primaryAsset.tag} · {primaryAsset.name}</span> : <Link to={`/assets/${primaryAsset.id}`} className="hover:underline">{primaryAsset.tag} · {primaryAsset.name}</Link>}
            {ticket.assets.length > 1 && <span className="text-subtle text-[12px]">+{ticket.assets.length - 1} more</span>}
          </span>
        ) : null,
        hidden: !primaryAsset,
      },
      { label: 'Category', edit: <FieldSelect value={ticket.categoryId} disabled={!p.update} options={opt('ticket_category')} onChange={(v) => update.mutate({ categoryId: v, subcategoryId: null })} /> },
      { label: 'Subcategory', edit: <FieldSelect value={ticket.subcategoryId} disabled={!p.update} options={subcats.map((o) => ({ value: o.id, label: o.label }))} onChange={(v) => update.mutate({ subcategoryId: v })} />, hidden: subcats.length === 0 && !ticket.subcategoryId },
      { label: 'Tags', value: tagsField, hidden: isCustomer },
      { label: 'External ref', value: ticket.externalRef, kind: 'mono', hidden: !ticket.externalRef },
    ],
    right: [
      { label: 'Source', edit: <FieldSelect value={ticket.sourceId} disabled={!p.update} options={opt('ticket_source')} onChange={(v) => update.mutate({ sourceId: v })} />, hidden: isCustomer },
      { label: 'Opened', value: ticket.createdByUser ? `${ticket.createdByUser.name} · ${fmtDateTime(ticket.createdAt)}` : fmtDateTime(ticket.createdAt) },
      { label: 'Status', value: <TicketStatusBadge status={ticket.status} /> },
      { label: 'Impact', edit: <FieldSelect value={ticket.impactId} disabled={!p.update} options={opt('ticket_impact')} onChange={(v) => update.mutate({ impactId: v })} /> },
      { label: 'Urgency', edit: <FieldSelect value={ticket.urgencyId} disabled={!p.update} options={opt('ticket_urgency')} onChange={(v) => update.mutate({ urgencyId: v })} /> },
      { label: 'Priority', edit: p.update && !isClosed ? <FieldSelect value={ticket.priorityId} options={priorityChoices.map((o) => ({ value: o.id, label: o.label }))} onChange={(v) => update.mutate({ priorityId: v })} /> : <PriorityBadge priority={ticket.priority} /> },
      { label: 'Severity', edit: <FieldSelect value={ticket.securitySeverityId} disabled={!p.update} options={opt('security_severity')} onChange={(v) => update.mutate({ securitySeverityId: v })} />, hidden: !isSoc },
      { label: 'Team', edit: <FieldSelect value={ticket.assignedTeamId} disabled={!p.assign || isClosed} placeholder="No team" options={(lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(v) => assign.mutate({ teamId: v, assigneeId: null })} />, hidden: isCustomer },
      { label: 'Assigned to', edit: isCustomer ? <span>{ticket.assignee?.name ?? <span className="text-muted">Being assigned</span>}</span> : <FieldSelect value={ticket.assigneeId} disabled={!p.assign || isClosed} placeholder="Unassigned" options={teamEngineers.map((e) => ({ value: e.id, label: e.name }))} onChange={(v) => assign.mutate({ assigneeId: v, autoProgress: true })} /> },
      { label: 'Due', value: ticket.dueAt ? <span className={ticket.dueAt && new Date(ticket.dueAt) < new Date() && isOpen ? 'text-red-600' : undefined}>{fmtDateTime(ticket.dueAt)}</span> : null, hidden: !ticket.dueAt },
    ],
  };

  // ---- Description, with the request form when it came from the catalog
  const description: FormSection = {
    key: 'description',
    title: 'Description',
    columns: 1,
    actions: p.update && editDesc === null ? <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditDesc(ticket.description ?? '')}>Edit</Button> : undefined,
    fields: editDesc !== null ? [] : [{ label: 'Description', kind: 'prose', value: ticket.description ?? '' }],
    children:
      editDesc !== null ? (
        <div className="flex flex-col gap-2 py-1">
          <Textarea autoFocus value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="min-h-[120px]" />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => setEditDesc(null)}>Cancel</Button>
            <Button size="sm" onClick={() => { update.mutate({ description: editDesc.trim() || null }); setEditDesc(null); }}>Save</Button>
          </div>
        </div>
      ) : ticket.catalogItem ? (
        <div className="pt-1 pb-2">
          <div className="text-[12.5px] font-medium mb-1.5">{ticket.catalogItem.name}</div>
          <CatalogFormValues schema={(ticket.catalogItem.formSchema ?? []) as unknown as CatalogField[]} value={ticket.formData ?? {}} />
          {ticket.catalogItem.fulfilmentInstructions && !isCustomer && (
            <div className="mt-2 text-[12.5px] text-muted rounded-md bg-surface-2 px-3 py-2 inline-flex items-start gap-2"><Lock className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {ticket.catalogItem.fulfilmentInstructions}</div>
          )}
        </div>
      ) : undefined,
  };

  // ---- Attachments: the list carries its own title, upload button and visibility toggle
  const attachments: FormSection = {
    key: 'attachments',
    fields: [],
    children: (
      <div className="py-2.5">
        <AttachmentsSection entityType="ticket" entityId={ticket.id} customerId={ticket.customerId} canUpload={p.comment || p.update} canDelete={p.update} showVisibility={!isCustomer} />
      </div>
    ),
  };

  // ---- Resolution information: only once there is something to say
  const resolution: FormSection = {
    key: 'resolution',
    title: 'Resolution information',
    hidden: !(isResolved || isClosed) && !ticket.resolutionNotes && !ticket.resolutionCode && !ticket.closureCode,
    fields: [
      { label: 'Resolution code', value: ticket.resolutionCode?.label },
      { label: 'Resolved', value: ticket.resolvedAt ? fmtDateTime(ticket.resolvedAt) : null },
      { label: 'Closure code', value: ticket.closureCode?.label, hidden: !ticket.closureCode },
      { label: cat === 'cancelled' ? 'Cancelled' : 'Closed', value: ticket.closedAt ? fmtDateTime(ticket.closedAt) : null, hidden: !ticket.closedAt },
      { label: 'Reopened', value: ticket.reopenCount ? `${ticket.reopenCount}×` : 'never', hidden: isCustomer && !ticket.reopenCount },
      { label: 'Resolution notes', kind: 'prose', value: ticket.resolutionNotes ?? '', span: 2 },
    ],
  };

  // ---- Related records: the parent and the typed links, read-only (managed on the Linked tickets tab)
  const linkGroups = new Map<string, LinkedTicket[]>();
  for (const l of ticket.links) {
    const label = l.direction === 'outbound' ? LINK_TYPE_LABELS[l.linkType] ?? l.linkType : INBOUND_LINK_LABELS[l.linkType] ?? `← ${LINK_TYPE_LABELS[l.linkType] ?? l.linkType}`;
    linkGroups.set(label, [...(linkGroups.get(label) ?? []), l]);
  }
  const relatedFields: FieldDef[] = [
    { label: 'Parent', value: ticket.parent ? <TicketRef t={ticket.parent} /> : null, hidden: !ticket.parent },
    ...[...linkGroups.entries()].map(([label, links]): FieldDef => ({
      label,
      value: (
        <div className="flex flex-col gap-0.5 min-w-0">
          {links.slice(0, 3).map((l) => <TicketRef key={l.id} t={l.ticket} />)}
          {links.length > 3 && <span className="text-subtle text-[12px]">+{links.length - 3} more on the Linked tickets tab</span>}
        </div>
      ),
    })),
  ];
  const related: FormSection = { key: 'related-records', title: 'Related records', columns: 1, hidden: isCustomer || relatedFields.every((f) => f.hidden), fields: relatedFields };

  const sections: FormSection[] = [details, description, attachments, resolution, related];

  // ---- related lists
  const tabs = [
    { key: 'major', label: 'Major incident', hidden: isCustomer || !(ticket.isMajor || ticket.major), content: <MajorIncidentPanel ticket={ticket} canEdit={p.major} /> },
    { key: 'plan', label: ticket.type === 'problem' ? 'Problem analysis' : 'Change plan', hidden: !(ticket.type === 'problem' || ticket.type === 'change'), content: ticket.type === 'problem' ? <ProblemForm ticketId={ticket.id} details={ticket.problem} canEdit={p.problem} /> : <ChangeForm ticketId={ticket.id} details={ticket.change} canEdit={p.change} /> },
    { key: 'approvals', label: 'Approvals', count: ticket.approvals.length, hidden: !(ticket.approvals.length > 0 || (!isCustomer && (ticket.type === 'change' || ticket.type === 'request'))), content: <ApprovalsPanel ticket={ticket} approvals={ticket.approvals} canApprove={p.approve} canRequest={!isCustomer && (p.change || p.update)} /> },
    { key: 'tasks', label: 'Tasks', count: ticket.tasks.length, hidden: isCustomer, content: <TasksPanel ticketId={ticket.id} tasks={ticket.tasks} canEdit={p.tasks && !isClosed} /> },
    { key: 'items', label: 'Affected CIs & assets', count: ticket.cis.length + ticket.assets.length, content: <CisAssetsPanel ticket={ticket} canEdit={p.update} /> },
    { key: 'sla', label: 'SLA targets', count: ticket.slas.length, content: <SlaCard slas={ticket.slas} policyName={ticket.slaPolicy?.name} /> },
    { key: 'time', label: 'Time worked', hidden: isCustomer, content: <TimeEntriesPanel ticketId={ticket.id} contractId={ticket.contractId} canEdit={p.time} /> },
    { key: 'related', label: 'Linked tickets', count: ticket.links.length + (ticket.parent ? 1 : 0), hidden: isCustomer, content: <LinksPanel ticket={ticket} links={ticket.links} canEdit={p.links} /> },
    { key: 'pages', label: 'Paging', count: (pagesQ.data?.items ?? []).filter((x) => x.status === 'pending').length, hidden: isCustomer || !(pagesQ.data?.items.length), content: <div className="card"><PagesPanel ticketId={ticket.id} canAct={p.escalate} /></div> },
  ];

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Tickets', to: isCustomer ? '/portal/tickets' : '/tickets' }, { label: ticket.typeLabel, to: isCustomer ? undefined : `/tickets?type=${ticket.type}` }, { label: ticket.number }]}
            number={ticket.number}
            title={ticket.title}
            onTitleChange={p.update ? (t) => update.mutate({ title: t }) : undefined}
            badges={
              <>
                <TypeBadge type={ticket.type} />
                {ticket.isMajor && <Badge color="red" className="gap-1"><Flame className="h-3 w-3" /> Major incident</Badge>}
                {ticket.escalationLevel > 0 && <Badge color="amber" className="gap-1"><AlertTriangle className="h-3 w-3" /> Escalation L{ticket.escalationLevel}</Badge>}
                {ticket.reopenCount > 0 && <Badge color="slate">Reopened ×{ticket.reopenCount}</Badge>}
              </>
            }
            controls={controls}
            primary={primary}
            menu={menu}
            createdAt={ticket.createdAt}
            createdBy={ticket.createdByUser?.name ?? ticket.requester?.name ?? null}
            updatedAt={ticket.updatedAt}
          >
            <RecordRibbon items={glance(ticket, !isCustomer)} columns={isCustomer ? 5 : 6} />
          </RecordHeader>
        }
        main={
          <>
            {!isCustomer && <RecordAttention items={attention} />}
            <RecordForm sections={sections} />
            <RelatedTabs tabs={tabs} defaultTab={ticket.isMajor && !isCustomer ? 'major' : undefined} />
          </>
        }
        aside={
          <div ref={railRef} className="contents">
            <RailTabs
              tabs={[
                { key: 'activity', label: 'Activity', icon: MessageSquare, badge: entries.length, content: <ActivityStream entries={entries} loading={timelineQ.isLoading} maxHeight="calc(100vh - 220px)" composer={{ canComment: p.comment, canWorkNote: p.workNote, canTime: p.time, canAttach: p.comment || p.workNote, submitting: comment.isPending, onSubmit: (v) => comment.mutateAsync(v) }} /> },
                { key: 'details', label: 'Details', icon: Info, content: <TicketDetailsRail ticket={ticket} /> },
                { key: 'assist', label: 'Assist', icon: Sparkles, hidden: isCustomer, content: <TicketAssistRail ticket={ticket} /> },
              ]}
            />
          </div>
        }
      />

      <ResolveDialog open={dialog === 'resolve'} onClose={() => setDialog(null)} ticket={ticket} busy={resolve.isPending} onSubmit={(v) => resolve.mutateAsync(v).then(() => setDialog(null))} />
      <CommentDialog open={dialog === 'close'} onClose={() => setDialog(null)} title={`Close ${ticket.number}`} confirmLabel="Close ticket" busy={close.isPending} codes={closureCodes} label="Closing comment" onSubmit={(v) => close.mutateAsync(v).then(() => setDialog(null))} />
      <CommentDialog open={dialog === 'reopen'} onClose={() => setDialog(null)} title={`Reopen ${ticket.number}`} confirmLabel="Reopen" busy={reopen.isPending} label="Why is this being reopened?" required onSubmit={(v) => reopen.mutateAsync({ comment: v.comment }).then(() => setDialog(null))} />
      <CommentDialog open={dialog === 'cancel'} onClose={() => setDialog(null)} title={`Cancel ${ticket.number}`} confirmLabel="Cancel ticket" danger busy={cancel.isPending} codes={isCustomer ? undefined : closureCodes} label="Reason" required onSubmit={(v) => cancel.mutateAsync(v).then(() => setDialog(null))} />
      <CommentDialog open={dialog === 'escalate'} onClose={() => setDialog(null)} title={`Escalate ${ticket.number} to level ${ticket.escalationLevel + 1}`} confirmLabel="Escalate" busy={escalate.isPending} label="Reason" required onSubmit={(v) => escalate.mutateAsync({ comment: v.comment }).then(() => setDialog(null))} />
      <CommentDialog open={dialog === 'major-declare'} onClose={() => setDialog(null)} title={`Declare ${ticket.number} a major incident`} confirmLabel="Declare major incident" danger busy={declareMajor.isPending} label="Why is this a major incident? (sent to the response team)" onSubmit={(v) => declareMajor.mutateAsync({ comment: v.comment }).then(() => setDialog(null))} />
      <CommentDialog open={dialog === 'major-demote'} onClose={() => setDialog(null)} title={`${ticket.number} is not a major incident`} confirmLabel="Demote" busy={demoteMajor.isPending} label="Reason" required onSubmit={(v) => demoteMajor.mutateAsync({ comment: v.comment }).then(() => setDialog(null))} />
      <ScopeDialog open={dialog === 'scope'} onClose={() => setDialog(null)} ticket={ticket} busy={scope.isPending} onSubmit={(v) => scope.mutateAsync(v).then(() => setDialog(null))} />
      {!isCustomer && <PageDialog open={dialog === 'page'} onClose={() => setDialog(null)} ticketId={ticket.id} ticketNumber={ticket.number} teamId={ticket.assignedTeamId} onPaged={invalidate} />}
    </>
  );
}

export type { TicketDetail };

// ---------------------------------------------------------------- at a glance

const minutesBetween = (a: string, b: string | Date) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000));

/** The numbers an agent checks first: who has it, age, first response, the nearest SLA clock, due, reopens. */
function glance(ticket: TicketDetail, staff: boolean): { label: string; value: string; tone?: 'good' | 'warn' | 'bad'; hint?: string }[] {
  const ended = ticket.resolvedAt ?? ticket.closedAt ?? null;
  const age = minutesBetween(ticket.createdAt, ended ?? new Date());
  const firstResponse = ticket.firstResponseAt ? minutesBetween(ticket.createdAt, ticket.firstResponseAt) : null;
  const running = ticket.slas.filter((s) => s.state === 'running' || s.state === 'paused');
  const breached = ticket.slas.filter((s) => s.state === 'breached').length;
  const met = ticket.slas.filter((s) => s.state === 'met').length;
  const next = running.length ? running.reduce((a, b) => (a.remainingMinutes < b.remainingMinutes ? a : b)) : null;
  return [
    ...(staff ? [{ label: 'Assigned to', value: ticket.assignee?.name ?? 'Unassigned', tone: !ticket.assignee && !ended ? ('warn' as const) : undefined, hint: ticket.team ? `Team: ${ticket.team.name}` : undefined }] : []),
    { label: ended ? 'Time to resolve' : 'Age', value: fmtDuration(age) },
    { label: 'First response', value: firstResponse === null ? (ended ? '—' : 'pending') : fmtDuration(firstResponse), tone: firstResponse === null && !ended ? 'warn' : undefined },
    next
      ? { label: `Next target · ${next.label.toLowerCase()}`, value: next.state === 'paused' ? 'paused' : next.remainingMinutes < 0 ? `${fmtDuration(-next.remainingMinutes)} over` : `${fmtDuration(next.remainingMinutes)} left`, tone: next.remainingMinutes < 0 ? 'bad' : next.remainingMinutes < next.targetMinutes * (1 - next.warnPct / 100) ? 'warn' : 'good' }
      : { label: 'SLA targets', value: ticket.slas.length ? `${met} met · ${breached} breached` : 'none', tone: breached > 0 ? 'bad' : met > 0 ? 'good' : undefined },
    { label: 'Due', value: ticket.dueAt ? relativeTime(ticket.dueAt) : '—', tone: ticket.dueAt && new Date(ticket.dueAt) < new Date() && !ended ? 'bad' : undefined },
    { label: 'Reopened', value: ticket.reopenCount ? `${ticket.reopenCount}×` : 'never', tone: ticket.reopenCount > 1 ? 'warn' : undefined },
  ];
}
