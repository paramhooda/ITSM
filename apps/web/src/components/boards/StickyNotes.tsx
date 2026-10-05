import { useMemo, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pin, PinOff, Plus, StickyNote, Trash2 } from 'lucide-react';
import { Button, Card, Checkbox, ErrorBlock, Textarea } from '@/components/ui';
import { Skeleton } from '@/components/dashboards/Panel';
import { cn, colorClass, dotClass } from '@/lib/utils';
import { relativeTime } from '@/lib/format';
import { BOARD_NOTE_COLORS } from '@/lib/statusColors';
import { boardKeys, boardsApi, type BoardKind, type BoardNote, type NoteColor } from './api';

const COLORS: NoteColor[] = ['amber', 'blue', 'green', 'rose', 'slate'];
const MAX = 2000;

/**
 * The person's sticky notes for the shift, beside the board: a one-line composer (Enter
 * adds, Shift+Enter for a new line), coloured notes, pin, done (struck through, at the
 * bottom) and delete. Notes are visible to their author only; done notes are purged
 * after the retention period.
 */
export function StickyNotes({ board, teamId }: { board: BoardKind; teamId?: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const [color, setColor] = useState<NoteColor>('amber');
  const params = useMemo(() => ({ board, teamId, includeDone: 'true' as const }), [board, teamId]);
  const q = useQuery({ queryKey: boardKeys.notes(params), queryFn: () => boardsApi.notes(params), placeholderData: (p) => p });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['boards', 'notes'] });
  const add = useMutation({
    mutationFn: () => boardsApi.addNote({ board, teamId: teamId ?? null, body: body.trim(), color }),
    onSuccess: () => {
      setBody('');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof boardsApi.updateNote>[1] }) => boardsApi.updateNote(id, patch),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => boardsApi.deleteNote(id),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const notes = useMemo(() => {
    const items = q.data?.items ?? [];
    const rank = (n: BoardNote) => (n.done ? 2 : n.pinned ? 0 : 1);
    return [...items].sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder || b.createdAt.localeCompare(a.createdAt));
  }, [q.data]);
  const submit = () => {
    if (!body.trim() || add.isPending) return;
    add.mutate();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter inside an input-method composition picks a candidate; it never posts the note.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <Card padded={false} className="min-w-0" title={<span className="inline-flex items-center gap-2">Sticky notes{notes.length > 0 && <span className="tnum text-[12px] font-normal text-subtle">{notes.filter((n) => !n.done).length}</span>}</span>} data-testid="notes-panel">
      <div className="p-4 flex flex-col gap-3">
        <div className={cn('rounded-lg border border-default p-2 flex flex-col gap-2', colorClass(BOARD_NOTE_COLORS[color]))}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value.slice(0, MAX))} onKeyDown={onKey} placeholder="Jot a note for the shift…" aria-label="New sticky note" rows={2} className="min-h-[52px] bg-white/70 text-[13px]" data-testid="note-composer" />
          <div className="flex items-center gap-1.5">
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={`${c} note`} aria-pressed={color === c} className={cn('h-4 w-4 rounded-full ring-offset-1 transition-shadow', dotClass(BOARD_NOTE_COLORS[c]), color === c ? 'ring-2 ring-brand-600' : 'ring-1 ring-black/10 hover:ring-black/30')} />
            ))}
            <span className="flex-1" />
            <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} disabled={!body.trim()} loading={add.isPending} onClick={submit} className="bg-white/80">
              Add
            </Button>
          </div>
          <div className="text-[11px] text-subtle tnum">{body.length > MAX * 0.8 ? `${body.length} of ${MAX} characters` : 'Enter adds · Shift+Enter for a new line'}</div>
        </div>
        {q.isLoading ? (
          <Skeleton rows={3} />
        ) : q.isError ? (
          <ErrorBlock error={q.error} retry={() => void q.refetch()} />
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center text-center py-5 text-[12.5px] text-subtle" data-testid="notes-empty">
            <StickyNote className="h-5 w-5 mb-1.5" />
            No notes for this shift
          </div>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="notes-list">
            {notes.map((n) => (
              <li key={n.id} data-note={n.id} data-note-done={n.done ? '' : undefined} data-note-pinned={n.pinned ? '' : undefined} className={cn('rounded-lg border border-black/5 px-3 py-2 text-[13px] shadow-[0_1px_2px_rgba(9,9,11,0.05)]', colorClass(BOARD_NOTE_COLORS[n.color] ?? 'amber'), n.done && 'opacity-70')}>
                <div className={cn('whitespace-pre-wrap break-words leading-snug', n.done && 'line-through')}>{n.body}</div>
                <div className="flex items-center gap-2 mt-1.5 text-[11.5px] opacity-80">
                  <Checkbox checked={n.done} onChange={(e) => update.mutate({ id: n.id, patch: { done: e.target.checked } })} aria-label={n.done ? 'Reopen the note' : 'Mark the note done'} label={<span className="text-[11.5px]">{n.done ? 'Done' : 'Mark done'}</span>} className="gap-1.5" />
                  <span className="flex-1 truncate tnum text-right" title={n.createdAt}>
                    {relativeTime(n.createdAt)}
                  </span>
                  <button type="button" onClick={() => update.mutate({ id: n.id, patch: { pinned: !n.pinned } })} className={cn('h-6 w-6 rounded-md inline-flex items-center justify-center hover:bg-black/5', n.pinned && 'text-brand-700')} aria-label={n.pinned ? 'Unpin' : 'Pin'} aria-pressed={n.pinned} title={n.pinned ? 'Unpin' : 'Pin to the top'}>
                    {n.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" onClick={() => remove.mutate(n.id)} className="h-6 w-6 rounded-md inline-flex items-center justify-center hover:bg-black/5 hover:text-red-700" aria-label="Delete the note" title="Delete">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
