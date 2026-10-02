import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { Sparkles, Send, X, Trash2, Loader2, Plus, History, Search, Zap, AlertTriangle, Check, ChevronDown, Settings2 } from 'lucide-react';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/format';
import { aiApi, aiQk, type AiMessage, type ToolCallRecord } from '@/components/ai/api';

/** Internal links become router links; everything else opens in a new tab. */
function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href && href.startsWith('/')) return <Link to={href} className="text-brand-700 dark:text-brand-300 hover:underline font-medium">{children}</Link>;
  return <a href={href} target="_blank" rel="noreferrer" className="text-brand-700 dark:text-brand-300 hover:underline">{children}</a>;
}
const mdComponents = {
  a: MdLink,
  table: ({ children }: { children?: ReactNode }) => <div className="overflow-x-auto my-1"><table className="text-[12px] border-collapse">{children}</table></div>,
  th: ({ children }: { children?: ReactNode }) => <th className="text-left font-semibold px-2 py-1 border-b border-default">{children}</th>,
  td: ({ children }: { children?: ReactNode }) => <td className="px-2 py-1 border-b border-default align-top">{children}</td>,
  ul: ({ children }: { children?: ReactNode }) => <ul className="list-disc pl-4 my-1 space-y-0.5">{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="list-decimal pl-4 my-1 space-y-0.5">{children}</ol>,
  p: ({ children }: { children?: ReactNode }) => <p className="my-1 leading-relaxed">{children}</p>,
  code: ({ children }: { children?: ReactNode }) => <code className="rounded bg-surface px-1 py-0.5 text-[12px] font-mono">{children}</code>,
  h1: ({ children }: { children?: ReactNode }) => <div className="font-semibold mt-2">{children}</div>,
  h2: ({ children }: { children?: ReactNode }) => <div className="font-semibold mt-2">{children}</div>,
  h3: ({ children }: { children?: ReactNode }) => <div className="font-semibold mt-1.5">{children}</div>,
};

function ToolChip({ t }: { t: ToolCallRecord }) {
  const Icon = !t.ok ? AlertTriangle : t.action ? Zap : Search;
  return (
    <span
      title={`${t.name}${t.input && Object.keys(t.input).length ? ` ${JSON.stringify(t.input)}` : ''}${t.error ? ` — ${t.error}` : ''}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] max-w-full',
        !t.ok ? 'border-red-300/70 text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10' : t.action ? 'border-brand-400/60 text-brand-700 dark:text-brand-300 bg-brand-600/10' : 'border-default text-muted bg-surface',
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{t.summary || t.name}</span>
    </span>
  );
}

/** Does the assistant's last message propose an action and wait for a go-ahead? */
function proposesAction(m: AiMessage | undefined) {
  if (!m || m.role !== 'assistant') return false;
  const text = m.content.trim();
  if (!/\?\s*$/.test(text) && !/\?[\s*_`)]*$/.test(text)) return false;
  return /(shall i|should i|do you want me|would you like me|want me to|confirm|proceed|go ahead|create (it|the ticket|this)|assign (it|this)|add (it|the comment|this)|post (it|this)|resolve (it|this)|close (it|this))/i.test(text);
}

