import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { Sparkles, Send, X, Trash2, Loader2 } from 'lucide-react';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { get, post, del } from '@/api/client';
import { Button } from '@/components/ui';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: { name: string; summary?: string }[];
  createdAt: string;
}

export function AssistantPanel() {
  const { setAssistantOpen, assistantContext } = useUiStore();
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const status = useQuery({ queryKey: ['ai', 'status'], queryFn: () => get<{ enabled: boolean; provider: string; model?: string; suggestions: string[] }>('/ai/status'), staleTime: 60_000 });
  const messages = useQuery({ queryKey: ['ai', 'conversation', conversationId], queryFn: () => get<{ messages: Message[] }>(`/ai/conversations/${conversationId}`), enabled: !!conversationId });

  const send = useMutation({
    mutationFn: (text: string) => post<{ conversationId: string; message: Message }>('/ai/chat', { conversationId, message: text, context: assistantContext ?? undefined }),
    onSuccess: (res) => {
      setConversationId(res.conversationId);
      qc.invalidateQueries({ queryKey: ['ai', 'conversation', res.conversationId] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });

  const clear = useMutation({
    mutationFn: () => (conversationId ? del(`/ai/conversations/${conversationId}`) : Promise.resolve()),
    onSuccess: () => setConversationId(null),
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.data, send.isPending]);

  const list = messages.data?.messages ?? [];
  const pendingUser = send.isPending ? send.variables : null;

  function submit() {
    const text = input.trim();
    if (!text || send.isPending) return;
    setInput('');
    send.mutate(text);
  }

  return (
    <aside className="w-[380px] shrink-0 border-l border-default bg-surface flex flex-col hidden lg:flex">
      <div className="h-11 flex items-center gap-2 px-3 border-b border-default">
        <Sparkles className="h-4 w-4 text-brand-600" />
        <div className="font-semibold text-[13px] flex-1">Assistant</div>
        {conversationId && (
          <button className="text-subtle hover:text-default" title="New conversation" onClick={() => clear.mutate()}>
            <Trash2 className="h-4 w-4" />
          </button>
        )}
        <button className="text-subtle hover:text-default" onClick={() => setAssistantOpen(false)}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-[13px]">
        {status.data && !status.data.enabled && (
          <div className="rounded-md bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 p-3 text-xs">
            The AI provider is not configured. Set <code>AI_PROVIDER</code> and an API key to enable conversational assistance. Rule-based suggestions (similar tickets, knowledge matches) remain available on ticket pages.
          </div>
        )}
        {list.length === 0 && !pendingUser && status.data?.enabled && (
          <div className="space-y-2">
            <div className="text-muted">Hi {user?.name.split(' ')[0]}, ask me about tickets, customers, SLAs, contracts or assets. I only see what you are authorized to see.</div>
            <div className="flex flex-wrap gap-1.5">
              {(status.data?.suggestions ?? []).map((s) => (
                <button key={s} onClick={() => send.mutate(s)} className="rounded-full border border-default px-2.5 py-1 text-xs text-muted hover:text-default hover:bg-surface-2">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {list.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div className={m.role === 'user' ? 'bg-brand-600 text-white rounded-xl rounded-br-sm px-3 py-2 max-w-[85%]' : 'bg-surface-2 rounded-xl rounded-bl-sm px-3 py-2 max-w-[95%] prose-sm'}>
              {m.role === 'assistant' ? <ReactMarkdown>{m.content}</ReactMarkdown> : m.content}
              {m.toolCalls && m.toolCalls.length > 0 && (
                <div className="mt-1 text-[11px] text-subtle">
                  {m.toolCalls.map((t, i) => (
                    <div key={i}>⚙ {t.summary ?? t.name}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {pendingUser && (
          <>
            <div className="flex justify-end">
              <div className="bg-brand-600 text-white rounded-xl rounded-br-sm px-3 py-2 max-w-[85%]">{pendingUser}</div>
            </div>
            <div className="flex items-center gap-2 text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
            </div>
          </>
        )}
        {send.isError && <div className="text-red-600 text-xs">{(send.error as Error).message}</div>}
        <div ref={bottom} />
      </div>
      <div className="p-3 border-t border-default">
        <div className="flex items-end gap-2">
          <textarea
            className="input min-h-[40px] max-h-32 resize-none"
            rows={1}
            placeholder={status.data?.enabled ? 'Ask or instruct… (Enter to send)' : 'AI not configured'}
            disabled={!status.data?.enabled}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button size="icon" onClick={submit} disabled={!status.data?.enabled || !input.trim()} loading={send.isPending} aria-label="Send">
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {assistantContext && <div className="text-[11px] text-subtle mt-1 truncate">Context: {String(assistantContext.label ?? '')}</div>}
      </div>
    </aside>
  );
}
