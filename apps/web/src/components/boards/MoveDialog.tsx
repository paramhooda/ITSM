import { useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check } from 'lucide-react';
import { Avatar, Dialog } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { ticketsApi, qk } from '@/components/tickets/api';
import { ResolveDialog, CommentDialog } from '@/components/tickets/detail/ActionDialogs';
import { cn } from '@/lib/utils';
import { laneDot } from './BoardLane';
import type { Refusals } from './useDragDrop';
import type { BoardLane } from './api';

/**
 * The lane picker behind a card's "Move to…": the keyboard and touch path to the same
 * moves a drag performs. Lanes the card may not go to are disabled with the reason.
 */
export function MoveDialog({ open, onClose, title, lanes, currentLane, refusals, onPick }: { open: boolean; onClose: () => void; title: string; lanes: BoardLane[]; currentLane: string | null; refusals: Refusals; onPick: (laneKey: string) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-sm">
      <div className="flex flex-col gap-1" role="listbox" aria-label="Lanes">
        {lanes.map((lane) => {
          const current = lane.key === currentLane;
          const reason = current ? null : refusals[lane.key] ?? 'Not available';
          return (
            <button
              key={lane.key}
              type="button"
              role="option"
              aria-selected={current}
              disabled={!!reason || current}
              title={reason ?? undefined}
              onClick={() => {
                onPick(lane.key);
                onClose();
              }}
              className={cn('flex items-center gap-2.5 w-full rounded-lg border border-default px-3 h-10 text-left text-[13px] transition-colors', current ? 'bg-brand-50 border-brand-200 text-brand-800' : 'hover:bg-surface-2 disabled:opacity-50 disabled:hover:bg-transparent')}
              data-move-lane={lane.key}
            >
              {lane.kind === 'assignee' ? lane.key === 'unassigned' ? <span className="h-5 w-5 rounded-full border border-dashed border-strong shrink-0" aria-hidden /> : <Avatar name={lane.label} size="xs" /> : <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', laneDot(lane))} aria-hidden />}
              <span className="font-medium truncate">{lane.label}</span>
              <span className="tnum text-[11.5px] text-subtle">{lane.count}</span>
              <span className="flex-1" />
              {current ? <Check className="h-3.5 w-3.5 text-brand-600" /> : reason ? <span className="text-[11px] text-subtle truncate max-w-[45%]">{reason}</span> : null}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

export type TerminalKind = 'resolve' | 'close' | 'cancel';
export interface PendingTerminal {
  ticketId: string;
  number: string;
  kind: TerminalKind;
  /** The lane's status when the move came from a drop; absent for the menu's Resolve (the default status). */
  statusId?: string;
  laneLabel?: string;
}

export const terminalKindOf = (category: string | null | undefined): TerminalKind | null => (category === 'resolved' ? 'resolve' : category === 'closed' ? 'close' : category === 'cancelled' ? 'cancel' : null);

/**
 * The dialogs a terminal move opens before anything changes: Resolve asks for the
 * resolution notes (the record's own `ResolveDialog`, which needs the full ticket, so
 * it is fetched first), Close and Cancel ask for a closure code and a comment. Cancelling
 * the dialog leaves the card where it was.
 */
export function TerminalDropDialog({ pending, onClose, onDone }: { pending: PendingTerminal | null; onClose: () => void; onDone: (message: string) => void }) {
  const { options } = useLookups();
  const closureCodes = options('closure_code').map((c) => ({ id: c.id, label: c.label }));
  const needsTicket = pending?.kind === 'resolve';
  const detail = useQuery({ queryKey: qk.detail(pending?.ticketId ?? ''), queryFn: () => ticketsApi.get(pending!.ticketId), enabled: !!pending && needsTicket, staleTime: 15_000 });
  useEffect(() => {
    if (detail.isError && pending) {
      toast.error((detail.error as Error).message || 'Could not load the ticket');
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.isError]);
  const run = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const p = pending!;
      if (p.statusId) return ticketsApi.status(p.ticketId, { statusId: p.statusId, ...body });
      if (p.kind === 'resolve') return ticketsApi.resolve(p.ticketId, body);
      if (p.kind === 'close') return ticketsApi.close(p.ticketId, body);
      return ticketsApi.cancel(p.ticketId, body);
    },
    onSuccess: () => {
      const p = pending!;
      onDone(p.laneLabel ? `${p.number} moved to ${p.laneLabel}` : p.kind === 'resolve' ? `${p.number} resolved` : p.kind === 'close' ? `${p.number} closed` : `${p.number} cancelled`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!pending) return null;
  if (pending.kind === 'resolve') {
    if (!detail.data) return null;
    return <ResolveDialog open ticket={detail.data} busy={run.isPending} onClose={onClose} onSubmit={(v) => run.mutate({ resolutionCodeId: v.resolutionCodeId, resolutionNotes: v.resolutionNotes })} />;
  }
  if (pending.kind === 'close') {
    return <CommentDialog open title={`Close ${pending.number}`} confirmLabel="Close ticket" label="Closing comment" codes={closureCodes} busy={run.isPending} onClose={onClose} onSubmit={(v) => run.mutate({ closureCodeId: v.codeId, comment: v.comment || null })} />;
  }
  return <CommentDialog open title={`Cancel ${pending.number}`} confirmLabel="Cancel ticket" label="Reason" danger required codes={closureCodes} busy={run.isPending} onClose={onClose} onSubmit={(v) => run.mutate({ closureCodeId: v.codeId, comment: v.comment || null })} />;
}
