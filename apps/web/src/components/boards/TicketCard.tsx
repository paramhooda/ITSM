import type { DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { Flame, ListTodo, PauseCircle } from 'lucide-react';
import { Avatar, Badge } from '@/components/ui';
import type { MenuItem } from '@/components/Menu';
import { TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { SlaIndicator, slaTone } from '@/components/tickets/SlaIndicator';
import { RiskBadge } from '@/components/tickets/RiskBadge';
import { cn } from '@/lib/utils';
import { fmtDateTime } from '@/lib/format';
import { CardMenu } from './CardMenu';
import { asOption, shortAge } from './cardUtils';
import type { TicketCard } from './api';

const RAIL: Record<ReturnType<typeof slaTone>, string> = { bad: 'border-l-red-500', warn: 'border-l-amber-500', good: 'border-l-transparent', neutral: 'border-l-transparent' };

/**
 * A ticket on the board: number, title, type and priority, the SLA state (red rail when
 * breached, amber past 75 %), the forecast, the major and escalation marks, the task
 * progress, the customer, the age and the owner. The menu carries the quick actions.
 */
export function TicketCardView({ card, index, draggable, dragging, onDragStart, onDragEnd, menu }: { card: TicketCard; index: number; draggable: boolean; dragging?: boolean; onDragStart?: (e: DragEvent) => void; onDragEnd?: (e: DragEvent) => void; menu: MenuItem[] }) {
  const start = (e: DragEvent) => {
    if ((e.target as HTMLElement | null)?.closest('[data-card-menu]')) {
      e.preventDefault();
      return;
    }
    onDragStart?.(e);
  };
  return (
    <article
      data-card={card.id}
      data-lane-key={card.lane}
      data-index={index}
      draggable={draggable}
      onDragStart={draggable ? start : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      className={cn('card p-2.5 border-l-2 select-none min-w-0', RAIL[slaTone(card.sla)], draggable && 'cursor-grab active:cursor-grabbing', dragging && 'opacity-50')}
      aria-label={`${card.number} ${card.title}`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <Link to={`/tickets/${card.id}`} draggable={false} className="font-mono text-[12px] text-brand-700 hover:underline shrink-0">
          {card.number}
        </Link>
        <TypeBadge type={card.type} short className="text-[10px] px-1 py-0 leading-[14px]" />
        <PriorityBadge priority={asOption(card.priority)} compact className="text-[10px] px-1 py-0 leading-[14px]" />
        <span className="flex-1" />
        <CardMenu items={menu} label={`Actions for ${card.number}`} />
      </div>
      <Link to={`/tickets/${card.id}`} draggable={false} className="block text-[13px] font-medium text-default leading-snug line-clamp-2 mt-1 hover:underline">
        {card.title}
      </Link>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11.5px] text-muted min-w-0">
        <SlaIndicator sla={card.sla} />
        <RiskBadge risk={card.breachRisk} compact quiet className="text-[10px] px-1 py-0" />
        {card.isMajor && <Flame className="h-3.5 w-3.5 text-red-500" aria-label="Major incident" />}
        {card.escalationLevel > 0 && (
          <Badge color="orange" className="text-[10px] px-1 py-0" title={`Escalated to level ${card.escalationLevel}`}>
            L{card.escalationLevel}
          </Badge>
        )}
        {card.pausesSla && <PauseCircle className="h-3.5 w-3.5 text-subtle" aria-label="This status pauses the SLA clock" />}
        {card.tasks && card.tasks.total > 0 && (
          <span className={cn('inline-flex items-center gap-1 tnum', card.tasks.done === card.tasks.total ? 'text-emerald-600' : 'text-muted')} title={`${card.tasks.done} of ${card.tasks.total} tasks done`}>
            <ListTodo className="h-3.5 w-3.5" />
            {card.tasks.done}/{card.tasks.total}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 mt-2 min-w-0">
        <span className="text-[11.5px] text-muted truncate" title={card.customerName ?? undefined}>
          {card.customerName ?? '—'}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="tnum text-[11px] text-subtle" title={`Opened ${fmtDateTime(card.createdAt)}`}>
            {shortAge(card.ageMinutes)}
          </span>
          {card.assigneeName ? <Avatar name={card.assigneeName} size="xs" className="ring-1 ring-white" /> : <span className="h-5 w-5 rounded-full border border-dashed border-strong inline-block" title="Unassigned" aria-label="Unassigned" />}
        </span>
      </div>
    </article>
  );
}
