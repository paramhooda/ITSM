import { useState, useRef, useEffect, type DragEvent } from 'react';
import { Lock, MessageSquare, Paperclip, Send } from 'lucide-react';
import { Button, Textarea, Input, Kbd } from '@/components/ui';
import { cn } from '@/lib/utils';
import { FileChips, pastedFiles } from '@/components/attachments/FilePicker';
import { addFiles } from '@/components/attachments/upload';

export type ComposerKind = 'comment' | 'work_note';

export interface ComposerInput {
  kind: ComposerKind;
  body: string;
  minutesSpent?: number | null;
  /** Files chosen with the note; the caller uploads them (a reply's files follow its visibility). */
  files: File[];
}

const DEFAULT_HINTS: Record<ComposerKind, string> = { comment: 'Visible to the customer', work_note: 'Internal only' };

/**
 * Reply / work-note composer with minutes-spent, attachments (button, drop or paste) and
 * Ctrl+Enter submit. A note needs text or at least one file.
 */
export function Composer({ onSubmit, canComment, canWorkNote, canTime, canAttach = true, submitting, placeholder, defaultKind = 'comment', hints }: { onSubmit: (input: ComposerInput) => Promise<unknown> | void; canComment: boolean; canWorkNote: boolean; canTime?: boolean; canAttach?: boolean; submitting?: boolean; placeholder?: string; defaultKind?: ComposerKind; /** Audience line per kind, e.g. "Sent to the service desk" on the portal. */ hints?: Partial<Record<ComposerKind, string>> }) {
  const [kind, setKind] = useState<ComposerKind>(canComment ? defaultKind : 'work_note');
  const [body, setBody] = useState('');
  const [minutes, setMinutes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!canComment && canWorkNote) setKind('work_note');
  }, [canComment, canWorkNote]);
  if (!canComment && !canWorkNote) return null;

  const hint = { ...DEFAULT_HINTS, ...hints }[kind];
  const ready = (body.trim().length > 0 || files.length > 0) && !submitting;
  const attach = (incoming: FileList | File[] | null | undefined) => {
    // Snapshot first: a FileList is live, and the input is cleared right after the change event.
    const picked = incoming ? Array.from(incoming) : [];
    if (canAttach && picked.length) setFiles((cur) => addFiles(cur, picked));
  };

  async function submit() {
    if (!ready) return;
    try {
      await onSubmit({ kind, body: body.trim(), minutesSpent: minutes ? Number(minutes) : null, files });
    } catch {
      return; // the caller reports the error; keep the draft so it can be retried
    }
    setBody('');
    setMinutes('');
    setFiles([]);
    ref.current?.focus();
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!canAttach) return;
    e.preventDefault();
    setDragging(false);
    attach(e.dataTransfer.files);
  };

  return (
    <div
      className={cn('relative rounded-lg border', kind === 'work_note' ? 'border-amber-300/70' : 'border-default', dragging && 'ring-2 ring-brand-500/40')}
      onDragOver={(e) => {
        if (!canAttach) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1 px-2 pt-2">
        {canComment && (
          <button onClick={() => setKind('comment')} className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium', kind === 'comment' ? 'bg-brand-600/10 text-brand-700' : 'text-muted hover:bg-surface-2')}>
            <MessageSquare className="h-3.5 w-3.5" /> Reply
          </button>
        )}
        {canWorkNote && (
          <button onClick={() => setKind('work_note')} className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium', kind === 'work_note' ? 'bg-amber-100 text-amber-800' : 'text-muted hover:bg-surface-2')}>
            <Lock className="h-3.5 w-3.5" /> Work note
          </button>
        )}
        <span className="ml-auto text-[11px] text-subtle pr-1">{hint}</span>
      </div>
      <div className="p-2">
        <Textarea
          ref={ref}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder ?? (kind === 'comment' ? 'Write a reply to the customer…' : 'Add an internal work note…')}
          className={cn('min-h-[72px] border-0 bg-transparent px-1 focus:shadow-none', kind === 'work_note' && 'bg-amber-50/40')}
          onPaste={(e) => {
            const fs = pastedFiles(e);
            if (fs.length && canAttach) {
              e.preventDefault();
              attach(fs);
            }
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {files.length > 0 && (
          <div className="px-1 pb-1 flex flex-col gap-1">
            <FileChips files={files} disabled={submitting} onRemove={(i) => setFiles((cur) => cur.filter((_, j) => j !== i))} />
            <span className="text-[11px] text-subtle">{files.length === 1 ? '1 file' : `${files.length} files`} · {hint.toLowerCase()}</span>
          </div>
        )}
        <div className="flex items-center gap-2 mt-1">
          {canAttach && (
            <>
              <Button size="sm" variant="ghost" className="px-2" icon={<Paperclip className="h-3.5 w-3.5" />} onClick={() => fileRef.current?.click()} disabled={submitting} title="Attach files (or drop them here, or paste a screenshot)" aria-label="Attach files">
                <span className="hidden sm:inline">Attach</span>
              </Button>
              <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { attach(e.target.files); e.target.value = ''; }} />
            </>
          )}
          {canTime && (
            <div className="flex items-center gap-1 text-[12px] text-muted">
              <Input type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="min" className="w-20 h-7 py-0 text-[12.5px]" title="Minutes spent (creates a time entry)" />
              <span>min</span>
            </div>
          )}
          <span className="ml-auto text-[11px] text-subtle hidden sm:inline">
            <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd>
          </span>
          <Button size="sm" onClick={() => void submit()} loading={submitting} disabled={!ready} icon={<Send className="h-3.5 w-3.5" />} variant={kind === 'work_note' ? 'secondary' : 'primary'}>
            {kind === 'comment' ? 'Reply' : 'Add note'}
          </Button>
        </div>
      </div>
      {dragging && canAttach && <div className="absolute inset-0 rounded-lg bg-brand-500/5 flex items-center justify-center text-[13px] text-brand-700 pointer-events-none">Drop to attach</div>}
    </div>
  );
}
