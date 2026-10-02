import { useState } from 'react';
import { Panel } from '../Panel';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, UserPlus, Users, BookOpen, Copy, Eye, EyeOff, X, Mail, Phone } from 'lucide-react';
import { Select, Button, Input, Avatar, Badge } from '@/components/ui';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { get } from '@/api/client';
import { fmtDate, relativeTime } from '@/lib/format';
import { truncate } from '@/lib/utils';
import { ticketsApi, qk, itemsOf } from '../api';
import { SlaCard } from '../SlaCard';
import { TicketStatusBadge, TypeBadge } from '../TicketStatusBadge';
import { AttachmentsSection } from '../AttachmentsSection';
import type { TicketDetail } from '../types';
import { TicketAiPanel } from '@/components/ai/TicketAiPanel';
import { ChangeImpactCard } from '@/components/ai/ChangeImpactCard';

function InlineSelect({ label, value, options, onChange, disabled, placeholder = '—' }: { label: string; value: string | null | undefined; options: { value: string; label: string }[]; onChange: (v: string | null) => void; disabled?: boolean; placeholder?: string }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-24 shrink-0 text-[11.5px] uppercase tracking-wide text-subtle font-medium">{label}</span>
      {disabled ? <span className="text-[13px] truncate">{options.find((o) => o.value === value)?.label ?? <span className="text-subtle">{placeholder}</span>}</span> : <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} placeholder={placeholder} className="h-7 py-0 text-[12.5px] flex-1 min-w-0" options={options} />}
    </div>
  );
}

