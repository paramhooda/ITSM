import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bug, Globe, GlobeLock, ExternalLink, Wrench, CheckCircle2, Archive, RotateCcw, Info, History, Server, Ticket as TicketIcon, Plus, X, BookOpen, Send } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui';
import type { MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RelatedTabs, ActivityStream, RailTabs, RailCard, RailRows, useAuditStream, type FormSection } from '@/components/record';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { EntityPicker, type PickerItem } from '@/components/tickets/EntityPicker';
import { ticketsApi } from '@/components/tickets/api';
import { aiApi, aiQk } from '@/components/ai/api';
import { portalApi, pk } from '@/components/portal/api';
import { kedbApi, kedbKeys, type KnownErrorStatus } from '@/components/known-errors/api';
import { KNOWN_ERROR_STATUS_LABELS } from '@itsm/shared';
import { KeStatusBadge } from '@/components/known-errors/KeStatusBadge';
import { FixChangePicker } from '@/components/known-errors/FixChangePicker';
import { PublishDialog } from '@/components/known-errors/PublishDialog';
import { fmtDate, fmtDateTime, relativeTime } from '@/lib/format';

/** One known error: the staff record (workaround, fix, incidents, portal wording) or the customer's published view. */
export default function KnownErrorPage() {
  const { id = '' } = useParams();
  const isCustomer = useAuthStore((s) => s.isCustomer());
  return isCustomer ? <PortalKnownError id={id} /> : <StaffKnownError id={id} />;
}

const STATUS_MOVES: { status: KnownErrorStatus; label: string; icon: typeof Bug }[] = [
  { status: 'open', label: 'Mark open', icon: RotateCcw },
  { status: 'fix_in_progress', label: 'Mark fix in progress', icon: Wrench },
  { status: 'resolved', label: 'Mark resolved', icon: CheckCircle2 },
  { status: 'retired', label: 'Retire', icon: Archive },
];

