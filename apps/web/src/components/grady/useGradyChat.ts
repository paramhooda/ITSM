import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '@/stores/ui';
import { aiApi, aiQk, type AiMessage } from '@/components/ai/api';

/** Does the assistant's last message propose an action and wait for a go-ahead? */
export function proposesAction(m: AiMessage | undefined) {
  if (!m || m.role !== 'assistant') return false;
  const text = m.content.trim();
  if (!/\?[\s*_`)]*$/.test(text)) return false;
  return /(shall i|should i|do you want me|would you like me|want me to|confirm|proceed|go ahead)/i.test(text);
}

/** Conversation state and server calls behind the Grady window. */
export function useGradyChat() {
  const qc = useQueryClient();
  const assistantContext = useUiStore((s) => s.assistantContext);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [useContext, setUseContext] = useState(true);
  const [lastSent, setLastSent] = useState('');

  const status = useQuery({ queryKey: aiQk.status, queryFn: aiApi.status, staleTime: 60_000, retry: false });
  const enabled = !!status.data?.enabled;
  const conversations = useQuery({ queryKey: aiQk.conversations, queryFn: aiApi.conversations, staleTime: 30_000, retry: false, enabled });
  const messages = useQuery({ queryKey: aiQk.conversation(conversationId ?? ''), queryFn: () => aiApi.conversation(conversationId!), enabled: !!conversationId, retry: false });

  const send = useMutation({
    mutationFn: (text: string) => aiApi.chat({ conversationId: conversationId ?? undefined, message: text, context: useContext && assistantContext ? assistantContext : undefined }),
    onSuccess: (res, text) => {
      setConversationId(res.conversationId);
      qc.setQueryData(aiQk.conversation(res.conversationId), (old: { id: string; title: string | null; messages: AiMessage[] } | undefined) => {
        const mine: AiMessage = { id: `local-${Date.now()}`, role: 'user', content: text, toolCalls: [], createdAt: new Date().toISOString() };
        return { id: res.conversationId, title: old?.title ?? null, messages: [...(old?.messages ?? []), mine, res.message] };
      });
      void qc.invalidateQueries({ queryKey: aiQk.conversation(res.conversationId) });
      void qc.invalidateQueries({ queryKey: aiQk.conversations });
      if (res.message.toolCalls.some((t) => t.action && t.ok)) {
        void qc.invalidateQueries({ queryKey: ['tickets'] });
        void qc.invalidateQueries({ queryKey: ['approvals'] });
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => aiApi.deleteConversation(id),
    onSuccess: (_d, id) => {
      if (id === conversationId) setConversationId(null);
      qc.removeQueries({ queryKey: aiQk.conversation(id) });
      void qc.invalidateQueries({ queryKey: aiQk.conversations });
    },
  });

  const submit = useCallback(
    (text: string) => {
      const value = text.trim();
      if (!value || send.isPending || !enabled) return false;
      setLastSent(value);
      send.mutate(value);
      return true;
    },
    [send, enabled],
  );

  const list = messages.data?.messages ?? [];
  return {
    status,
    enabled,
    canAct: !!status.data?.canAct,
    suggestions: status.data?.suggestions ?? [],
    model: status.data?.model ?? null,
    conversations: conversations.data?.items ?? [],
    conversationId,
    open: (id: string | null) => setConversationId(id),
    title: messages.data?.title ?? null,
    messages: list,
    loadingMessages: messages.isLoading && !!conversationId,
    pending: send.isPending ? send.variables : null,
    error: send.isError ? send.error : null,
    lastSent,
    submit,
    retry: () => lastSent && submit(lastSent),
    reset: () => setConversationId(null),
    remove: (id: string) => remove.mutate(id),
    awaitingGoAhead: !send.isPending && !!status.data?.canAct && proposesAction(list[list.length - 1]),
    contextLabel: assistantContext?.label ? String(assistantContext.label) : null,
    useContext,
    setUseContext,
  };
}
