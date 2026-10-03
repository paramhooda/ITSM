import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '@/stores/ui';
import { ApiError } from '@/api/client';
import { aiApi, aiQk, chatStream, type AiMessage, type ChatBody, type PendingAction, type StreamEvent, type UiAction } from '@/components/ai/api';

/** Fallback only: the server now reports a pending action explicitly; this reads older replies that asked in prose. */
export function proposesAction(m: AiMessage | undefined) {
  if (!m || m.role !== 'assistant') return false;
  const text = m.content.trim();
  if (!/\?[\s*_`)]*$/.test(text)) return false;
  return /(shall i|should i|do you want me|would you like me|want me to|confirm|proceed|go ahead)/i.test(text);
}

/** One line of progress while a reply is prepared ("Looking up INC-… · done"). */
export interface StepLine {
  tool: string;
  summary: string;
  status: 'start' | 'done' | 'error';
  action: boolean;
}

/** Query-cache families refreshed after an action, by the hint the tool declares. */
const INVALIDATION: Record<string, string[][]> = {
  tickets: [['tickets'], ['dashboard'], ['portal']],
  approvals: [['approvals'], ['tickets'], ['portal']],
  visits: [['field'], ['pm'], ['visits'], ['portal']],
  knowledge: [['knowledge'], ['kb']],
  config: [['config'], ['lookups'], ['settings'], ['ai']],
  cmdb: [['cmdb'], ['discovery'], ['integrations']],
  assets: [['assets'], ['portal']],
  contracts: [['contracts'], ['customers'], ['portal']],
};

const STORAGE_KEY = 'grady.conversation';
const readStored = () => {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

type ConversationCache = { id: string; title: string | null; messages: AiMessage[]; pendingAction?: PendingAction | null };

/** Conversation state and server calls behind the Grady window. */
export function useGradyChat(opts: { onUiAction?: (action: UiAction) => void } = {}) {
  const qc = useQueryClient();
  const assistantContext = useUiStore((s) => s.assistantContext);
  const assistantPage = useUiStore((s) => s.assistantPage);
  const [conversationId, setConversationIdState] = useState<string | null>(readStored);
  const [useContext, setUseContext] = useState(true);
  const [lastSent, setLastSent] = useState<{ message: string; skill?: string } | null>(null);
  /** The action the server holds for confirmation on the open conversation (from the last reply or the loaded conversation). */
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [steps, setSteps] = useState<StepLine[]>([]);
  const [activeToolsets, setActiveToolsets] = useState<string[]>([]);
  const onUiAction = useRef(opts.onUiAction);
  onUiAction.current = opts.onUiAction;

  const setConversationId = useCallback((id: string | null) => {
    setConversationIdState(id);
    try {
      if (id) sessionStorage.setItem(STORAGE_KEY, id);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const status = useQuery({ queryKey: aiQk.status, queryFn: aiApi.status, staleTime: 60_000, retry: false });
  const enabled = !!status.data?.enabled;
  const conversations = useQuery({ queryKey: aiQk.conversations, queryFn: aiApi.conversations, staleTime: 30_000, retry: false, enabled });
  const messages = useQuery({ queryKey: aiQk.conversation(conversationId ?? ''), queryFn: () => aiApi.conversation(conversationId!), enabled: !!conversationId && enabled, retry: false });
  // A stored conversation that no longer exists (deleted, another account) is forgotten quietly.
  useEffect(() => {
    if (messages.isError && conversationId) setConversationId(null);
  }, [messages.isError, conversationId, setConversationId]);

  const onEvent = useCallback((e: StreamEvent) => {
    if (e.type === 'turn') setConversationId(e.conversationId);
    else if (e.type === 'toolsets') setActiveToolsets(e.active);
    else if (e.type === 'step') {
      setSteps((cur) => {
        if (e.status === 'start') return [...cur, { tool: e.tool, summary: e.summary, status: 'start', action: e.action }];
        const i = cur.map((s) => s.tool).lastIndexOf(e.tool);
        if (i < 0) return [...cur, { tool: e.tool, summary: e.summary, status: e.status, action: e.action }];
        return cur.map((s, j) => (j === i ? { ...s, summary: e.summary, status: e.status } : s));
      });
    }
  }, [setConversationId]);

  const send = useMutation({
    mutationFn: (body: ChatBody) => {
      setSteps([]);
      const entity = useContext && assistantContext ? assistantContext : {};
      const context = { ...entity, ...(assistantPage ? { page: assistantPage } : {}) };
      return chatStream({ conversationId: conversationId ?? undefined, context: Object.keys(context).length ? context : undefined, ...body }, { onEvent });
    },
    onSuccess: (res, body) => {
      setConversationId(res.conversationId);
      setPendingAction(res.pendingAction ?? null);
      qc.setQueryData(aiQk.conversation(res.conversationId), (old: ConversationCache | undefined) => {
        const content = body.message ?? (body.confirm?.decision === 'confirm' ? 'Yes, go ahead.' : 'No, cancel that.');
        const mine: AiMessage = { id: `local-${Date.now()}`, role: 'user', content, toolCalls: [], createdAt: new Date().toISOString() };
        return { id: res.conversationId, title: old?.title ?? null, messages: [...(old?.messages ?? []), mine, res.message], pendingAction: res.pendingAction ?? null };
      });
      void qc.invalidateQueries({ queryKey: aiQk.conversation(res.conversationId) });
      void qc.invalidateQueries({ queryKey: aiQk.conversations });
      const ran = res.message.toolCalls.filter((t) => t.action && t.ok && !t.proposed);
      if (ran.length) {
        const hints = new Set(ran.flatMap((t) => t.invalidates ?? ['tickets', 'approvals']));
        for (const h of hints) for (const key of INVALIDATION[h] ?? [[h]]) void qc.invalidateQueries({ queryKey: key });
      }
      for (const a of res.uiActions ?? []) onUiAction.current?.(a);
    },
    onError: (err) => {
      // The held action was decided elsewhere or expired: reload the conversation so the panel shows the real state.
      if (err instanceof ApiError && err.code === 'stale_action') {
        setPendingAction(null);
        if (conversationId) void qc.invalidateQueries({ queryKey: aiQk.conversation(conversationId) });
      }
    },
    onSettled: () => setSteps([]),
  });

  const remove = useMutation({
    mutationFn: (id: string) => aiApi.deleteConversation(id),
    onSuccess: (_d, id) => {
      if (id === conversationId) setConversationId(null);
      qc.removeQueries({ queryKey: aiQk.conversation(id) });
      void qc.invalidateQueries({ queryKey: aiQk.conversations });
    },
  });

  const rate = useMutation({
    mutationFn: ({ messageId, rating, note }: { messageId: string; rating: 'up' | 'down' | null; note?: string | null }) => aiApi.feedback(messageId, rating, note),
    onMutate: ({ messageId, rating }) => {
      if (!conversationId) return;
      qc.setQueryData(aiQk.conversation(conversationId), (old: ConversationCache | undefined) => (old ? { ...old, messages: old.messages.map((m) => (m.id === messageId ? { ...m, feedback: rating } : m)) } : old));
    },
  });

  const submit = useCallback(
    (text: string, skill?: string) => {
      const value = text.trim();
      if (!value || send.isPending || !enabled) return false;
      setLastSent({ message: value, skill });
      send.mutate({ message: value, ...(skill ? { skill } : {}) });
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
    autonomy: status.data?.autonomy ?? 'confirm_all',
    suggestions: status.data?.suggestions ?? [],
    toolsets: status.data?.toolsets ?? [],
    skills: status.data?.skills ?? [],
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
    steps,
    activeToolsets,
    error: send.isError ? send.error : null,
    lastSent: lastSent?.message ?? '',
    submit,
    confirm,
    rate: (messageId: string, rating: 'up' | 'down' | null, note?: string | null) => rate.mutate({ messageId, rating, note }),
    retry: () => (lastSent ? submit(lastSent.message, lastSent.skill) : false),
    reset: () => {
      setConversationId(null);
      setPendingAction(null);
      setActiveToolsets([]);
    },
    remove: (id: string) => remove.mutate(id),
    pendingAction: held,
    awaitingGoAhead: !send.isPending && !!status.data?.canAct && (!!held || proposesAction(list[list.length - 1])),
    contextLabel: assistantContext?.label ? String(assistantContext.label) : null,
    page: assistantPage,
    useContext,
    setUseContext,
  };
}
