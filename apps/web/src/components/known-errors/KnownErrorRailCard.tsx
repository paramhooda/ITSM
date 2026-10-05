import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bug, ExternalLink } from 'lucide-react';
import { RailCard } from '@/components/record';
import { ticketsApi } from '@/components/tickets/api';
import type { TicketDetail } from '@/components/tickets/types';
import { truncate } from '@/lib/utils';
import { KeStatusBadge } from './KeStatusBadge';
import { KnownErrorSuggestionList, fromStaffRow } from './KnownErrorSuggestions';

/**
 * Assist rail card on a staff incident: the linked known error with its workaround, or the best
 * matches the ticket read already computed, each with a Link button that creates the `problem_of` link.
 */
export function KnownErrorRailCard({ ticket }: { ticket: TicketDetail }) {
  const qc = useQueryClient();
  const ke = ticket.knownError;
  const link = useMutation({
    mutationFn: (targetTicketId: string) => ticketsApi.addLink(ticket.id, { targetTicketId, linkType: 'problem_of' }),
    onSuccess: () => {
      toast.success('Known error linked to the incident');
      qc.invalidateQueries({ queryKey: ['tickets', ticket.id] });
      qc.invalidateQueries({ queryKey: ['known-errors'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (ticket.type !== 'incident' || !ke) return null;
  const linked = ke.linked;
  return (
    <RailCard title={<><Bug className="h-3.5 w-3.5 text-orange-500" /> Known errors</>} padded={false}>
      {linked ? (
        <div className="px-4 py-3 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-[12px] text-subtle shrink-0">{linked.number}</span>
            <KeStatusBadge status={linked.keStatus} className="py-0" />
          </div>
          <Link to={`/knowledge/known-errors/${linked.id}`} className="text-[13px] font-medium hover:underline">{linked.title}</Link>
          {linked.workaround ? (
            <div>
              <div className="text-[11.5px] uppercase tracking-wide text-subtle">Workaround</div>
              <p className="text-[12.5px] text-muted whitespace-pre-wrap break-words">{truncate(linked.workaround, 400)}</p>
            </div>
          ) : (
            <p className="text-[12.5px] text-subtle">No workaround documented yet.</p>
          )}
          {linked.fixChange && (
            <div className="text-[12px] text-muted">
              Permanent fix: <Link to={`/tickets/${linked.fixChange.id}`} className="font-mono text-brand-700 hover:underline">{linked.fixChange.number}</Link>
            </div>
          )}
          <Link to={`/knowledge/known-errors/${linked.id}`} className="text-[12px] text-brand-700 hover:underline inline-flex items-center gap-1">
            Open known error <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      ) : ke.suggestions.length > 0 ? (
        <div className="px-3 py-2">
          <KnownErrorSuggestionList items={ke.suggestions.map(fromStaffRow)} title={null} newTab={false} className="border-0 bg-transparent" onLink={ticket.permissions.links ? (s) => link.mutate(s.id) : undefined} linking={link.isPending ? (link.variables ?? null) : null} />
        </div>
      ) : (
        <div className="px-4 py-3 text-[12.5px] text-subtle">No known error matches this incident.</div>
      )}
    </RailCard>
  );
}
