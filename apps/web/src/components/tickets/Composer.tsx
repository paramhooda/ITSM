import { useState, useRef, useEffect, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Lock, MessageSquare, Paperclip, Send, Sparkles, ChevronDown, BookOpen, X } from 'lucide-react';
import { Button, Textarea, Input, Kbd } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { cn } from '@/lib/utils';
import type { KnowledgeResult, Tone } from '@/components/ai/api';
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
const TONES: { value: Tone; label: string }[] = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'formal', label: 'Formal' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'apologetic', label: 'Apologetic' },
];

/** Grady helpers the page may hand the composer (staff only): a drafted reply in a tone, matching knowledge articles. */
export interface ComposerAi {
  draft?: (tone: Tone) => Promise<{ draft: string; aiGenerated: boolean }>;
  knowledge?: () => Promise<KnowledgeResult>;
}

/**
 * Reply / work-note composer with minutes-spent, attachments (button, drop or paste) and
 * Ctrl+Enter submit. A note needs text or at least one file.
 */
export function Composer({ onSubmit, canComment, canWorkNote, canTime, canAttach = true, submitting, placeholder, defaultKind = 'comment', hints, ai }: { onSubmit: (input: ComposerInput) => Promise<unknown> | void; canComment: boolean; canWorkNote: boolean; canTime?: boolean; canAttach?: boolean; submitting?: boolean; placeholder?: string; defaultKind?: ComposerKind; /** Audience line per kind, e.g. "Sent to the service desk" on the portal. */ hints?: Partial<Record<ComposerKind, string>>; ai?: ComposerAi }) {
  const [kind, setKind] = useState<ComposerKind>(canComment ? defaultKind : 'work_note');
  const [body, setBody] = useState('');
  const [minutes, setMinutes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState<{ aiGenerated: boolean } | null>(null);
  const [kb, setKb] = useState<{ loading: boolean; result: KnowledgeResult | null } | null>(null);
  useEffect(() => {
    if (!canComment && canWorkNote) setKind('work_note');
  }, [canComment, canWorkNote]);
  if (!canComment && !canWorkNote) return null;

  const draftReply = async (tone: Tone) => {
    if (!ai?.draft || drafting) return;
    setDrafting(true);
    try {
      const r = await ai.draft(tone);
      setBody(r.draft);
      setDrafted({ aiGenerated: r.aiGenerated });
      ref.current?.focus();
    } catch (err) {
      toast.error((err as Error).message || 'Could not draft a reply');
    } finally {
      setDrafting(false);
    }
  };
  const suggestKnowledge = async () => {
    if (!ai?.knowledge) return;
    if (kb && !kb.loading) return setKb(null);
    setKb({ loading: true, result: null });
    try {
      setKb({ loading: false, result: await ai.knowledge() });
    } catch (err) {
      setKb(null);
      toast.error((err as Error).message || 'Could not look up knowledge');
    }
  };
  const insertArticle = (a: KnowledgeResult['items'][number]) => {
    const line = `${a.title}: ${window.location.origin}${a.link}`;
    setBody((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${line}` : line));
    ref.current?.focus();
  };

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
    setDrafted(null);
    setKb(null);
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
        {drafted && body.trim() && (
          <div className="px-1 pb-1 text-[11.5px] text-subtle inline-flex items-center gap-1"><Sparkles className="h-3 w-3" /> {drafted.aiGenerated ? 'Drafted by Grady from the ticket and its notes. Read it before sending.' : 'Template reply (the AI provider is not configured). Read it before sending.'}</div>
        )}
        {kb && (
          <div className="mx-1 mb-1 rounded-md border border-default bg-surface-2 p-2 text-[12.5px]">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium inline-flex items-center gap-1"><BookOpen className="h-3.5 w-3.5" /> Knowledge that may help</span>
              {kb.loading && <span className="text-subtle">looking…</span>}
              <button type="button" className="ml-auto text-subtle hover:text-default" aria-label="Close" onClick={() => setKb(null)}><X className="h-3.5 w-3.5" /></button>
            </div>
            {kb.result && kb.result.items.length === 0 && <div className="text-muted">No published article matches this ticket.</div>}
            {kb.result && kb.result.items.length > 0 && (
              <ul className="flex flex-col divide-y divide-[var(--border)]">
                {kb.result.items.slice(0, 5).map((a) => (
                  <li key={a.id} className="flex items-center gap-2 py-1">
                    <div className="min-w-0 flex-1">
                      <Link to={a.link} className="font-medium text-brand-700 hover:underline" target="_blank" rel="noreferrer">{a.number} {a.title}</Link>
                      <div className="text-subtle truncate">{a.reason}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => insertArticle(a)}>Insert link</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {(ai?.draft || ai?.knowledge) && (
          <div className="flex flex-wrap items-center gap-1 px-1 pb-1">
            {ai.draft && kind === 'comment' && (
              <Menu align="left" trigger={<Button size="sm" variant="ghost" className="px-2 h-7" icon={<Sparkles className="h-3.5 w-3.5" />} loading={drafting} disabled={submitting} title="Let Grady draft the reply from the ticket and its notes">Draft reply <ChevronDown className="h-3 w-3" /></Button>} items={TONES.map((t) => ({ label: `${t.label} tone`, onClick: () => void draftReply(t.value) }))} />
            )}
            {ai.knowledge && (
              <Button size="sm" variant="ghost" className="px-2 h-7" icon={<BookOpen className="h-3.5 w-3.5" />} loading={!!kb?.loading} disabled={submitting} onClick={() => void suggestKnowledge()} title="Knowledge articles that match this ticket">Suggest knowledge</Button>
            )}
          </div>
        )}
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