export function AssistantPanel() {
  const { setAssistantOpen, assistantContext } = useUiStore();
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [useContext, setUseContext] = useState(true);
  const [lastSent, setLastSent] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const status = useQuery({ queryKey: aiQk.status, queryFn: aiApi.status, staleTime: 60_000, retry: false });
  const conversations = useQuery({ queryKey: aiQk.conversations, queryFn: aiApi.conversations, staleTime: 30_000, retry: false, enabled: !!status.data?.enabled });
  const messages = useQuery({ queryKey: aiQk.conversation(conversationId ?? ''), queryFn: () => aiApi.conversation(conversationId!), enabled: !!conversationId, retry: false });

  const enabled = !!status.data?.enabled;
  const contextLabel = assistantContext?.label ? String(assistantContext.label) : null;

  const send = useMutation({
    mutationFn: (text: string) => aiApi.chat({ conversationId, message: text, context: useContext && assistantContext ? assistantContext : undefined }),
    onSuccess: (res, text) => {
      setConversationId(res.conversationId);
      qc.setQueryData(aiQk.conversation(res.conversationId), (old: { id: string; title: string | null; messages: AiMessage[] } | undefined) => {
        const pending: AiMessage = { id: `local-${Date.now()}`, role: 'user', content: text, toolCalls: [], createdAt: new Date().toISOString() };
        return { id: res.conversationId, title: old?.title ?? null, messages: [...(old?.messages ?? []), pending, res.message] };
      });
      qc.invalidateQueries({ queryKey: aiQk.conversation(res.conversationId) });
      qc.invalidateQueries({ queryKey: aiQk.conversations });
      // an action tool changed data: refresh the module views
      if (res.message.toolCalls.some((t) => t.action && t.ok)) {
        qc.invalidateQueries({ queryKey: ['tickets'] });
        qc.invalidateQueries({ queryKey: ['approvals'] });
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => aiApi.deleteConversation(id),
    onSuccess: (_d, id) => {
      if (id === conversationId) setConversationId(null);
      qc.removeQueries({ queryKey: aiQk.conversation(id) });
      qc.invalidateQueries({ queryKey: aiQk.conversations });
    },
  });

  const list = messages.data?.messages ?? [];
  const pendingUser = send.isPending ? send.variables : null;
  const last = list[list.length - 1];
  const showConfirm = !send.isPending && !!status.data?.canAct && proposesAction(last);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [list.length, send.isPending]);

  // close the history dropdown on outside click
  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!historyRef.current?.contains(e.target as Node)) setHistoryOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [historyOpen]);

  const submit = useCallback(
    (text?: string) => {
      const value = (text ?? input).trim();
      if (!value || send.isPending || !enabled) return;
      setInput('');
      setLastSent(value);
      send.mutate(value);
    },
    [input, send, enabled],
  );

  function newConversation() {
    setConversationId(null);
    setInput('');
    textarea.current?.focus();
  }

  // keyboard shortcuts: Esc closes, Ctrl/Cmd+Shift+N starts a new conversation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.activeElement === textarea.current) setAssistantOpen(false);
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newConversation();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const greeting = useMemo(() => `Hi ${user?.name.split(' ')[0] ?? ''}, ask about tickets, customers, SLAs, contracts${user?.userType === 'customer' ? ' or raise a ticket' : ', assets or CIs'}. I only see what you are authorised to see.`, [user]);

  return (
    <aside className="w-[380px] shrink-0 border-l border-default bg-surface flex-col hidden lg:flex" aria-label="AI assistant">
      {/* header */}
      <div className="h-11 flex items-center gap-1.5 px-3 border-b border-default">
        <Sparkles className="h-4 w-4 text-brand-600" />
        <div className="font-semibold text-[13px] flex-1 truncate">{messages.data?.title && conversationId ? messages.data.title : 'Assistant'}</div>
        <div className="relative" ref={historyRef}>
          <button className={cn('h-7 w-7 rounded-md flex items-center justify-center text-subtle hover:text-default hover:bg-surface-2', historyOpen && 'bg-surface-2 text-default')} title="Recent conversations" onClick={() => setHistoryOpen((v) => !v)} disabled={!enabled}>
            <History className="h-4 w-4" />
          </button>
          {historyOpen && (
            <div className="absolute right-0 top-8 z-30 w-72 rounded-lg border border-default bg-surface shadow-lg py-1 max-h-80 overflow-y-auto">
              {(conversations.data?.items ?? []).length === 0 && <div className="px-3 py-2 text-[12px] text-muted">No conversations yet.</div>}
              {(conversations.data?.items ?? []).map((c) => (
                <div key={c.id} className={cn('group flex items-center gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer', c.id === conversationId && 'bg-brand-600/10')} onClick={() => { setConversationId(c.id); setHistoryOpen(false); }}>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] truncate">{c.title || 'Untitled'}</div>
                    <div className="text-[11px] text-subtle">{relativeTime(c.updatedAt)} · {c.messageCount} messages</div>
                  </div>
                  <button className="opacity-0 group-hover:opacity-100 text-subtle hover:text-red-600" title="Delete" onClick={(e) => { e.stopPropagation(); remove.mutate(c.id); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="h-7 w-7 rounded-md flex items-center justify-center text-subtle hover:text-default hover:bg-surface-2" title="New conversation (Ctrl+Shift+N)" onClick={newConversation} disabled={!enabled}>
          <Plus className="h-4 w-4" />
        </button>
        {conversationId && (
          <button className="h-7 w-7 rounded-md flex items-center justify-center text-subtle hover:text-red-600 hover:bg-surface-2" title="Delete this conversation" onClick={() => remove.mutate(conversationId)}>
            <Trash2 className="h-4 w-4" />
          </button>
        )}
        <button className="h-7 w-7 rounded-md flex items-center justify-center text-subtle hover:text-default hover:bg-surface-2" title="Close (Esc)" onClick={() => setAssistantOpen(false)}>
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-[13px]">
        {status.isLoading && <div className="text-muted text-[12.5px]">Checking assistant status…</div>}
        {status.data && !enabled && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-500/10 text-amber-900 dark:text-amber-200 p-3 text-[12px] space-y-1.5">
            <div className="font-medium inline-flex items-center gap-1.5"><Settings2 className="h-3.5 w-3.5" /> Conversational assistance is not configured</div>
            <div>
              An administrator needs to set <code className="font-mono">AI_PROVIDER</code> to <code className="font-mono">anthropic</code> (with <code className="font-mono">ANTHROPIC_API_KEY</code>) or <code className="font-mono">openai_compatible</code> (with <code className="font-mono">OPENAI_COMPATIBLE_BASE_URL</code>) and restart the API.
            </div>
            <div className="text-amber-800/80 dark:text-amber-200/80">Rule-based assistance (summaries, classification, duplicates, similar tickets, knowledge matches) stays available on ticket pages.</div>
          </div>
        )}
        {enabled && !conversationId && !pendingUser && (
          <div className="space-y-2">
            <div className="text-muted">{greeting}</div>
            <div className="flex flex-wrap gap-1.5">
              {(status.data?.suggestions ?? []).map((s) => (
                <button key={s} onClick={() => submit(s)} className="rounded-full border border-default px-2.5 py-1 text-xs text-muted hover:text-default hover:bg-surface-2 text-left">
                  {s}
                </button>
              ))}
            </div>
            {status.data?.canAct ? (
              <div className="text-[11.5px] text-subtle inline-flex items-center gap-1"><Zap className="h-3 w-3 text-brand-600" /> Actions (create ticket, comment, assign) are enabled and always confirmed with you first.</div>
            ) : (
              <div className="text-[11.5px] text-subtle">Read-only: the assistant can look things up but not change data.</div>
            )}
          </div>
        )}
        {messages.isLoading && conversationId && <div className="text-muted text-[12.5px] inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading conversation…</div>}
        {list.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div className={m.role === 'user' ? 'bg-brand-600 text-white rounded-xl rounded-br-sm px-3 py-2 max-w-[85%] whitespace-pre-wrap' : 'bg-surface-2 rounded-xl rounded-bl-sm px-3 py-2 max-w-[95%] min-w-0'}>
              {m.role === 'assistant' ? <ReactMarkdown components={mdComponents}>{m.content}</ReactMarkdown> : m.content}
              {m.role === 'assistant' && m.toolCalls?.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.toolCalls.map((t, i) => (
                    <ToolChip key={i} t={t} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {showConfirm && (
          <div className="flex gap-2 pl-1">
            <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} onClick={() => submit('Yes, proceed.')}>Yes, proceed</Button>
            <Button size="sm" variant="outline" icon={<X className="h-3.5 w-3.5" />} onClick={() => submit('No, do not do that.')}>No</Button>
          </div>
        )}
        {pendingUser && (
          <>
            <div className="flex justify-end">
              <div className="bg-brand-600 text-white rounded-xl rounded-br-sm px-3 py-2 max-w-[85%] whitespace-pre-wrap">{pendingUser}</div>
            </div>
            <div className="flex items-center gap-2 text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Thinking and looking things up…
            </div>
          </>
        )}
        {send.isError && (
          <div className="rounded-md bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 p-2 text-xs flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div className="flex-1">{(send.error as Error).message}</div>
            {lastSent && <button className="underline" onClick={() => submit(lastSent)}>Retry</button>}
          </div>
        )}
        <div ref={bottom} />
      </div>

      {/* composer */}
      <div className="p-3 border-t border-default">
        {contextLabel && (
          <button
            type="button"
            onClick={() => setUseContext((v) => !v)}
            title={useContext ? 'The assistant knows what you are viewing. Click to send without context.' : 'Context excluded. Click to include it again.'}
            className={cn('mb-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] max-w-full', useContext ? 'border-brand-400/60 bg-brand-600/10 text-brand-700 dark:text-brand-300' : 'border-default text-subtle line-through')}
          >
            <ChevronDown className="h-3 w-3 -rotate-90" /> Viewing <span className="font-medium truncate">{contextLabel}</span>
          </button>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={textarea}
            className="input min-h-[40px] max-h-32 resize-none"
            rows={1}
            placeholder={enabled ? 'Ask or instruct… (Enter to send, Shift+Enter for a new line)' : 'AI assistant not configured'}
            disabled={!enabled || send.isPending}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === 'ArrowUp' && !input && lastSent) {
                e.preventDefault();
                setInput(lastSent);
              }
            }}
          />
          <Button size="icon" onClick={() => submit()} disabled={!enabled || !input.trim()} loading={send.isPending} aria-label="Send">
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-subtle">
          <span>{status.data?.model ? `${status.data.provider} · ${status.data.model}` : status.data?.provider && enabled ? status.data.provider : ''}</span>
          <span>Answers come only from data you can access.</span>
        </div>
      </div>
    </aside>
  );
}