export function ContextPanel({ ticket }: { ticket: TicketDetail }) {
  const qc = useQueryClient();
  const { options, lookups } = useLookups();
  const engineers = useEngineers();
  const user = useAuthStore((s) => s.user)!;
  const isCustomer = user.userType === 'customer';
  const p = ticket.permissions;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tickets', ticket.id] });
  const update = useMutation({ mutationFn: (body: Record<string, unknown>) => ticketsApi.update(ticket.id, body), onSuccess: invalidate, onError: (e: Error) => toast.error(e.message) });
  const assign = useMutation({ mutationFn: (body: Record<string, unknown>) => ticketsApi.assign(ticket.id, body), onSuccess: invalidate, onError: (e: Error) => toast.error(e.message) });
  const watch = useMutation({ mutationFn: (input: { userId?: string; remove?: boolean }) => (input.remove ? ticketsApi.unwatch(ticket.id, input.userId) : ticketsApi.watch(ticket.id, input.userId)), onSuccess: invalidate, onError: (e: Error) => toast.error(e.message) });
  const [tagInput, setTagInput] = useState('');
  const [watcherPick, setWatcherPick] = useState('');

  const similar = useQuery({ queryKey: qk.similar(ticket.id), queryFn: () => ticketsApi.similar(ticket.id), staleTime: 60_000, retry: false });
  const kb = useQuery({
    queryKey: ['knowledge', 'suggest', ticket.id, ticket.title],
    queryFn: () => get<unknown>('/knowledge/suggest', { q: ticket.title, serviceId: ticket.serviceId ?? undefined, customerId: ticket.customerId }).then((d) => itemsOf<{ id: string; number: string; title: string; summary?: string | null; articleType?: string }>(d)),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const teamEngineers = (engineers.data ?? []).filter((e) => !ticket.assignedTeamId || e.teamIds.includes(ticket.assignedTeamId) || e.id === ticket.assigneeId);
  const subcats = options('ticket_subcategory').filter((o) => o.parentId === ticket.categoryId);
  const isSoc = ticket.domain === 'soc' || ticket.category?.domain === 'soc';
  const closed = ['closed', 'cancelled'].includes(ticket.status?.category ?? '');

  return (
    <div className="flex flex-col gap-3">
      {/* customer */}
      <Panel title={<span className="inline-flex items-center gap-2"><Building2 className="h-4 w-4 text-subtle" /> Customer</span>}>
        <div className="flex flex-col gap-1 text-[13px]">
          {isCustomer ? <div className="font-medium">{ticket.customer?.name}</div> : <Link to={`/customers/${ticket.customerId}`} className="font-medium hover:underline">{ticket.customer?.name ?? '—'}</Link>}
          <div className="text-[12.5px] text-muted">{ticket.site ? `${ticket.site.name}` : 'No site'}{ticket.service ? ` · ${ticket.service.name}` : ''}</div>
          {ticket.contract ? (
            <div className="text-[12.5px] text-muted">
              {isCustomer ? <span>{ticket.contract.number}</span> : <Link to={`/contracts/${ticket.contract.id}`} className="hover:underline">{ticket.contract.number}</Link>}
              {ticket.contract.slaPolicyName ? ` · ${ticket.contract.slaPolicyName}` : ''}
              {ticket.contract.endDate ? <span className="text-subtle"> · ends {fmtDate(ticket.contract.endDate)}</span> : null}
            </div>
          ) : (
            <div className="text-[12.5px] text-subtle">No active contract</div>
          )}
          {ticket.slaPolicy?.name && ticket.slaPolicy.name !== ticket.contract?.slaPolicyName && <div className="text-[12px] text-subtle">SLA policy: {ticket.slaPolicy.name}</div>}
        </div>
      </Panel>

      <SlaCard slas={ticket.slas} policyName={ticket.slaPolicy?.name} />

      {/* AI assistance (proposals only; applied through the normal ticket endpoints) */}
      <TicketAiPanel ticket={ticket} />
      {ticket.type === 'change' && !isCustomer && <ChangeImpactCard ticketId={ticket.id} canManage={p.change} />}

      {/* assignment */}
      {!isCustomer && (
        <Panel title="Assignment" actions={p.assign && ticket.assigneeId !== user.id && !closed ? <Button size="sm" variant="ghost" icon={<UserPlus className="h-3.5 w-3.5" />} onClick={() => assign.mutate({ assigneeId: user.id, autoProgress: true })}>Assign to me</Button> : undefined}>
          <div className="flex flex-col gap-2">
            <InlineSelect label="Team" value={ticket.assignedTeamId} disabled={!p.assign || closed} placeholder="No team" options={(lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(v) => assign.mutate({ teamId: v, assigneeId: null })} />
            <InlineSelect label="Engineer" value={ticket.assigneeId} disabled={!p.assign || closed} placeholder="Unassigned" options={teamEngineers.map((e) => ({ value: e.id, label: e.name }))} onChange={(v) => assign.mutate({ assigneeId: v, autoProgress: true })} />
            {ticket.assignee && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                <Avatar name={ticket.assignee.name} size="xs" /> {ticket.assignee.name} <span className="text-subtle">{ticket.assignee.email}</span>
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* details */}
      <Panel title="Details">
        <div className="flex flex-col">
          <InlineSelect label="Category" value={ticket.categoryId} disabled={!p.update} options={options('ticket_category').map((o) => ({ value: o.id, label: o.label }))} onChange={(v) => update.mutate({ categoryId: v, subcategoryId: null })} />
          {(subcats.length > 0 || ticket.subcategoryId) && <InlineSelect label="Subcategory" value={ticket.subcategoryId} disabled={!p.update} options={subcats.map((o) => ({ value: o.id, label: o.label }))} onChange={(v) => update.mutate({ subcategoryId: v })} />}
          <InlineSelect label="Impact" value={ticket.impactId} disabled={!p.update} options={options('ticket_impact').map((o) => ({ value: o.id, label: o.label }))} onChange={(v) => update.mutate({ impactId: v })} />
          <InlineSelect label="Urgency" value={ticket.urgencyId} disabled={!p.update} options={options('ticket_urgency').map((o) => ({ value: o.id, label: o.label }))} onChange={(v) => update.mutate({ urgencyId: v })} />
          {!isCustomer && <InlineSelect label="Source" value={ticket.sourceId} disabled={!p.update} options={options('ticket_source').map((o) => ({ value: o.id, label: o.label }))} onChange={(v) => update.mutate({ sourceId: v })} />}
          {isSoc && <InlineSelect label="Severity" value={ticket.securitySeverityId} disabled={!p.update} options={options('security_severity').map((o) => ({ value: o.id, label: o.label }))} onChange={(v) => update.mutate({ securitySeverityId: v })} />}
          {!isCustomer && (
            <div className="flex items-start gap-2 py-1">
              <span className="w-24 shrink-0 text-[11.5px] uppercase tracking-wide text-subtle font-medium pt-1.5">Tags</span>
              <div className="flex-1 flex flex-wrap items-center gap-1">
                {ticket.tags.map((t) => (
                  <Badge key={t} color="slate" className="gap-1">
                    {t}
                    {p.update && (
                      <button onClick={() => update.mutate({ tags: ticket.tags.filter((x) => x !== t) })} aria-label={`Remove ${t}`} className="opacity-60 hover:opacity-100">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </Badge>
                ))}
                {p.update && (
                  <Input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="+ tag"
                    className="h-6 py-0 w-20 text-[12px] px-1.5"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && tagInput.trim()) {
                        update.mutate({ tags: [...new Set([...ticket.tags, tagInput.trim()])] });
                        setTagInput('');
                      }
                    }}
                  />
                )}
                {!p.update && !ticket.tags.length && <span className="text-[12.5px] text-subtle">—</span>}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 py-1">
            <span className="w-24 shrink-0 text-[11.5px] uppercase tracking-wide text-subtle font-medium">Created</span>
            <span className="text-[12.5px]" title={ticket.createdAt}>{relativeTime(ticket.createdAt)}{ticket.createdByUser ? ` by ${ticket.createdByUser.name}` : ''}</span>
          </div>
          {ticket.externalRef && (
            <div className="flex items-center gap-2 py-1">
              <span className="w-24 shrink-0 text-[11.5px] uppercase tracking-wide text-subtle font-medium">External</span>
              <span className="text-[12.5px] font-mono">{ticket.externalRef}</span>
            </div>
          )}
        </div>
      </Panel>

      {/* people */}
      <Panel title={<span className="inline-flex items-center gap-2"><Users className="h-4 w-4 text-subtle" /> People</span>}>
        <div className="flex flex-col gap-2 text-[13px]">
          <div>
            <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Requester</div>
            {ticket.requester ? (
              <div className="flex items-center gap-2 mt-0.5"><Avatar name={ticket.requester.name} size="xs" /> {ticket.requester.name}{ticket.requester.email && <a href={`mailto:${ticket.requester.email}`} className="text-subtle hover:text-default" title={ticket.requester.email}><Mail className="h-3 w-3" /></a>}</div>
            ) : ticket.requesterContact ? (
              <div className="flex items-center gap-2 mt-0.5"><Avatar name={ticket.requesterContact.name} size="xs" /> {ticket.requesterContact.name}{ticket.requesterContact.email && <a href={`mailto:${ticket.requesterContact.email}`} className="text-subtle hover:text-default"><Mail className="h-3 w-3" /></a>}{ticket.requesterContact.phone && <a href={`tel:${ticket.requesterContact.phone}`} className="text-subtle hover:text-default"><Phone className="h-3 w-3" /></a>}</div>
            ) : (
              <div className="text-subtle text-[12.5px]">—</div>
            )}
          </div>
          <div>
            <div className="flex items-center justify-between">
              <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Watchers</div>
              {p.watch && (
                <button onClick={() => watch.mutate({ remove: ticket.isWatching })} className="text-[12px] text-brand-700 hover:underline inline-flex items-center gap-1">
                  {ticket.isWatching ? <><EyeOff className="h-3 w-3" /> Unwatch</> : <><Eye className="h-3 w-3" /> Watch</>}
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1 mt-1">
              {ticket.watchers.map((w) => (
                <Badge key={w.id} color="slate" className="gap-1">
                  {w.name}
                  {p.update && w.id !== user.id && (
                    <button onClick={() => watch.mutate({ userId: w.id, remove: true })} className="opacity-60 hover:opacity-100" aria-label="Remove watcher">
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </Badge>
              ))}
              {!ticket.watchers.length && <span className="text-[12.5px] text-subtle">Nobody yet</span>}
            </div>
            {p.update && !isCustomer && (
              <Select value={watcherPick} onChange={(e) => { if (e.target.value) { watch.mutate({ userId: e.target.value }); setWatcherPick(''); } }} placeholder="Add watcher…" className="h-7 py-0 text-[12.5px] mt-1.5" options={(engineers.data ?? []).filter((e) => !ticket.watchers.some((w) => w.id === e.id)).map((e) => ({ value: e.id, label: e.name }))} />
            )}
          </div>
        </div>
      </Panel>

      {/* similar */}
      <Panel title={<span className="inline-flex items-center gap-2"><Copy className="h-4 w-4 text-subtle" /> Similar tickets</span>} padded={false}>
        {similar.isLoading ? (
          <div className="px-4 py-3 text-[12.5px] text-muted">Searching…</div>
        ) : !similar.data?.items.length ? (
          <div className="px-4 py-3 text-[12.5px] text-muted">No similar tickets found.</div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {similar.data.items.slice(0, 6).map((s) => (
              <li key={s.id} className="px-4 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <TypeBadge type={s.type} short className="px-1 py-0 text-[10px]" />
                  <Link to={isCustomer ? `/portal/tickets/${s.id}` : `/tickets/${s.id}`} className="font-mono text-[12px] text-brand-700 hover:underline">{s.number}</Link>
                  <TicketStatusBadge status={s.status} className="ml-auto" />
                </div>
                <div className="text-[12.5px] truncate" title={s.title}>{s.title}</div>
                {!s.sameCustomer && s.customerName && <div className="text-[11px] text-subtle">{s.customerName}</div>}
                {s.resolutionNotes && <div className="text-[11.5px] text-muted mt-0.5 line-clamp-2">{truncate(s.resolutionNotes, 140)}</div>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* knowledge */}
      <Panel title={<span className="inline-flex items-center gap-2"><BookOpen className="h-4 w-4 text-subtle" /> Knowledge</span>} padded={false}>
        {kb.isError ? (
          <div className="px-4 py-3 text-[12.5px] text-muted">Suggestions unavailable.</div>
        ) : kb.isLoading ? (
          <div className="px-4 py-3 text-[12.5px] text-muted">Searching…</div>
        ) : !kb.data?.length ? (
          <div className="px-4 py-3 text-[12.5px] text-muted">No matching articles.</div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {kb.data.slice(0, 5).map((a) => (
              <li key={a.id} className="px-4 py-2">
                <Link to={`/knowledge/${a.id}`} className="text-[12.5px] font-medium hover:underline block truncate">{a.title}</Link>
                <div className="text-[11.5px] text-muted truncate">{a.number}{a.articleType ? ` · ${a.articleType.replace(/_/g, ' ')}` : ''}{a.summary ? ` — ${truncate(a.summary, 90)}` : ''}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Attachments">
        <AttachmentsSection entityType="ticket" entityId={ticket.id} customerId={ticket.customerId} canUpload={p.comment || p.update} canDelete={p.update} showVisibility={!isCustomer} />
      </Panel>
    </div>
  );
}
