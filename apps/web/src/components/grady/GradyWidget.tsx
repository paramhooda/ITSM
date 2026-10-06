import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { matchRoute } from '@itsm/shared';
import { Send, X, Trash2, Loader2, Plus, History, Search, Zap, AlertTriangle, Check, ChevronLeft, Settings2, Minus, ThumbsUp, ThumbsDown, Megaphone, ShieldAlert, Wrench, Compass } from 'lucide-react';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { Badge, Button, Kbd } from '@/components/ui';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/format';
import { ApiError } from '@/api/client';
import type { AiMessage, PendingAction, ToolCallRecord } from '@/components/ai/api';
import { GradyAvatar } from './GradyAvatar';
import { useGradyChat, type StepLine } from './useGradyChat';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = `${isMac ? '⌘' : 'Ctrl'}+J`;

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
  thead: ({ children }: { children?: ReactNode }) => <thead className="bg-app">{children}</thead>,
  th: ({ children }: { children?: ReactNode }) => <th className="text-left font-medium text-muted px-2 py-1.5">{children}</th>,
  td: ({ children }: { children?: ReactNode }) => <td className="px-2 py-1.5 border-t border-default align-top leading-[1.4] [&>a]:whitespace-nowrap">{children}</td>,
};

// ---------------------------------------------------------------- slash commands

interface SlashCommand {
  cmd: string;
  /** The skill the command forces; the first one the user has is used. */
  skills: string[];
  hint: string;
  /** Builds the message from the argument and the record on screen. */
  make: (arg: string, context: string | null) => string;
}
const COMMANDS: SlashCommand[] = [
  { cmd: '/status', skills: ['lookup'], hint: 'Status of a ticket, customer or CI', make: (a, c) => (a ? `Status of ${a}` : c ? `Status of ${c}` : 'What needs my attention right now?') },
  { cmd: '/triage', skills: ['triage'], hint: 'Classify, route and de-duplicate a ticket', make: (a, c) => `Triage ${a || c || 'the unassigned open tickets'}` },
  { cmd: '/new', skills: ['act', 'selfservice'], hint: 'Raise a ticket', make: (a) => (a ? `Raise a ticket: ${a}` : 'I want to raise a ticket') },
  { cmd: '/incident', skills: ['incident'], hint: 'Major incidents and the bridge', make: (a) => a || 'Which major incidents are active, and is any update overdue?' },
  { cmd: '/approve', skills: ['approvals'], hint: 'Approvals waiting for me', make: (a) => a || 'What is waiting for my approval?' },
  { cmd: '/report', skills: ['analyse'], hint: 'Figures, trends and reports', make: (a) => a || 'Give me the headline figures for the last 30 days' },
  { cmd: '/find', skills: ['lookup'], hint: 'Find a record', make: (a) => (a ? `Find ${a}` : 'Find a record for me') },
  { cmd: '/kb', skills: ['knowledge'], hint: 'Search the knowledge base', make: (a) => (a ? `What does the knowledge base say about ${a}?` : 'Search the knowledge base') },
  { cmd: '/admin', skills: ['admin'], hint: 'Read or change configuration', make: (a) => a || 'Show the assistant settings' },
  { cmd: '/help', skills: ['navigate'], hint: 'Where is…, how do I…, what can you do here', make: (a) => (a ? `How do I ${a.replace(/\?$/, '')}?` : 'What can you do on this page?') },
];

