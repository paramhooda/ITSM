import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '@/stores/ui';
import { ApiError } from '@/api/client';
import { aiApi, aiQk, type AiMessage, type ChatBody, type PendingAction } from '@/components/ai/api';

/** Fallback only: the server now reports a pending action explicitly; this reads older replies that asked in prose. */
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
  /** The action the server holds for confirmation on the open conversation (from the last reply or the loaded conversation). */
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const status = useQuery({ queryKey: aiQk.status, queryFn: aiApi.status, staleTime: 60_000, retry: false });
  const enabled = !!status.data?.enabled;
  const conversations = useQuery({ queryKey: aiQk.conversations, queryFn: aiApi.conversations, staleTime: 30_000, retry: false, enabled });
  const messages = useQuery({ queryKey: aiQk.conversation(conversationId ?? ''), queryFn: () => aiApi.conversation(conversationId!), enabled: !!conversationId, retry: false });

  const send = useMutation({
    mutationFn: (body: ChatBody) => aiApi.chat({ conversationId: conversationId ?? undefined, context: useContext && assistantContext ? assistantContext : undefined, ...body }),
    onSuccess: (res, body) => {
      setConversationId(res.conversationId);
      setPendingAction(res.pendingAction ?? null);
      qc.setQueryData(aiQk.conversation(res.conversationId), (old: { id: string; title: string | null; messages: AiMessage[]; pendingAction?: PendingAction | null } | undefined) => {
        const content = body.message ?? (body.confirm?.decision === 'confirm' ? 'Yes, go ahead.' : 'No, cancel that.');
        const mine: AiMessage = { id: `local-${Date.now()}`, role: 'user', content, toolCalls: [], createdAt: new Date().toISOString() };
        return { id: res.conversationId, title: old?.title ?? null, messages: [...(old?.messages ?? []), mine, res.message], pendingAction: res.pendingAction ?? null };
      });
      void qc.invalidateQueries({ queryKey: aiQk.conversation(res.conversationId) });
      void qc.invalidateQueries({ queryKey: aiQk.conversations });
      if (res.message.toolCalls.some((t) => t.action && t.ok && !t.proposed)) {
        void qc.invalidateQueries({ queryKey: ['tickets'] });
        void qc.invalidateQueries({ queryKey: ['approvals'] });
      }
    },
    onError: (err) => {
      // The held action was decided elsewhere or expired: reload the conversation so the panel shows the real state.
      if (err instanceof ApiError && err.code === 'stale_action') {
        setPendingAction(null);
        if (conversationId) void qc.invalidateQueries({ queryKey: aiQk.conversation(conversationId) });
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
      send.mutate({ message: value });
      return true;
    },
    [send, enabled],
  );
  /** Decides the held action by its id, so a stale button can never run something else. */
  const confirm = useCallback(
    (decision: 'confirm' | 'cancel') => {
      const action = messages.data?.pendingAction ?? pendingAction;
      if (!action || send.isPending || !enabled || !conversationId) return false;
      send.mutate({ conversationId, confirm: { actionId: action.id, decision } });
      return true;
    },
    [send, enabled, conversationId, messages.data?.pendingAction, pendingAction],
  );

  const list = messages.data?.messages ?? [];
  // A conversation reopened from the list carries its own pending action.
  const held = send.isPending ? null : (messages.data?.pendingAction ?? pendingAction);
  return {
    status,
    enabled,
    canAct: !!status.data?.canAct,
    suggestions: status.data?.suggestions ?? [],
    model: status.data?.model ?? null,
    conversations: conversations.data?.items ?? [],
    conversationId,
    open: (id: string | null) => {
      setConversationId(id);
      setPendingAction(null);
    },
    title: messages.data?.title ?? null,
    messages: list,
    loadingMessages: messages.isLoading && !!conversationId,
    pending: send.isPending ? (send.variables.message ?? (send.variables.confirm?.decision === 'confirm' ? 'Yes, go ahead.' : 'No, cancel that.')) : null,
    error: send.isError ? send.error : null,
    lastSent,
    submit,
    confirm,
    retry: () => lastSent && submit(lastSent),
    reset: () => {
      setConversationId(null);
      setPendingAction(null);
    },
    remove: (id: string) => remove.mutate(id),
    pendingAction: held,
    awaitingGoAhead: !send.isPending && !!status.data?.canAct && (!!held || proposesAction(list[list.length - 1])),
    contextLabel: assistantContext?.label ? String(assistantContext.label) : null,
    useContext,
    setUseContext,
  };
}
