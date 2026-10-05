import { Link } from 'react-router-dom';
import { MapPin, UserRound, MessageSquareWarning, Star } from 'lucide-react';
import { RatingBadge } from '@/components/surveys/RatingBadge';
import { TicketStatusBadge, TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { slaPhrase, type PortalTicketRow } from './api';

const TONE = { good: 'text-emerald-600', warn: 'text-amber-600', bad: 'text-red-600', neutral: 'text-subtle' };

/** "Due <relative>" for open tickets, "Resolved"/"Closed" otherwise. */
export function TicketSla({ row, className }: { row: Pick<PortalTicketRow, 'sla' | 'status'>; className?: string }) {
  const p = slaPhrase(row.sla, row.status);
  if (p.text) return <span className={cn('text-xs', TONE[p.tone], className)}>{p.text}</span>;
  const sla = row.sla!;
  return (
    <span className={cn('text-xs tabular-nums', TONE[p.tone], className)} title={fmtDateTime(sla.dueAt)}>
      Due {relativeTime(sla.dueAt)}
    </span>
  );
}

/** Mobile-friendly card for one ticket in the portal list. */
export function TicketCard({ row }: { row: PortalTicketRow }) {
  return (
    <Link to={`/portal/tickets/${row.id}`} className={cn('card block px-4 py-3 hover:border-brand-400 transition-colors', row.awaitingCustomer && 'border-amber-300/70')}>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <span className="font-mono text-default">{row.number}</span>
        <TypeBadge type={row.type} short className="px-1 py-0 text-[10px]" />
        <span className="ml-auto" title={fmtDateTime(row.lastActivityAt)}>
          {relativeTime(row.lastActivityAt)}
        </span>
      </div>
      <div className="mt-1 font-medium text-[14px] leading-snug">{row.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TicketStatusBadge status={row.status} />
        <PriorityBadge priority={row.priority} compact />
        <TicketSla row={row} />
        {row.awaitingCustomer && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-amber-700">
            <MessageSquareWarning className="h-3.5 w-3.5" /> Needs your reply
          </span>
        )}
        {row.surveyPending && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-amber-700">
            <Star className="h-3.5 w-3.5" /> Rate this ticket
          </span>
        )}
        {row.csatRating != null && <RatingBadge rating={row.csatRating} />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
        {row.siteName && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" /> {row.siteName}
          </span>
        )}
        {row.requesterName && (
          <span className="inline-flex items-center gap-1">
            <UserRound className="h-3 w-3" /> {row.isMine ? 'You' : row.requesterName}
          </span>
        )}
        {row.assigneeName && <span>Engineer: {row.assigneeName}</span>}
      </div>
    </Link>
  );
}
