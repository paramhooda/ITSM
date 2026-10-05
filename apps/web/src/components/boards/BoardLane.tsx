import type { DragEvent, ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { cn, dotClass } from '@/lib/utils';
import { TICKET_CATEGORY_COLORS, TASK_STATUS_COLORS } from '@/lib/statusColors';
import type { BoardLane } from './api';

/** Drop handlers and the `data-drop-*` attributes `useDragDrop().laneProps()` returns. */
export interface LaneDropProps {
  'data-lane': string;
  'data-drop-ok'?: string;
  'data-drop-no'?: string;
  'data-drop-over'?: string;
  onDragEnter: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

/** The solid dot class for a status lane (option colour, else the category or task colour). */
export const laneDot = (lane: BoardLane) => dotClass(lane.color ?? (lane.category ? TICKET_CATEGORY_COLORS[lane.category] : TASK_STATUS_COLORS[lane.key]) ?? 'slate');

/** WIP figure for a lane: open cards for a person, every card for a status lane. */
export const laneUsed = (lane: BoardLane) => (lane.kind === 'assignee' ? lane.open : lane.count);

export function wipTone(lane: BoardLane, limit: number | null): 'over' | 'at' | null {
  if (!limit || limit <= 0) return null;
  const used = laneUsed(lane);
  if (used > limit) return 'over';
  if (used === limit) return 'at';
  return null;
}

function LaneCount({ lane, limit }: { lane: BoardLane; limit: number | null }) {
  const tone = wipTone(lane, limit);
  const used = laneUsed(lane);
  return (
    <span
      className={cn('tnum text-[12px] font-medium whitespace-nowrap', tone === 'over' ? 'text-red-700' : tone === 'at' ? 'text-amber-700' : 'text-muted')}
      title={limit ? (tone === 'over' ? `Over the WIP limit (${used} of ${limit})` : tone === 'at' ? `At the WIP limit (${used} of ${limit})` : `${used} of ${limit} (WIP limit)`) : `${lane.count} card${lane.count === 1 ? '' : 's'}`}
      data-wip={tone ?? undefined}
    >
      {limit ? `${used} / ${limit}` : lane.count}
    </span>
  );
}

/**
 * One lane of the board: a column with the status or person in the header, the WIP figure
 * (amber at the limit, red over it), the breached count, a collapse control and the cards.
 * A collapsed lane is a narrow strip that still accepts drops.
 */
export function Lane({ lane, limit, collapsed, onToggleCollapse, drop, children, mobile, empty }: { lane: BoardLane; limit: number | null; collapsed?: boolean; onToggleCollapse?: () => void; drop?: LaneDropProps; children: ReactNode; mobile?: boolean; empty?: boolean }) {
  const tone = wipTone(lane, limit);
  const head = lane.kind === 'assignee' ? lane.key === 'unassigned' ? <span className="h-5 w-5 rounded-full border border-dashed border-strong shrink-0" aria-hidden /> : <Avatar name={lane.label} size="xs" /> : <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', laneDot(lane))} aria-hidden />;
  const dropCls = 'data-[drop-ok]:ring-1 data-[drop-ok]:ring-brand-500/50 data-[drop-over]:ring-2 data-[drop-over]:ring-brand-600 data-[drop-over]:bg-brand-50/60 data-[drop-no]:opacity-40 transition-[opacity,box-shadow]';
  if (collapsed && !mobile) {
    // The whole strip is one button, so the keyboard expands a lane as easily as a click does; drops still land on the section.
    return (
      <section data-lane={lane.key} {...drop} data-lane-collapsed className={cn('w-10 shrink-0 rounded-xl border border-default bg-surface-2 flex', dropCls)} aria-label={`${lane.label}, collapsed`}>
        <button type="button" onClick={onToggleCollapse} className="flex-1 min-w-0 flex flex-col items-center py-2 gap-2 rounded-xl hover:bg-surface-3/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600" title={`Expand ${lane.label}`} aria-label={`Expand ${lane.label}`} aria-expanded={false}>
          <ChevronRight className="h-3.5 w-3.5 text-subtle" />
          {head}
          <span className={cn('tnum text-[12px] font-semibold', tone === 'over' ? 'text-red-700' : tone === 'at' ? 'text-amber-700' : 'text-muted')}>{laneUsed(lane)}</span>
          <span className="text-[11.5px] font-medium text-secondary [writing-mode:vertical-rl] rotate-180 truncate max-h-40">{lane.label}</span>
        </button>
      </section>
    );
  }
  return (
    <section data-lane={lane.key} {...drop} className={cn('rounded-xl border bg-surface-2 flex flex-col min-w-0', tone === 'over' ? 'border-red-200' : tone === 'at' ? 'border-amber-200' : 'border-default', mobile ? 'w-full' : 'w-[272px] min-w-[272px] shrink-0', dropCls)} aria-label={lane.label}>
      <header className={cn('flex items-center gap-2 px-3 py-2.5 rounded-t-xl', tone === 'over' ? 'bg-red-50/70' : tone === 'at' ? 'bg-amber-50/70' : '')}>
        {head}
        <span className="font-medium text-[13px] text-default truncate flex-1" title={lane.label}>
          {lane.label}
        </span>
        {lane.breached > 0 && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-red-700 tnum" title={`${lane.breached} breached SLA${lane.breached === 1 ? '' : 's'}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
            {lane.breached}
          </span>
        )}
        <LaneCount lane={lane} limit={limit} />
        {!mobile && onToggleCollapse && (
          <button type="button" onClick={onToggleCollapse} className="h-6 w-6 rounded-md inline-flex items-center justify-center text-subtle hover:text-default hover:bg-white/80" aria-label={`Collapse ${lane.label}`} aria-expanded title="Collapse lane">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}
      </header>
      <div className={cn('flex flex-col gap-2 px-2 pb-2 overflow-y-auto [scrollbar-width:thin]', mobile ? 'max-h-none' : 'max-h-[calc(100vh-22rem)] min-h-[96px]')}>
        {children}
        {empty && <div className="text-[12.5px] text-subtle text-center py-6 rounded-lg border border-dashed border-default">Nothing here</div>}
      </div>
    </section>
  );
}
