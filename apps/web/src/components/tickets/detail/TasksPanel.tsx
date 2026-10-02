import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ListChecks, Plus, Trash2 } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { cn } from '@/lib/utils';
import { Panel } from '../Panel';
import { ticketsApi } from '../api';
import type { Task } from '../types';

/** Simple checklist of sub-tasks. */
export function TasksPanel({ ticketId, tasks, canEdit }: { ticketId: string; tasks: Task[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tickets', ticketId] });
  const add = useMutation({ mutationFn: () => ticketsApi.addTask(ticketId, { title: title.trim() }), onSuccess: () => { setTitle(''); invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const toggle = useMutation({ mutationFn: (t: Task) => ticketsApi.updateTask(ticketId, t.id, { status: t.status === 'done' ? 'open' : 'done' }), onSuccess: invalidate, onError: (e: Error) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: (id: string) => ticketsApi.deleteTask(ticketId, id), onSuccess: invalidate, onError: (e: Error) => toast.error(e.message) });
  const done = tasks.filter((t) => t.status === 'done').length;
  if (!tasks.length && !canEdit) return null;
  return (
    <Panel title={<span className="inline-flex items-center gap-2"><ListChecks className="h-4 w-4 text-subtle" /> Tasks {tasks.length ? <span className="text-subtle font-normal">{done}/{tasks.length}</span> : null}</span>} padded={false}>
      <ul className="divide-y divide-[var(--border)]">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-4 py-1.5 group">
            <input type="checkbox" checked={t.status === 'done'} disabled={!canEdit} onChange={() => toggle.mutate(t)} className="h-4 w-4 accent-brand-600" />
            <span className={cn('flex-1 text-[13px]', t.status === 'done' && 'line-through text-subtle', t.status === 'cancelled' && 'text-subtle')}>{t.title}</span>
            {canEdit && (
              <button onClick={() => remove.mutate(t.id)} className="text-subtle hover:text-red-600 opacity-0 group-hover:opacity-100" aria-label="Delete task">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-default">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task…" className="h-7 py-0 text-[13px]" onKeyDown={(e) => e.key === 'Enter' && title.trim() && add.mutate()} />
          <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => add.mutate()} disabled={!title.trim()} loading={add.isPending}>
            Add
          </Button>
        </div>
      )}
    </Panel>
  );
}