function parseCommand(text: string, available: SlashCommand[]): { message: string; skill: string } | null {
  const m = /^\/(\w+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const cmd = available.find((c) => c.cmd === `/${m[1]!.toLowerCase()}`);
  if (!cmd) return null;
  return { message: cmd.make(m[2]!.trim(), null), skill: cmd.skills[0]! };
}

// ---------------------------------------------------------------- pieces

/** One quiet line per tool call: what Grady checked or did, never the raw payload. */
function ToolLine({ t }: { t: ToolCallRecord }) {
  const Icon = !t.ok ? AlertTriangle : t.action ? Check : Search;
  return (
    <div className={cn('flex items-center gap-1.5 text-[11.5px] min-w-0', !t.ok ? 'text-red-600' : t.action ? 'text-emerald-700' : 'text-subtle')} title={t.error ? `${t.name}: ${t.error}` : t.name}>
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{!t.ok ? `Could not ${t.name.replace(/_/g, ' ')}` : t.action ? `${t.proposed ? 'Proposed' : 'Done'}: ${t.summary.replace(/^Proposed: /, '')}` : t.summary || `Checked ${t.name.replace(/_/g, ' ')}`}</span>
    </div>
  );
}

/** Thumbs on a reply; a thumbs-down asks for one line in place (no dialog). */
function Feedback({ m, onRate }: { m: AiMessage; onRate: (rating: 'up' | 'down' | null, note?: string | null) => void }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const up = m.feedback === 'up';
  const down = m.feedback === 'down';
  return (
    <div className="mt-1 pl-1">
      <div className="flex items-center gap-0.5">
        <button type="button" className={cn('h-6 w-6 rounded-md flex items-center justify-center hover:bg-surface-2', up ? 'text-emerald-700' : 'text-subtle hover:text-default')} title="Helpful" aria-label="Helpful" aria-pressed={up} onClick={() => { setNoteOpen(false); onRate(up ? null : 'up'); }}><ThumbsUp className="h-3 w-3" /></button>
        <button type="button" className={cn('h-6 w-6 rounded-md flex items-center justify-center hover:bg-surface-2', down ? 'text-red-600' : 'text-subtle hover:text-default')} title="Not helpful" aria-label="Not helpful" aria-pressed={down} onClick={() => { if (down) { onRate(null); setNoteOpen(false); } else setNoteOpen((v) => !v); }}><ThumbsDown className="h-3 w-3" /></button>
      </div>
      {noteOpen && (
        <form
          className="mt-1 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            onRate('down', note.trim() || null);
            setNoteOpen(false);
            setNote('');
          }}
        >
          <input className="input h-7 py-0 text-[12px] flex-1" placeholder="What was wrong? (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} autoFocus />
          <Button size="sm" type="submit">Send</Button>
        </form>
      )}
    </div>
  );
}

function Bubble({ m, onRate }: { m: AiMessage; onRate?: (rating: 'up' | 'down' | null, note?: string | null) => void }) {
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
        {onRate && !m.id.startsWith('local-') && <Feedback m={m} onRate={onRate} />}
      </div>
    </div>
  );
}

