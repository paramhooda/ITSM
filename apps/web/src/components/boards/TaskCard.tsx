import type { DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { CheckCheck, Clock } from 'lucide-react';
import { Avatar } from '@/components/ui';
import type { MenuItem } from '@/components/Menu';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { SlaIndicator } from '@/components/tickets/SlaIndicator';
import { cn } from '@/lib/utils';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { CardMenu } from './CardMenu';
import { asOption, shortAge, shortDistance } from './cardUtils';
import type { TaskCard } from './api';

function Due({ card }: { card: TaskCard }) {
  if (card.status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-600" title={card.completedAt ? `Done ${fmtDateTime(card.completedAt)}` : 'Done'}>
        <CheckCheck className="h-3.5 w-3.5" /> done {card.completedAt ? relativeTime(card.completedAt) : ''}
      </span>
    );
  }
  if (card.status === 'cancelled') return <span className="text-subtle">cancelled</span>;
  if (!card.dueAt) return null;
  const d = shortDistance(card.dueAt);
  if (card.overdue || d.minutes < 0) {
    return (
      <span className="inline-flex items-center gap-1 text-red-600 font-medium" title={`Was due ${fmtDateTime(card.dueAt)}`} data-overdue>
        <Clock className="h-3.5 w-3.5" /> overdue {d.text}
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1', d.minutes < 240 ? 'text-amber-600' : 'text-muted')} title={`Due ${fmtDateTime(card.dueAt)}`}>
      <Clock className="h-3.5 w-3.5" /> due in {d.text}
    </span>
  );
}

/**
 * A task on the board: the task title, the parent ticket (number and title), the ticket's
 * priority and SLA, the due state ("due in 2h", red "overdue 1d"), the customer, the age
 * and the owner. The menu carries the quick actions.
 */
export function TaskCardView({ card, index, draggable, dragging, onDragStart, onDragEnd, menu }: { card: TaskCard; index: number; draggable: boolean; dragging?: boolean; onDragStart?: (e: DragEvent) => void; onDragEnd?: (e: DragEvent) => void; menu: MenuItem[] }) {
  const start = (e: DragEvent) => {
    if ((e.target as HTMLElement | null)?.closest('[data-card-menu]')) {
      e.preventDefault();
      return;
    }
    onDragStart?.(e);
  };
  const done = card.status === 'done' || card.status === 'cancelled';
  return (
    <article
      data-card={card.id}
      data-lane-key={card.lane}
      data-index={index}
      draggable={draggable}
      onDragStart={draggable ? start : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      className={cn('card p-2.5 border-l-2 select-none min-w-0', card.overdue ? 'border-l-red-500' : done ? 'border-l-emerald-400' : 'border-l-transparent', draggable && 'cursor-grab active:cursor-grabbing', dragging && 'opacity-50', done && 'opacity-80')}
      aria-label={`${card.ticketNumber} task ${card.title}`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <Link to={`/tickets/${card.ticketId}`} draggable={false} className="font-mono text-[12px] text-brand-700 hover:underline shrink-0">
          {card.ticketNumber}
        </Link>
        <PriorityBadge priority={asOption(card.ticketPriority)} compact className="text-[10px] px-1 py-0 leading-[14px]" />
        <span className="flex-1" />
        <CardMenu items={menu} label={`Actions for the task ${card.title}`} />
      </div>
      <div className={cn('text-[13px] font-medium text-default leading-snug line-clamp-2 mt-1', done && 'line-through text-muted')}>{card.title}</div>
      <Link to={`/tickets/${card.ticketId}`} draggable={false} className="block text-[11.5px] text-muted truncate mt-0.5 hover:underline" title={card.ticketTitle}>
        {card.ticketTitle}
      </Link>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11.5px] text-muted min-w-0">
        <SlaIndicator sla={card.ticketSla} />
        <Due card={card} />
      </div>
      <div className="flex items-center justify-between gap-2 mt-2 min-w-0">
        <span className="text-[11.5px] text-muted truncate" title={card.customerName ?? undefined}>
          {card.customerName ?? '—'}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="tnum text-[11px] text-subtle" title={`Created ${fmtDateTime(card.createdAt)}`}>
            {shortAge(card.ageMinutes)}
          </span>
          {card.assigneeName ? <Avatar name={card.assigneeName} size="xs" className="ring-1 ring-white" /> : <span className="h-5 w-5 rounded-full border border-dashed border-strong inline-block" title="Unassigned" aria-label="Unassigned" />}
        </span>
      </div>
    </article>
  );
}
