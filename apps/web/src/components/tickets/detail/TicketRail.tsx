import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Users, BookOpen, Copy, Eye, EyeOff, X, Mail, Phone } from 'lucide-react';
import { Select, Avatar, Badge } from '@/components/ui';
import { RailCard, RailRows } from '@/components/record';
import { useEngineers } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { get } from '@/api/client';
import { fmtDate } from '@/lib/format';
import { truncate } from '@/lib/utils';
import { ticketsApi, qk, itemsOf } from '../api';
import { SlaCard } from '../SlaCard';
import { TicketStatusBadge, TypeBadge } from '../TicketStatusBadge';
import type { TicketDetail } from '../types';
import { TicketAiPanel } from '@/components/ai/TicketAiPanel';
import { ChangeImpactCard } from '@/components/ai/ChangeImpactCard';

/** Right-rail "Details": who the ticket is for, the SLA clocks, the people around it. Attachments live in the form. */
export function TicketDetailsRail({ ticket }: { ticket: TicketDetail }) {
  const qc = useQueryClient();
  const engineers = useEngineers();
  const user = useAuthStore((s) => s.user)!;
  const isCustomer = user.userType === 'customer';
  const p = ticket.permissions;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tickets', ticket.id] });
  const watch = useMutation({ mutationFn: (input: { userId?: string; remove?: boolean }) => (input.remove ? ticketsApi.unwatch(ticket.id, input.userId) : ticketsApi.watch(ticket.id, input.userId)), onSuccess: invalidate, onError: (e: Error) => toast.error(e.message) });
  const [watcherPick, setWatcherPick] = useState('');
  const person = (p: { name: string; email?: string | null; phone?: string | null } | null | undefined) =>
    p ? (
      <span className="inline-flex items-center gap-1.5">
        <Avatar name={p.name} size="xs" /> {p.name}
        {p.email && <a href={`mailto:${p.email}`} className="text-subtle hover:text-default" title={p.email}><Mail className="h-3 w-3" /></a>}
        {p.phone && <a href={`tel:${p.phone}`} className="text-subtle hover:text-default" title={p.phone}><Phone className="h-3 w-3" /></a>}
      </span>
    ) : null;
  return (
    <>
      <RailCard title={<><Building2 className="h-3.5 w-3.5 text-subtle" /> Customer</>}>
        <RailRows
          rows={[
            { label: 'Account', value: isCustomer ? ticket.customer?.name : ticket.customer ? <Link to={`/customers/${ticket.customerId}`} className="hover:underline font-medium">{ticket.customer.name}</Link> : null },
            { label: 'Site', value: ticket.site?.name },
            { label: 'Service', value: ticket.service?.name },
            { label: 'Contract', value: ticket.contract ? (isCustomer ? ticket.contract.number : <Link to={`/contracts/${ticket.contract.id}`} className="hover:underline">{ticket.contract.number}</Link>) : <span className="text-amber-700">No active contract</span> },
            { label: 'Contract ends', value: ticket.contract?.endDate ? fmtDate(ticket.contract.endDate) : null, hidden: !ticket.contract },
            { label: 'SLA policy', value: ticket.slaPolicy?.name ?? ticket.contract?.slaPolicyName },
          ]}
        />
      </RailCard>
      <SlaCard slas={ticket.slas} policyName={ticket.slaPolicy?.name} />
      <RailCard
        title={<><Users className="h-3.5 w-3.5 text-subtle" /> People</>}
        action={p.watch ? <button onClick={() => watch.mutate({ remove: ticket.isWatching })} className="text-[12px] text-brand-700 hover:underline inline-flex items-center gap-1">{ticket.isWatching ? <><EyeOff className="h-3 w-3" /> Unwatch</> : <><Eye className="h-3 w-3" /> Watch</>}</button> : undefined}
      >
        <RailRows
          rows={[
            { label: 'Requester', value: person(ticket.requester) ?? person(ticket.requesterContact) },
            { label: 'Opened by', value: ticket.createdByUser?.name },
            { label: 'Assigned to', value: ticket.assignee ? person(ticket.assignee) : <span className="text-amber-700">Unassigned</span> },
            { label: 'Team', value: ticket.team?.name },
          ]}
        />
        <div className="mt-2 pt-2 border-t border-default/60">
          <div className="text-[12px] text-muted mb-1">Watchers</div>
          <div className="flex flex-wrap gap-1">
            {ticket.watchers.map((w) => (
              <Badge key={w.id} color="slate" className="gap-1">
                {w.name}
                {p.update && w.id !== user.id && (
                  <button onClick={() => watch.mutate({ userId: w.id, remove: true })} className="opacity-60 hover:opacity-100" aria-label="Remove watcher"><X className="h-3 w-3" /></button>
                )}
              </Badge>
            ))}
            {!ticket.watchers.length && <span className="text-[12.5px] text-subtle">Nobody yet</span>}
          </div>
          {p.update && !isCustomer && (
            <Select value={watcherPick} onChange={(e) => { if (e.target.value) { watch.mutate({ userId: e.target.value }); setWatcherPick(''); } }} placeholder="Add watcher…" className="h-7 py-0 text-[12.5px] mt-1.5" options={(engineers.data ?? []).filter((e) => !ticket.watchers.some((w) => w.id === e.id)).map((e) => ({ value: e.id, label: e.name }))} />
          )}
        </div>
      </RailCard>
    </>
  );
}

