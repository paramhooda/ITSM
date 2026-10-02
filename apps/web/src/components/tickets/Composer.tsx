import { useState, useRef, useEffect } from 'react';
import { Lock, MessageSquare, Send } from 'lucide-react';
import { Button, Textarea, Input, Kbd } from '@/components/ui';
import { cn } from '@/lib/utils';

export type ComposerKind = 'comment' | 'work_note';

/** Reply / work-note composer with minutes-spent and Ctrl+Enter submit. */
export function Composer({ onSubmit, canComment, canWorkNote, canTime, submitting, placeholder, defaultKind = 'comment' }: { onSubmit: (input: { kind: ComposerKind; body: string; minutesSpent?: number | null }) => Promise<unknown> | void; canComment: boolean; canWorkNote: boolean; canTime?: boolean; submitting?: boolean; placeholder?: string; defaultKind?: ComposerKind }) {
  const [kind, setKind] = useState<ComposerKind>(canComment ? defaultKind : 'work_note');
  const [body, setBody] = useState('');
  const [minutes, setMinutes] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!canComment && canWorkNote) setKind('work_note');
  }, [canComment, canWorkNote]);
  if (!canComment && !canWorkNote) return null;

  async function submit() {
    const text = body.trim();
    if (!text || submitting) return;
    await onSubmit({ kind, body: text, minutesSpent: minutes ? Number(minutes) : null });
    setBody('');
    setMinutes('');
    ref.current?.focus();
  }

  return (
    <div className={cn('rounded-lg border', kind === 'work_note' ? 'border-amber-300/70 dark:border-amber-500/30' : 'border-default')}>
      <div className="flex items-center gap-1 px-2 pt-2">
        {canComment && (
          <button onClick={() => setKind('comment')} className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium', kind === 'comment' ? 'bg-brand-600/10 text-brand-700 dark:text-brand-300' : 'text-muted hover:bg-surface-2')}>
            <MessageSquare className="h-3.5 w-3.5" /> Reply
          </button>
        )}
        {canWorkNote && (
          <button onClick={() => setKind('work_note')} className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium', kind === 'work_note' ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' : 'text-muted hover:bg-surface-2')}>
            <Lock className="h-3.5 w-3.5" /> Work note
          </button>
        )}
        <span className="ml-auto text-[11px] text-subtle pr-1">{kind === 'comment' ? 'Visible to the customer' : 'Internal only'}</span>
      </div>
      <div className="p-2">
        <Textarea
          ref={ref}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder ?? (kind === 'comment' ? 'Write a reply to the customer…' : 'Add an internal work note…')}
          className={cn('min-h-[72px] border-0 bg-transparent px-1 focus:shadow-none', kind === 'work_note' && 'bg-amber-50/40 dark:bg-amber-500/5')}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="flex items-center gap-2 mt-1">
          {canTime && (
            <div className="flex items-center gap-1 text-[12px] text-muted">
              <Input type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="min" className="w-20 h-7 py-0 text-[12.5px]" title="Minutes spent (creates a time entry)" />
              <span>min</span>
            </div>
          )}
          <span className="ml-auto text-[11px] text-subtle hidden sm:inline">
            <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd>
          </span>
          <Button size="sm" onClick={() => void submit()} loading={submitting} disabled={!body.trim()} icon={<Send className="h-3.5 w-3.5" />} variant={kind === 'work_note' ? 'secondary' : 'primary'}>
            {kind === 'comment' ? 'Reply' : 'Add note'}
          </Button>
        </div>
      </div>
    </div>
  );
}
