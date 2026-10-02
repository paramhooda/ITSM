import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, X, Trash2, Loader2, Plus, History, Search, Zap, AlertTriangle, Check, ChevronLeft, Settings2, Minus } from 'lucide-react';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/format';
import { ApiError } from '@/api/client';
import type { AiMessage, ToolCallRecord } from '@/components/ai/api';
import { GradyAvatar } from './GradyAvatar';
import { useGradyChat } from './useGradyChat';

// ---------------------------------------------------------------- markdown

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href && href.startsWith('/')) return <Link to={href} className="font-medium text-brand-700 hover:underline">{children}</Link>;
  return <a href={href} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">{children}</a>;
}
const md = {
  a: MdLink,
  p: ({ children }: { children?: ReactNode }) => <p className="my-1.5 first:mt-0 last:mb-0 leading-[1.55]">{children}</p>,
  ul: ({ children }: { children?: ReactNode }) => <ul className="my-1.5 pl-4 list-disc space-y-1 marker:text-subtle">{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="my-1.5 pl-4 list-decimal space-y-1 marker:text-subtle">{children}</ol>,
  li: ({ children }: { children?: ReactNode }) => <li className="leading-[1.5] [&>p]:my-0">{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => <strong className="font-semibold text-default">{children}</strong>,
  h1: ({ children }: { children?: ReactNode }) => <div className="font-semibold text-default mt-2.5 mb-1">{children}</div>,
  h2: ({ children }: { children?: ReactNode }) => <div className="font-semibold text-default mt-2.5 mb-1">{children}</div>,
  h3: ({ children }: { children?: ReactNode }) => <div className="font-semibold text-default mt-2 mb-1">{children}</div>,
  hr: () => null,
  blockquote: ({ children }: { children?: ReactNode }) => <div className="my-1.5 border-l-2 border-default pl-3 text-muted">{children}</div>,
  code: ({ children }: { children?: ReactNode }) => <code className="rounded bg-surface-2 px-1 py-0.5 text-[11.5px] font-mono text-default">{children}</code>,
  pre: ({ children }: { children?: ReactNode }) => <pre className="my-1.5 rounded-lg bg-surface-2 border border-default p-2.5 text-[11.5px] overflow-x-auto">{children}</pre>,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-2 -mx-1 overflow-x-auto rounded-lg border border-default">
      <table className="w-full text-[11.5px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => <thead className="bg-[#fafafa]">{children}</thead>,
  th: ({ children }: { children?: ReactNode }) => <th className="text-left font-medium text-muted px-2 py-1.5">{children}</th>,
  td: ({ children }: { children?: ReactNode }) => <td className="px-2 py-1.5 border-t border-default align-top leading-[1.4] [&>a]:whitespace-nowrap">{children}</td>,
};

// ---------------------------------------------------------------- pieces

/** One quiet line per tool call: what Grady checked or did, never the raw payload. */
function ToolLine({ t }: { t: ToolCallRecord }) {
  const Icon = !t.ok ? AlertTriangle : t.action ? Check : Search;
  return (
    <div className={cn('flex items-center gap-1.5 text-[11.5px] min-w-0', !t.ok ? 'text-red-600' : t.action ? 'text-emerald-700' : 'text-subtle')} title={t.error ? `${t.name}: ${t.error}` : t.name}>
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{!t.ok ? `Could not ${t.name.replace(/_/g, ' ')}` : t.action ? `Done: ${t.summary}` : t.summary || `Checked ${t.name.replace(/_/g, ' ')}`}</span>
    </div>
  );
}

function Bubble({ m }: { m: AiMessage }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-3.5 py-2 text-[13px] text-white whitespace-pre-wrap leading-[1.5]">{m.content}</div>
      </div>
    );
  }
  const checks = m.toolCalls ?? [];
  return (
    <div className="flex items-start gap-2.5">
      <GradyAvatar size={26} className="mt-0.5" />
      <div className="min-w-0 max-w-[94%] flex-1">
        <div className="rounded-2xl rounded-tl-md border border-default bg-white px-3.5 py-2.5 text-[13px] text-secondary shadow-card">
          {m.content ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{m.content}</ReactMarkdown> : <span className="text-subtle">No reply.</span>}
        </div>
        {checks.length > 0 && (
          <div className="mt-1 pl-1 flex flex-col gap-0.5">
            {checks.slice(0, 3).map((t, i) => <ToolLine key={i} t={t} />)}
            {checks.length > 3 && <div className="text-[11px] text-subtle pl-[18px]">and {checks.length - 3} more</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <>
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-3.5 py-2 text-[13px] text-white whitespace-pre-wrap">{text}</div>
      </div>
      <div className="flex items-center gap-2.5">
        <GradyAvatar size={26} mood="thinking" />
        <div className="rounded-2xl rounded-tl-md border border-default bg-white px-3.5 py-2.5 shadow-card inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-bounce [animation-delay:-0.2s]" />
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-bounce [animation-delay:-0.1s]" />
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-bounce" />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- window

function GradyWindow({ onClose }: { onClose: () => void }) {
  const chat = useGradyChat();
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const [input, setInput] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chat.messages.length, chat.pending]);
  useEffect(() => {
    if (!historyOpen) textarea.current?.focus();
  }, [historyOpen, chat.conversationId]);

  const firstName = user?.name.split(' ')[0] ?? '';
  const intro = useMemo(() => (user?.userType === 'customer' ? `Hi ${firstName}, I can check your tickets, service levels and visits, or raise a ticket for you.` : `Hi ${firstName}, ask me about tickets, customers, SLAs, contracts, assets or CIs. I only see what you are allowed to see.`), [user, firstName]);
  const send = (text?: string) => {
    const ok = chat.submit(text ?? input);
    if (ok && text === undefined) setInput('');
  };
  const err = chat.error;
  const upstream = err instanceof ApiError && (err.code === 'ai_upstream' || err.code === 'ai_disabled');

  return (
    <div className="fixed z-50 bottom-4 right-4 w-[min(500px,calc(100vw-2rem))] h-[min(700px,calc(100vh-2rem))] flex flex-col rounded-2xl border border-default bg-[#fafafa] shadow-pop scale-in overflow-hidden" role="dialog" aria-label="Grady, service assistant">
      {/* header */}
      <div className="flex items-center gap-3 px-4 h-[60px] bg-white border-b border-default shrink-0">
        {historyOpen ? (
          <button className="h-8 w-8 -ml-1 rounded-lg flex items-center justify-center text-muted hover:text-default hover:bg-surface-2" onClick={() => setHistoryOpen(false)} aria-label="Back"><ChevronLeft className="h-4 w-4" /></button>
        ) : (
          <GradyAvatar size={38} />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold tracking-[-0.01em] leading-tight">{historyOpen ? 'Conversations' : 'Grady'}</div>
          <div className="text-[11.5px] text-muted flex items-center gap-1.5 leading-tight">
            {historyOpen ? `${chat.conversations.length} recent` : (
              <>
                <span className={cn('h-1.5 w-1.5 rounded-full', chat.enabled ? 'bg-emerald-500' : 'bg-zinc-400')} />
                {chat.enabled ? 'Progression service assistant' : 'Not configured'}
              </>
            )}
          </div>
        </div>
        {!historyOpen && (
          <>
            <button className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-default hover:bg-surface-2" title="Recent conversations" onClick={() => setHistoryOpen(true)} disabled={!chat.enabled}><History className="h-4 w-4" /></button>
            <button className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-default hover:bg-surface-2" title="New conversation" onClick={() => { chat.reset(); setInput(''); }} disabled={!chat.enabled}><Plus className="h-4 w-4" /></button>
          </>
        )}
        <button className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-default hover:bg-surface-2" title="Minimise (Esc)" onClick={onClose} aria-label="Close"><Minus className="h-4 w-4" /></button>
      </div>

      {historyOpen ? (
        <div className="flex-1 overflow-y-auto p-2">
          {chat.conversations.length === 0 && <div className="px-3 py-8 text-center text-[12.5px] text-subtle">No conversations yet.</div>}
          {chat.conversations.map((c) => (
            <div key={c.id} className={cn('group flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer hover:bg-white hover:shadow-card', c.id === chat.conversationId && 'bg-white shadow-card')} onClick={() => { chat.open(c.id); setHistoryOpen(false); }}>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] truncate text-default">{c.title || 'Untitled'}</div>
                <div className="text-[11px] text-subtle">{relativeTime(c.updatedAt)} · {c.messageCount} messages</div>
              </div>
              <button className="opacity-0 group-hover:opacity-100 text-subtle hover:text-red-600" title="Delete" onClick={(e) => { e.stopPropagation(); chat.remove(c.id); }}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
            {chat.status.isLoading && <div className="text-[12.5px] text-subtle">Checking…</div>}
            {chat.status.data && !chat.enabled && (
              <div className="rounded-xl border border-amber-200/70 bg-amber-50 text-amber-900 p-3 text-[12.5px] flex gap-2">
                <Settings2 className="h-4 w-4 mt-px shrink-0" />
                <div>
                  <div className="font-medium">Grady is not connected to an AI provider yet.</div>
                  <div className="text-amber-800/90 mt-0.5">{can('admin:system') || can('admin:config') ? <>Set the provider and key for the deployment, then use <Link to="/admin/settings" className="underline">Test connection</Link>.</> : 'Ask an administrator to configure the assistant.'}</div>
                </div>
              </div>
            )}
            {chat.enabled && !chat.conversationId && !chat.pending && (
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-2.5">
                  <GradyAvatar size={26} className="mt-0.5" />
                  <div className="rounded-2xl rounded-tl-md border border-default bg-white px-3.5 py-2.5 text-[13px] text-secondary shadow-card">{intro}</div>
                </div>
                {chat.suggestions.length > 0 && (
                  <div className="pl-9 flex flex-col gap-1.5">
                    {chat.suggestions.slice(0, 4).map((s) => (
                      <button key={s} onClick={() => send(s)} className="text-left rounded-xl border border-default bg-white px-3 py-2 text-[12.5px] text-secondary hover:border-strong hover:text-default hover:shadow-card transition-[box-shadow,border-color]">{s}</button>
                    ))}
                  </div>
                )}
                <div className="pl-9 text-[11.5px] text-subtle inline-flex items-center gap-1">{chat.canAct ? <><Zap className="h-3 w-3 text-brand-600" /> Grady can also create tickets, comment and assign, and always asks first.</> : 'Read-only: Grady can look things up but not change data.'}</div>
              </div>
            )}
            {chat.loadingMessages && <div className="text-[12.5px] text-subtle inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading conversation…</div>}
            {chat.messages.map((m) => <Bubble key={m.id} m={m} />)}
            {chat.awaitingGoAhead && (
              <div className="pl-9 flex flex-col gap-2">
                {chat.pendingAction && (
                  <div className="rounded-xl border border-amber-200/80 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
                    <span className="font-medium">Waiting for your go-ahead:</span> {chat.pendingAction.preview}. Nothing has been changed yet.
                  </div>
                )}
                <div className="flex gap-2">
                  <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} onClick={() => send('Yes, proceed.')}>Yes, go ahead</Button>
                  <Button size="sm" variant="outline" icon={<X className="h-3.5 w-3.5" />} onClick={() => send('No, do not do that.')}>No</Button>
                </div>
              </div>
            )}
            {chat.pending && <Thinking text={chat.pending} />}
            {err && (
              <div className="rounded-xl border border-red-200/70 bg-red-50 text-red-700 p-3 text-[12.5px] flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-px shrink-0" />
                <div className="flex-1 min-w-0">
                  <div>{(err as Error).message}</div>
                  {upstream && (can('admin:system') || can('admin:config')) && <div className="mt-1 text-red-600/80">Check <Link to="/admin/settings" className="underline">Administration → Settings</Link> and use Test connection.</div>}
                </div>
                {chat.lastSent && <button className="underline shrink-0" onClick={() => chat.retry()}>Retry</button>}
              </div>
            )}
            <div ref={bottom} />
          </div>

          {/* composer */}
          <div className="px-3 pb-3 pt-2 bg-white border-t border-default shrink-0">
            {chat.contextLabel && (
              <button type="button" onClick={() => chat.setUseContext(!chat.useContext)} title={chat.useContext ? 'Grady knows what you are viewing. Click to send without it.' : 'Context excluded. Click to include it again.'} className={cn('mb-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] max-w-full', chat.useContext ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-default text-subtle line-through')}>
                <span className={cn('h-1.5 w-1.5 rounded-full', chat.useContext ? 'bg-brand-500' : 'bg-zinc-300')} /> Viewing <span className="font-medium truncate">{chat.contextLabel}</span>
              </button>
            )}
            <div className="flex items-end gap-2 rounded-xl border border-default bg-white px-2 py-1.5 focus-within:border-brand-500 focus-within:ring-[3px] focus-within:ring-brand-500/20 transition-[box-shadow,border-color]">
              <textarea
                ref={textarea}
                className="flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[13px] leading-[1.5] outline-none placeholder:text-subtle min-h-[36px] max-h-32"
                rows={1}
                placeholder={chat.enabled ? 'Ask Grady…' : 'Grady is not configured'}
                disabled={!chat.enabled || !!chat.pending}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  } else if (e.key === 'ArrowUp' && !input && chat.lastSent) {
                    e.preventDefault();
                    setInput(chat.lastSent);
                  }
                }}
              />
              <button onClick={() => send()} disabled={!chat.enabled || !input.trim() || !!chat.pending} aria-label="Send" className="h-8 w-8 rounded-lg bg-brand-600 text-white flex items-center justify-center hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
                <Send className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[10.5px] text-subtle px-1">
              <span>Enter to send · Shift+Enter for a new line</span>
              <span>Answers only from data you can access</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- launcher

/** Grady lives in the bottom-right corner of every page: a launcher when closed, the chat window when open. */
export function GradyWidget() {
  const can = useAuthStore((s) => s.can);
  const user = useAuthStore((s) => s.user);
  const open = useUiStore((s) => s.assistantOpen);
  const setOpen = useUiStore((s) => s.setAssistantOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  if (!user || !can('ai:use')) return null;
  if (open) return <GradyWindow onClose={() => setOpen(false)} />;
  return (
    <button
      onClick={() => setOpen(true)}
      className="fixed z-40 bottom-4 right-4 group flex items-center gap-2 rounded-full bg-white border border-default pl-1 pr-3.5 py-1 shadow-raised hover:shadow-pop hover:border-strong transition-[box-shadow,border-color,transform] hover:-translate-y-px"
      aria-label="Open Grady, the service assistant"
      title="Ask Grady"
    >
      <GradyAvatar size={40} />
      <span className="text-[13px] font-semibold tracking-[-0.01em] text-default">Grady</span>
      <span className="absolute left-9 top-1.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white" aria-hidden />
    </button>
  );
}