/** The user's message and Grady's progress while the reply is prepared: one line per tool, live. */
function Thinking({ text, steps }: { text: string; steps: StepLine[] }) {
  return (
    <>
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-3.5 py-2 text-[13px] text-white whitespace-pre-wrap">{text}</div>
      </div>
      <div className="flex items-start gap-2.5">
        <GradyAvatar size={26} mood="thinking" />
        <div className="min-w-0">
          <div className="rounded-2xl rounded-tl-md border border-default bg-white px-3.5 py-2.5 shadow-card inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-bounce [animation-delay:-0.2s]" />
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-bounce [animation-delay:-0.1s]" />
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-bounce" />
          </div>
          {steps.length > 0 && (
            <div className="mt-1 pl-1 flex flex-col gap-0.5" aria-live="polite">
              {steps.slice(-5).map((s, i) => {
                const Icon = s.status === 'start' ? Loader2 : s.status === 'error' ? AlertTriangle : s.action ? Check : Search;
                return (
                  <div key={`${s.tool}-${i}`} className={cn('flex items-center gap-1.5 text-[11.5px] min-w-0', s.status === 'error' ? 'text-red-600' : s.status === 'done' && s.action ? 'text-emerald-700' : 'text-subtle')}>
                    <Icon className={cn('h-3 w-3 shrink-0', s.status === 'start' && 'animate-spin')} />
                    <span className="truncate">{s.summary}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const TIER: Record<string, { title: string; Icon: typeof Check; box: string }> = {
  write_low: { title: 'Waiting for your go-ahead', Icon: Check, box: 'border-amber-200/80 bg-amber-50 text-amber-900' },
  write: { title: 'Waiting for your go-ahead', Icon: Check, box: 'border-amber-200/80 bg-amber-50 text-amber-900' },
  outbound: { title: 'Sends to people outside the platform', Icon: Megaphone, box: 'border-amber-200/80 bg-amber-50 text-amber-900' },
  admin: { title: 'Configuration change', Icon: Wrench, box: 'border-amber-200/80 bg-amber-50 text-amber-900' },
  destructive: { title: 'Destructive action', Icon: ShieldAlert, box: 'border-red-200/80 bg-red-50 text-red-800' },
};

/** The proposal card: what exactly will happen, bound to the action id, with Confirm and Cancel. */
function ActionCard({ action, busy, onDecide }: { action: PendingAction; busy: boolean; onDecide: (d: 'confirm' | 'cancel') => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const tone = TIER[action.tier ?? 'write'] ?? TIER.write!;
  const minutesLeft = action.expiresAt ? Math.max(0, Math.round((new Date(action.expiresAt).getTime() - now) / 60_000)) : null;
  const lines = action.lines ?? [];
  return (
    <div className={cn('rounded-xl border px-3 py-2.5 text-[12.5px]', tone.box)} role="group" aria-label="Proposed action">
      <div className="flex items-center gap-1.5">
        <tone.Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{tone.title}</span>
        {minutesLeft !== null && <span className="ml-auto text-[11px] opacity-75">{minutesLeft > 0 ? `expires in ${minutesLeft} min` : 'expired'}</span>}
      </div>
      <div className="mt-1 leading-[1.5]">{action.preview}</div>
      {lines.length > 0 && (
        <ul className="mt-1.5 pl-4 list-disc space-y-0.5 marker:opacity-60">
          {lines.slice(0, 8).map((l, i) => <li key={i}>{l}</li>)}
          {lines.length > 8 && <li>and {lines.length - 8} more</li>}
        </ul>
      )}
      {action.count !== undefined && <div className="mt-1 font-medium">{action.count} record{action.count === 1 ? '' : 's'} affected</div>}
      <div className="mt-1.5 text-[11px] opacity-75">Nothing has been changed yet.</div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} onClick={() => onDecide('confirm')} disabled={busy || minutesLeft === 0}>Confirm</Button>
        <Button size="sm" variant="outline" icon={<X className="h-3.5 w-3.5" />} onClick={() => onDecide('cancel')} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- window

function GradyWindow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const chat = useGradyChat({
    onUiAction: (a) => {
      navigate(a.to);
      toast(a.label ? `Opened ${a.label}` : 'Opened the page');
    },
  });
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const [input, setInput] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chat.messages.length, chat.pending, chat.steps.length, open]);
  useEffect(() => {
    if (open && !historyOpen) textarea.current?.focus();
  }, [open, historyOpen, chat.conversationId]);

  const firstName = user?.name.split(' ')[0] ?? '';
  const intro = useMemo(() => (user?.userType === 'customer' ? `Hi ${firstName}, I can check your tickets, service levels and visits, or raise a ticket for you.` : `Hi ${firstName}, ask me about tickets, customers, SLAs, contracts, assets or CIs, or tell me what to do. I only see what you are allowed to see.`), [user, firstName]);
  const skillKeys = useMemo(() => new Set(chat.skills.map((s) => s.key)), [chat.skills]);
  const commands = useMemo(() => COMMANDS.filter((c) => c.skills.some((k) => skillKeys.has(k))).map((c) => ({ ...c, skills: c.skills.filter((k) => skillKeys.has(k)) })), [skillKeys]);
  const menuMatches = useMemo(() => {
    if (!input.startsWith('/') || /\s/.test(input)) return [];
    const q = input.toLowerCase();
    return commands.filter((c) => c.cmd.startsWith(q));
  }, [input, commands]);
  useEffect(() => setMenuIndex(0), [menuMatches.length]);
  const pageHit = useMemo(() => (chat.page ? matchRoute(chat.page.pathname) : null), [chat.page]);
  const pageSets = useMemo(() => (pageHit?.page.toolsets ?? []).map((k) => chat.toolsets.find((t) => t.key === k)).filter((t): t is { key: string; label: string; description: string } => !!t), [pageHit, chat.toolsets]);

  const send = (text?: string) => {
    const raw = (text ?? input).trim();
    if (!raw) return;
    const parsed = parseCommand(raw, commands);
    const ok = parsed ? chat.submit(parsed.message.replace(/^Status of $/, `Status of ${chat.contextLabel ?? 'this'}`), parsed.skill) : chat.submit(raw);
    if (ok && text === undefined) setInput('');
  };
  const pick = (c: SlashCommand) => {
    setInput(`${c.cmd} `);
    textarea.current?.focus();
  };
  const err = chat.error;
  const upstream = err instanceof ApiError && (err.code === 'ai_upstream' || err.code === 'ai_disabled');
  const errorText = err instanceof ApiError && err.status === 429 ? (err.code === 'ai_budget_exceeded' ? err.message : 'Slow down a little: too many messages in the last minute. Try again shortly.') : err instanceof ApiError && err.code === 'stale_action' ? 'That proposal was already decided or has expired. Ask again if you still want it.' : (err as Error | null)?.message;
  const isAdmin = can('admin:system') || can('admin:config');

  return (
    <div className={cn('fixed z-50 bottom-4 right-4 w-[min(500px,calc(100vw-2rem))] h-[min(700px,calc(100vh-2rem))] flex-col rounded-2xl border border-default bg-app shadow-pop scale-in overflow-hidden', open ? 'flex' : 'hidden')} role="dialog" aria-label="Grady, service assistant" aria-hidden={!open}>
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
                <span className="hidden sm:inline-flex ml-1"><Kbd>{SHORTCUT}</Kbd></span>
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
        <button className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-default hover:bg-surface-2" title={`Minimise (Esc or ${SHORTCUT})`} onClick={onClose} aria-label="Close"><Minus className="h-4 w-4" /></button>
      </div>

      {historyOpen ? (
        <div className="flex-1 overflow-y-auto p-2">
          {chat.conversations.length === 0 && <div className="px-3 py-8 text-center text-[12.5px] text-subtle">No conversations yet.</div>}
          {chat.conversations.map((c) => (
            <div key={c.id} className={cn('group flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer hover:bg-white hover:shadow-card', c.id === chat.conversationId && 'bg-white shadow-card')} onClick={() => { chat.open(c.id); setHistoryOpen(false); }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[13px] truncate text-default">{c.title || 'Untitled'}</span>
                  {c.context?.channel === 'whatsapp' && <Badge color="green" title="This thread runs on WhatsApp">WhatsApp</Badge>}
                </div>
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
                  <div className="text-amber-800/90 mt-0.5">{isAdmin ? <>Set the provider and key for the deployment, then use <Link to="/admin/ai" className="underline">Test connection</Link>.</> : 'Ask an administrator to configure the assistant.'}</div>
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
                {pageSets.length > 0 && (
                  <div className="pl-9 flex flex-wrap items-center gap-1.5 text-[11.5px] text-subtle">
                    <Compass className="h-3 w-3" /> On this page:
                    {pageSets.map((t) => <span key={t.key} className="rounded-full border border-default bg-white px-2 py-0.5 text-[11px] text-secondary" title={t.description}>{t.label}</span>)}
                  </div>
                )}
                <div className="pl-9 text-[11.5px] text-subtle inline-flex items-center gap-1">{chat.canAct ? <><Zap className="h-3 w-3 text-brand-600" /> Grady can also act (create, assign, comment, configure) and always shows a preview first.</> : 'Read-only: Grady can look things up and open pages, but not change data.'}</div>
              </div>
            )}
            {chat.loadingMessages && <div className="text-[12.5px] text-subtle inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading conversation…</div>}
            {chat.messages.map((m) => <Bubble key={m.id} m={m} onRate={(rating, note) => chat.rate(m.id, rating, note)} />)}
            {chat.awaitingGoAhead && (
              <div className="pl-9 flex flex-col gap-2">
                {chat.pendingAction ? (
                  <ActionCard action={chat.pendingAction} busy={!!chat.pending} onDecide={(d) => chat.confirm(d)} />
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} onClick={() => send('Yes, proceed.')}>Yes, go ahead</Button>
                    <Button size="sm" variant="outline" icon={<X className="h-3.5 w-3.5" />} onClick={() => send('No, do not do that.')}>No</Button>
                  </div>
                )}
              </div>
            )}
            {chat.pending && <Thinking text={chat.pending} steps={chat.steps} />}
            {err && (
              <div className="rounded-xl border border-red-200/70 bg-red-50 text-red-700 p-3 text-[12.5px] flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-px shrink-0" />
                <div className="flex-1 min-w-0">
                  <div>{errorText}</div>
                  {upstream && isAdmin && <div className="mt-1 text-red-600/80">Check <Link to="/admin/ai" className="underline">Administration → AI assistant</Link> and use Test connection.</div>}
                </div>
                {chat.lastSent && <button className="underline shrink-0" onClick={() => chat.retry()}>Retry</button>}
              </div>
            )}
            <div ref={bottom} />
          </div>

          {/* composer */}
          <div className="px-3 pb-3 pt-2 bg-white border-t border-default shrink-0 relative">
            {menuMatches.length > 0 && (
              <div className="absolute left-3 right-3 bottom-full mb-1 rounded-xl border border-default bg-white shadow-pop overflow-hidden" role="listbox" aria-label="Commands">
                {menuMatches.map((c, i) => (
                  <button key={c.cmd} type="button" role="option" aria-selected={i === menuIndex} className={cn('w-full flex items-baseline gap-2 px-3 py-1.5 text-left text-[12.5px]', i === menuIndex ? 'bg-brand-50 text-brand-800' : 'text-secondary hover:bg-surface-2')} onMouseEnter={() => setMenuIndex(i)} onClick={() => pick(c)}>
                    <span className="font-mono font-medium text-default">{c.cmd}</span>
                    <span className="text-[11.5px] text-muted truncate">{c.hint}</span>
                  </button>
                ))}
              </div>
            )}
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
                placeholder={chat.enabled ? 'Ask Grady, or type / for commands…' : 'Grady is not configured'}
                disabled={!chat.enabled || !!chat.pending}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (menuMatches.length) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIndex((i) => (i + 1) % menuMatches.length); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setMenuIndex((i) => (i - 1 + menuMatches.length) % menuMatches.length); return; }
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(menuMatches[menuIndex] ?? menuMatches[0]!); return; }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setInput(''); return; }
                  }
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
              <span>Enter to send · Shift+Enter for a new line · / for commands</span>
              <span>Answers only from data you can access</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- launcher

/**
 * Grady lives in the bottom-right corner of every page: a launcher when closed,
 * the chat window when open. The window stays mounted while closed, so the
 * conversation, the draft and the proposal card survive a minimise.
 */
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
  return (
    <>
      <GradyWindow open={open} onClose={() => setOpen(false)} />
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed z-40 bottom-4 right-4 group flex items-center gap-2 rounded-full bg-white border border-default pl-1 pr-3.5 py-1 shadow-raised hover:shadow-pop hover:border-strong transition-[box-shadow,border-color,transform] hover:-translate-y-px"
          aria-label="Open Grady, the service assistant"
          title={`Ask Grady (${SHORTCUT})`}
        >
          <GradyAvatar size={40} />
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-default">Grady</span>
          <span className="absolute left-9 top-1.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white" aria-hidden />
        </button>
      )}
    </>
  );
}