/** Right-rail "Assist": Grady's proposals, change impact, similar tickets and knowledge. */
export function TicketAssistRail({ ticket }: { ticket: TicketDetail }) {
  const user = useAuthStore((s) => s.user)!;
  const isCustomer = user.userType === 'customer';
  const p = ticket.permissions;
  const similar = useQuery({ queryKey: qk.similar(ticket.id), queryFn: () => ticketsApi.similar(ticket.id), staleTime: 60_000, retry: false });
  const kb = useQuery({
    queryKey: ['knowledge', 'suggest', ticket.id, ticket.title],
    queryFn: () => get<unknown>('/knowledge/suggest', { q: ticket.title, serviceId: ticket.serviceId ?? undefined, customerId: ticket.customerId }).then((d) => itemsOf<{ id: string; number: string; title: string; summary?: string | null; articleType?: string }>(d)),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return (
    <>
      <TicketAiPanel ticket={ticket} />
      {ticket.type === 'change' && !isCustomer && <ChangeImpactCard ticketId={ticket.id} canManage={p.change} />}
      <RailCard title={<><Copy className="h-3.5 w-3.5 text-subtle" /> Similar tickets</>} padded={false}>
        {similar.isLoading ? (
          <div className="px-4 py-3 text-[12.5px] text-muted">Searching…</div>
        ) : !similar.data?.items.length ? (
          <div className="px-4 py-3 text-[12.5px] text-subtle">No similar tickets found.</div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {similar.data.items.slice(0, 5).map((s) => (
              <li key={s.id} className="px-4 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <TypeBadge type={s.type} short className="px-1 py-0 text-[10px]" />
                  <Link to={isCustomer ? `/portal/tickets/${s.id}` : `/tickets/${s.id}`} className="font-mono text-[12px] text-brand-700 hover:underline">{s.number}</Link>
                  <TicketStatusBadge status={s.status} className="ml-auto" />
                </div>
                <div className="text-[12.5px] truncate" title={s.title}>{s.title}</div>
                {s.resolutionNotes && <div className="text-[11.5px] text-muted mt-0.5 line-clamp-2">{truncate(s.resolutionNotes, 140)}</div>}
              </li>
            ))}
          </ul>
        )}
      </RailCard>
      <RailCard title={<><BookOpen className="h-3.5 w-3.5 text-subtle" /> Knowledge</>} padded={false}>
        {kb.isError ? (
          <div className="px-4 py-3 text-[12.5px] text-subtle">Suggestions unavailable.</div>
        ) : kb.isLoading ? (
          <div className="px-4 py-3 text-[12.5px] text-muted">Searching…</div>
        ) : !kb.data?.length ? (
          <div className="px-4 py-3 text-[12.5px] text-subtle">No matching articles.</div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {kb.data.slice(0, 5).map((a) => (
              <li key={a.id} className="px-4 py-2">
                <Link to={`/knowledge/${a.id}`} className="text-[12.5px] font-medium hover:underline block truncate">{a.title}</Link>
                <div className="text-[11.5px] text-muted truncate">{a.number}{a.articleType ? ` · ${a.articleType.replace(/_/g, ' ')}` : ''}</div>
              </li>
            ))}
          </ul>
        )}
      </RailCard>
    </>
  );
}