function StaffKnownError({ id }: { id: string }) {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const [publishOpen, setPublishOpen] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [incidentPick, setIncidentPick] = useState<PickerItem[]>([]);
  const ke = useQuery({ queryKey: kedbKeys.detail(id), queryFn: () => kedbApi.get(id), enabled: !!id });
  const audit = useAuditStream('ticket', id);
  const aiOn = can('ai:use');
  const aiStatus = useQuery({ queryKey: aiQk.status, queryFn: aiApi.status, staleTime: 60_000, retry: false, enabled: aiOn });
  const canDraft = aiOn && (aiStatus.data?.features ?? []).includes('kedb_draft');
  const d = ke.data;
  useEffect(() => {
    if (d) setAssistantContext({ label: `${d.number} ${d.title}`, entityType: 'known_error', entityId: d.id, title: d.title });
    return () => setAssistantContext(null);
  }, [d, setAssistantContext]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['known-errors'] });
    qc.invalidateQueries({ queryKey: ['tickets', id] });
    qc.invalidateQueries({ queryKey: ['knowledge'] });
    qc.invalidateQueries({ queryKey: ['audit', 'entity', 'ticket', id] });
  };
  const setStatus = useMutation({
    mutationFn: (status: KnownErrorStatus) => kedbApi.setStatus(id, status),
    onSuccess: (_r, status) => {
      toast.success(`Known error marked ${KNOWN_ERROR_STATUS_LABELS[status].toLowerCase()}`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const setFix = useMutation({
    mutationFn: (fixChangeId: string | null) => kedbApi.update(id, { fixChangeId }),
    onSuccess: (_r, fixChangeId) => {
      toast.success(fixChangeId ? 'Permanent fix change set' : 'Permanent fix change cleared');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const unpublish = useMutation({
    mutationFn: () => kedbApi.unpublish(id),
    onSuccess: () => {
      setConfirmUnpublish(false);
      toast.success('Withdrawn from the customer portal');
      invalidate();
      qc.invalidateQueries({ queryKey: ['portal'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const linkIncident = useMutation({
    mutationFn: (incidentId: string) => ticketsApi.addLink(incidentId, { targetTicketId: id, linkType: 'problem_of' }),
    onSuccess: () => {
      setIncidentPick([]);
      toast.success('Incident linked');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const unlinkIncident = useMutation({
    mutationFn: (linkId: string) => ticketsApi.removeLink(id, linkId),
    onSuccess: () => {
      toast.success('Incident unlinked');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (ke.isLoading) return <LoadingBlock />;
  if (ke.isError || !d) return <ErrorBlock error={ke.error} retry={() => ke.refetch()} />;
  const p = d.permissions;
  const active = d.keStatus === 'open' || d.keStatus === 'fix_in_progress';

  const primary = (
    <>
      {p.publish && d.keStatus !== 'retired' && (
        <Button size="sm" icon={d.portalVisible ? <Globe className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />} onClick={() => setPublishOpen(true)}>
          {d.portalVisible ? 'Update portal wording' : 'Publish to portal'}
        </Button>
      )}
      <Link to={`/tickets/${d.id}`}>
        <Button size="sm" variant="outline" icon={<ExternalLink className="h-3.5 w-3.5" />}>Open problem</Button>
      </Link>
    </>
  );
  const menu: MenuItem[] = [
    ...(p.manage ? STATUS_MOVES.filter((m) => m.status !== d.keStatus).map((m) => ({ label: m.label, icon: <m.icon className="h-4 w-4" />, onClick: () => setStatus.mutate(m.status), disabled: setStatus.isPending })) : []),
    ...(p.publish && d.portalVisible ? [{ label: 'Withdraw from the portal', icon: <GlobeLock className="h-4 w-4" />, onClick: () => setConfirmUnpublish(true) }] : []),
  ];
  const crumbs = [
    { label: 'Knowledge', to: '/knowledge' },
    { label: 'Known errors', to: '/knowledge/known-errors' },
    { label: d.number },
  ];
  const ribbon = [
    { label: 'Status', value: KNOWN_ERROR_STATUS_LABELS[d.keStatus] ?? d.keStatus, tone: d.keStatus === 'open' ? ('warn' as const) : d.keStatus === 'resolved' ? ('good' as const) : ('default' as const) },
    { label: 'Identified', value: d.identifiedAt ? fmtDate(d.identifiedAt) : '—', hint: d.identifiedAt ? fmtDateTime(d.identifiedAt) : undefined },
    { label: 'Linked incidents', value: String(d.linkedIncidents.length) },
    { label: 'Fix change', value: d.fixChange ? d.fixChange.number : '—', hint: d.fixChange?.title },
    { label: 'Published', value: d.portalVisible ? (d.publishedAt ? fmtDate(d.publishedAt) : 'Yes') : 'Not published', tone: d.portalVisible ? ('good' as const) : ('default' as const) },
    { label: 'Owner', value: d.assigneeName ?? 'Unassigned', tone: d.assigneeName ? ('default' as const) : ('warn' as const) },
  ];

  const sections: FormSection[] = [
    {
      key: 'symptoms',
      title: 'Symptoms and impact',
      columns: 1,
      fields: [
        { label: 'Symptoms', kind: 'prose', value: d.symptoms ?? '' },
        { label: 'Impact', kind: 'prose', value: d.impactSummary ?? '' },
        { label: 'Investigation', kind: 'prose', value: d.investigation ?? '', hidden: !d.investigation },
      ],
    },
    {
      key: 'workaround',
      title: 'Workaround',
      description: 'Internal: what engineers do until the permanent fix',
      columns: 1,
      actions: p.manage ? <Link to={`/tickets/${d.id}?tab=plan`} className="text-[12px] text-brand-700 hover:underline">Edit on the problem record</Link> : undefined,
      fields: [{ label: 'Workaround', kind: 'prose', value: d.workaround ?? '' }],
    },
    {
      key: 'fix',
      title: 'Root cause and permanent fix',
      columns: 1,
      fields: [
        { label: 'Root cause', kind: 'prose', value: d.rootCause ?? '' },
        { label: 'Permanent fix', kind: 'prose', value: d.permanentFix ?? '' },
        {
          label: 'Fix change',
          hint: 'The change ticket that delivers the permanent fix; the known error resolves when it is implemented',
          edit: p.manage ? <FixChangePicker customerId={d.customerId} value={d.fixChange ? { id: d.fixChange.id, number: d.fixChange.number, title: d.fixChange.title } : null} onChange={(v) => setFix.mutate(v?.id ?? null)} disabled={setFix.isPending} /> : undefined,
          value: d.fixChange ? (
            <span className="inline-flex items-center gap-2 min-w-0">
              <Link to={`/tickets/${d.fixChange.id}`} className="font-mono text-brand-700 hover:underline">{d.fixChange.number}</Link>
              <span className="truncate">{d.fixChange.title}</span>
            </span>
          ) : null,
        },
        { label: 'Fix change status', value: d.fixChange?.status ? <TicketStatusBadge status={d.fixChange.status} /> : null, hidden: !d.fixChange },
      ],
    },
    {
      key: 'customer',
      title: 'Customer-facing wording',
      description: d.portalVisible ? `Shown to ${d.customerName} in the portal` : 'Not published',
      columns: 1,
      actions: p.publish ? (
        <Button size="sm" variant="outline" icon={d.portalVisible ? <Globe className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />} onClick={() => setPublishOpen(true)}>
          {d.portalVisible ? 'Update wording' : 'Publish to portal'}
        </Button>
      ) : undefined,
      fields: [
        { label: 'What customers notice', kind: 'prose', value: d.customerSummary ?? '' },
        { label: 'What customers do', kind: 'prose', value: d.customerWorkaround ?? '' },
        { label: 'Published', value: d.portalVisible ? `${d.publishedAt ? fmtDateTime(d.publishedAt) : 'Yes'}${d.publishedByName ? ` by ${d.publishedByName}` : ''}` : <span className="text-subtle">Not published; customers do not see this entry</span> },
      ],
    },
    {
      key: 'article',
      title: 'Related article',
      hidden: !d.article,
      columns: 1,
      fields: [{ label: 'Article', value: d.article ? <Link to={`/knowledge/${d.article.id}`} className="inline-flex items-center gap-1.5 text-brand-700 hover:underline"><BookOpen className="h-3.5 w-3.5" /> {d.article.number} · {d.article.title}</Link> : null }],
    },
  ];

  const tabs = [
    {
      key: 'incidents',
      label: 'Linked incidents',
      count: d.linkedIncidents.length,
      content: (
        <section className="card">
          {p.manage && (
            <div className="px-4 py-3 border-b border-default flex flex-col sm:flex-row gap-2 sm:items-start">
              <EntityPicker
                className="flex-1"
                queryKey={`ke-incidents-${d.customerId}`}
                placeholder="Link an incident by number or title…"
                value={incidentPick}
                onChange={setIncidentPick}
                minChars={2}
                search={async (q) => (await ticketsApi.lookup(q, d.customerId, d.id)).items.filter((t) => t.type === 'incident' && !d.linkedIncidents.some((l) => l.id === t.id)).map((t) => ({ id: t.id, label: `${t.number} · ${t.title}`, sublabel: t.status?.label ?? null }))}
              />
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => incidentPick[0] && linkIncident.mutate(incidentPick[0].id)} disabled={!incidentPick.length} loading={linkIncident.isPending}>
                Link incident
              </Button>
            </div>
          )}
          {d.linkedIncidents.length === 0 ? (
            <EmptyState icon={<TicketIcon className="h-5 w-5" />} title="No incidents linked" description="Incidents explained by this known error appear here; link them from the incident's Assist rail or above." />
          ) : (
            <ul className="divide-y divide-[var(--border)] text-[13px]">
              {d.linkedIncidents.map((inc) => (
                <li key={inc.id} className="flex items-center gap-2 px-4 py-2 group">
                  <TicketIcon className="h-3.5 w-3.5 text-subtle shrink-0" />
                  <Link to={`/tickets/${inc.id}`} className="font-mono text-[12px] text-brand-700 hover:underline whitespace-nowrap">{inc.number}</Link>
                  <span className="flex-1 truncate">{inc.title}</span>
                  <span className="text-[12px] text-subtle whitespace-nowrap hidden sm:inline" title={fmtDateTime(inc.createdAt)}>raised {relativeTime(inc.createdAt)}</span>
                  <TicketStatusBadge status={inc.status} />
                  {p.manage && (
                    <button onClick={() => unlinkIncident.mutate(inc.linkId)} className="text-subtle hover:text-red-600 opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100" aria-label="Unlink incident" title="Unlink">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ),
    },
    {
      key: 'cis',
      label: 'Affected CIs',
      count: d.cis.length,
      content: (
        <section className="card">
          {d.cis.length === 0 ? (
            <EmptyState icon={<Server className="h-5 w-5" />} title="No configuration items" description="Attach the affected systems on the problem record's Affected CIs tab." />
          ) : (
            <ul className="divide-y divide-[var(--border)] text-[13px]">
              {d.cis.map((c) => (
                <li key={c.id} className="flex items-center gap-2 px-4 py-2">
                  <Server className="h-3.5 w-3.5 text-subtle shrink-0" />
                  <Link to={`/cmdb/cis/${c.id}`} className="font-medium hover:underline truncate">{c.name}</Link>
                  {c.hostname && <span className="font-mono text-[11.5px] text-subtle truncate">{c.hostname}</span>}
                  <Badge color="slate" className="ml-auto py-0 capitalize">{c.role}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      ),
    },
  ];

  const railRows = [
    { label: 'Customer', value: <Link to={`/customers/${d.customerId}`} className="hover:underline font-medium">{d.customerName}</Link> },
    { label: 'Service', value: d.serviceName },
    { label: 'Team', value: d.teamName },
    { label: 'Owner', value: d.assigneeName },
    { label: 'Problem status', value: d.ticketStatus ? <TicketStatusBadge status={d.ticketStatus} /> : null },
    { label: 'Identified', value: d.identifiedAt ? <span title={fmtDateTime(d.identifiedAt)}>{fmtDate(d.identifiedAt)}</span> : null },
    { label: 'Status since', value: d.keStatusAt ? <span title={fmtDateTime(d.keStatusAt)}>{relativeTime(d.keStatusAt)}</span> : null },
    { label: 'Published by', value: d.publishedByName, hidden: !d.portalVisible },
    { label: 'Updated', value: <span title={fmtDateTime(d.updatedAt)}>{relativeTime(d.updatedAt)}</span> },
  ];

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={crumbs}
            number={d.number}
            title={d.title}
            badges={
              <>
                <TypeBadge type="problem" />
                <Badge color="orange" className="gap-1"><Bug className="h-3 w-3" /> Known error</Badge>
                <KeStatusBadge status={d.keStatus} />
                {d.portalVisible && <Badge color="green" className="gap-1"><Globe className="h-3 w-3" /> Published to portal</Badge>}
                {!active && <Badge color="slate">No longer active</Badge>}
              </>
            }
            primary={primary}
            menu={menu}
            updatedAt={d.updatedAt}
          >
            <RecordRibbon items={ribbon} columns={6} />
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
                key: 'record',
                label: 'Record',
                icon: Info,
                content: (
                  <RailCard title={<><Info className="h-3.5 w-3.5 text-subtle" /> Known error</>}>
                    <RailRows rows={railRows} />
                  </RailCard>
                ),
              },
              { key: 'activity', label: 'Activity', icon: History, badge: audit.entries.length, content: <ActivityStream entries={audit.entries} loading={audit.isLoading} title="History" maxHeight="calc(100vh - 220px)" /> },
            ]}
          />
        }
      />
      <PublishDialog open={publishOpen} onClose={() => setPublishOpen(false)} target={{ id: d.id, number: d.number, title: d.title, customerName: d.customerName, customerSummary: d.customerSummary, customerWorkaround: d.customerWorkaround, portalVisible: d.portalVisible }} canDraft={canDraft} />
      <ConfirmDialog open={confirmUnpublish} onClose={() => setConfirmUnpublish(false)} onConfirm={() => unpublish.mutate()} title="Withdraw from the portal?" description={`Portal users of ${d.customerName} stop seeing this known issue. The wording is kept and can be published again.`} confirmLabel="Withdraw" loading={unpublish.isPending} />
    </>
  );
}

function PortalKnownError({ id }: { id: string }) {
  const navigate = useNavigate();
  const ke = useQuery({ queryKey: pk.knownError(id), queryFn: () => portalApi.knownError(id), enabled: !!id });
  if (ke.isLoading) return <LoadingBlock />;
  if (ke.isError || !ke.data) return <ErrorBlock error={ke.error} retry={() => ke.refetch()} />;
  const d = ke.data;
  const raise = () => navigate(`/portal/tickets/new?title=${encodeURIComponent(d.title)}${d.service ? `&serviceId=${d.service.id}` : ''}`);
  const sections: FormSection[] = [
    { key: 'notice', title: 'What you may notice', columns: 1, fields: [{ label: 'Symptoms', kind: 'prose', value: d.summary ?? '' }] },
    { key: 'workaround', title: 'What to do in the meantime', columns: 1, fields: [{ label: 'Workaround', kind: 'prose', value: d.workaround ?? '' }] },
    {
      key: 'details',
      title: 'Details',
      fields: [
        { label: 'Reference', value: d.number, kind: 'mono' },
        { label: 'Service', value: d.service?.name },
        { label: 'Status', value: <KeStatusBadge status={d.keStatus} portal /> },
      ],
      right: [
        { label: 'Published', value: d.publishedAt ? fmtDateTime(d.publishedAt) : null },
        { label: 'Last updated', value: <span title={fmtDateTime(d.updatedAt)}>{relativeTime(d.updatedAt)}</span> },
      ],
    },
  ];
  return (
    <RecordLayout
      header={
        <RecordHeader
          crumbs={[{ label: 'Knowledge', to: '/knowledge' }, { label: 'Known issues', to: '/knowledge/known-errors' }, { label: d.number }]}
          title={d.title}
          badges={
            <>
              <Badge color="orange" className="gap-1"><Bug className="h-3 w-3" /> Known issue</Badge>
              <KeStatusBadge status={d.keStatus} portal />
            </>
          }
          primary={
            <Button size="sm" icon={<TicketIcon className="h-3.5 w-3.5" />} onClick={raise}>
              Still affected? Raise a ticket
            </Button>
          }
          updatedAt={d.updatedAt}
        >
          <RecordRibbon
            columns={3}
            items={[
              { label: 'Status', value: d.keStatus === 'resolved' ? 'Resolved' : d.keStatus === 'fix_in_progress' ? 'Fix in progress' : 'Open issue', tone: d.keStatus === 'resolved' ? 'good' : d.keStatus === 'open' ? 'warn' : 'default' },
              { label: 'Service', value: d.service?.name ?? '—' },
              { label: 'Published', value: d.publishedAt ? fmtDate(d.publishedAt) : '—' },
            ]}
          />
        </RecordHeader>
      }
      main={<RecordForm sections={sections} />}
    />
  );
}
