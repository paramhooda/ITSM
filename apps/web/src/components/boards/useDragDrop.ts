import { useCallback, useRef, useState, type DragEvent } from 'react';
import type { TicketType } from '@/components/tickets/types';
import { TYPE_LABELS } from '@/components/tickets/types';
import { TERMINAL_CATEGORIES, type BoardLane, type LanesBy, type TaskCard, type TicketCard } from './api';

/**
 * Native HTML5 drag and drop for the boards (no library). The card starts a drag with the
 * lanes it may land in; a lane accepts the drop only when it is allowed, so the browser
 * shows the no-drop cursor elsewhere; a release over a refused lane reports why. The
 * server stays the authority: the client set only avoids pointless round trips.
 */

/** Lane key → why the card may not land there, or null when it may. */
export type Refusals = Record<string, string | null>;

export interface DragState {
  cardId: string;
  fromLane: string;
  refusals: Refusals;
  /** The lane under the pointer right now. */
  over: string | null;
}

const plural = (t: TicketType) => `${TYPE_LABELS[t].toLowerCase()}s`;

/** Where a ticket card may be dropped: the statuses of its type and the person's permissions on its customer. */
export function ticketRefusals(card: TicketCard, lanes: BoardLane[], lanesBy: LanesBy, statusesByType: Record<TicketType, string[]>): Refusals {
  const out: Refusals = {};
  const fromTerminal = TERMINAL_CATEGORIES.has(card.status.category ?? '');
  for (const lane of lanes) {
    if (lane.key === card.lane) {
      out[lane.key] = null;
      continue;
    }
    if (lanesBy === 'assignee') {
      out[lane.key] = card.can.assign ? null : 'You cannot assign tickets for this customer';
      continue;
    }
    if (!(statusesByType[card.type] ?? []).includes(lane.key)) {
      out[lane.key] = `${lane.label} does not apply to ${plural(card.type)}`;
      continue;
    }
    if (TERMINAL_CATEGORIES.has(lane.category ?? '')) {
      out[lane.key] = card.can.resolve ? null : 'You cannot resolve, close or cancel tickets for this customer';
      continue;
    }
    if (fromTerminal) {
      out[lane.key] = card.can.resolve || card.can.update ? null : 'You cannot reopen tickets for this customer';
      continue;
    }
    out[lane.key] = card.can.update ? null : 'You cannot update tickets for this customer';
  }
  return out;
}

/** Where a task card may be dropped: anywhere when the person may update the parent ticket. */
export function taskRefusals(card: TaskCard, lanes: BoardLane[]): Refusals {
  const out: Refusals = {};
  for (const lane of lanes) out[lane.key] = card.can.update ? null : 'You cannot update tasks on this ticket';
  return out;
}

/** The position a drop lands at inside a lane: before or after the card under the pointer, or at the end. */
function dropIndex(e: DragEvent): number {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-index]');
  if (!el) return Number.MAX_SAFE_INTEGER;
  const i = Number(el.dataset.index);
  if (!Number.isFinite(i)) return Number.MAX_SAFE_INTEGER;
  const r = el.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2 ? i + 1 : i;
}

export function useDragDrop(onMove: (cardId: string, laneKey: string, index: number) => void, onRefuse: (reason: string) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const ref = useRef<DragState | null>(null);

  const start = useCallback((e: DragEvent, cardId: string, fromLane: string, refusals: Refusals) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId);
    const s: DragState = { cardId, fromLane, refusals, over: null };
    ref.current = s;
    setDrag(s);
  }, []);

  const end = useCallback(
    (e: DragEvent) => {
      const s = ref.current;
      ref.current = null;
      setDrag(null);
      if (!s) return;
      // The drop did not fire (a refused lane never accepts it): say why when the card was released over one.
      const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-lane]')?.dataset.lane ?? s.over;
      if (lane && lane !== s.fromLane) {
        const reason = s.refusals[lane];
        if (reason) onRefuse(reason);
      }
    },
    [onRefuse],
  );

  const laneProps = useCallback(
    (laneKey: string) => {
      const allowed = drag ? drag.refusals[laneKey] === null : false;
      return {
        'data-lane': laneKey,
        'data-drop-ok': drag && allowed ? '' : undefined,
        'data-drop-no': drag && !allowed ? '' : undefined,
        'data-drop-over': drag && allowed && drag.over === laneKey ? '' : undefined,
        onDragEnter: () => {
          const s = ref.current;
          if (!s || s.over === laneKey) return;
          s.over = laneKey;
          setDrag({ ...s });
        },
        onDragOver: (e: DragEvent) => {
          const s = ref.current;
          if (!s || s.refusals[laneKey] !== null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        },
        onDrop: (e: DragEvent) => {
          const s = ref.current;
          if (!s) return;
          e.preventDefault();
          ref.current = null;
          setDrag(null);
          const reason = s.refusals[laneKey];
          if (reason) onRefuse(reason);
          else onMove(s.cardId, laneKey, dropIndex(e));
        },
      };
    },
    [drag, onMove, onRefuse],
  );

  return { drag, start, end, laneProps };
}
