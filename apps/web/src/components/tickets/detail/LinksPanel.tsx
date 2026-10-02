import { useState } from 'react';
import { Panel } from '../Panel';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Link2, Plus, X } from 'lucide-react';
import { Button, Select } from '@/components/ui';
import { ticketsApi } from '../api';
import { EntityPicker, type PickerItem } from '../EntityPicker';
import { TicketStatusBadge, TypeBadge } from '../TicketStatusBadge';
import type { LinkedTicket, TicketDetail } from '../types';
import { LINK_TYPE_LABELS } from '../types';

const LINK_TYPES = Object.keys(LINK_TYPE_LABELS);

/** Related tickets with add-by-number search. */
export function LinksPanel({ ticket, links, canEdit }: { ticket: TicketDetail; links: LinkedTicket[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<PickerItem[]>([]);
  const [linkType, setLinkType] = useState('related');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tickets', ticket.id] });
  const add = useMutation({
    mutationFn: () => ticketsApi.addLink(ticket.id, { targetTicketId: target[0]!.id, linkType }),
    onSuccess: () => {
      setTarget([]);
      setOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: (linkId: string) => ticketsApi.removeLink(ticket.id, linkId), onSuccess: invalidate, onError: (e: Error) => toast.error(e.message) });
  if (!links.length && !canEdit && !ticket.parent) return null;
  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Link2 className="h-4 w-4 text-subtle" /> Linked tickets</span>} actions={canEdit ? <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen((o) => !o)}>Link</Button> : undefined} padded={false}>
      {open && canEdit && (
        <div className="px-4 py-3 border-b border-default flex flex-col sm:flex-row gap-2 sm:items-start">
          <Select value={linkType} onChange={(e) => setLinkType(e.target.value)} className="sm:w-40 h-8 py-0 text-[13px]" options={LINK_TYPES.map((k) => ({ value: k, label: LINK_TYPE_LABELS[k]! }))} />
          <EntityPicker
            className="flex-1"
            queryKey={`tickets-${ticket.customerId}`}
            placeholder="Search by ticket number or title…"
            value={target}
            onChange={setTarget}
            minChars={2}
            search={async (q) => (await ticketsApi.lookup(q, ticket.customerId, ticket.id)).items.map((t) => ({ id: t.id, label: `${t.number} · ${t.title}`, sublabel: t.status?.label ?? null }))}
          />
          <Button size="sm" onClick={() => add.mutate()} disabled={!target.length} loading={add.isPending}>
            Add link
          </Button>
        </div>
      )}
      <ul className="divide-y divide-[var(--border)]">
        {ticket.parent && (
          <li className="flex items-center gap-2 px-4 py-2 text-[13px]">
            <span className="text-muted w-28 shrink-0 text-[12px]">Parent</span>
            <Link to={`/tickets/${ticket.parent.id}`} className="font-mono text-brand-700 hover:underline">{ticket.parent.number}</Link>
            <span className="truncate">{ticket.parent.title}</span>
          </li>
        )}
        {links.map((l) => (
          <li key={l.id} className="flex items-center gap-2 px-4 py-2 text-[13px] group">
            <span className="text-muted w-28 shrink-0 text-[12px]">{l.direction === 'outbound' ? LINK_TYPE_LABELS[l.linkType] ?? l.linkType : `← ${LINK_TYPE_LABELS[l.linkType] ?? l.linkType}`}</span>
            <TypeBadge type={l.ticket.type} short className="px-1 py-0 text-[10px]" />
            <Link to={`/tickets/${l.ticket.id}`} className="font-mono text-brand-700 hover:underline whitespace-nowrap">{l.ticket.number}</Link>
            <span className="truncate flex-1">{l.ticket.title}</span>
            <TicketStatusBadge status={l.ticket.status} />
            {canEdit && (
              <button onClick={() => remove.mutate(l.id)} className="text-subtle hover:text-red-600 opacity-0 group-hover:opacity-100" aria-label="Remove link">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
        {!links.length && !ticket.parent && <li className="px-4 py-3 text-[12.5px] text-muted">No linked tickets.</li>}
      </ul>
    </Panel>
  );
}
