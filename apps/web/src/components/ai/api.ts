import { get, post, del, tryRefresh, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

/** Shapes of the AI module (kept in sync with apps/api/src/modules/ai). */
export interface AiStatus {
  enabled: boolean;
  provider: string;
  model: string | null;
  features: string[];
  assistantEnabled?: boolean;
  autonomy?: 'confirm_all' | 'auto_low';
  canAct: boolean;
  tools: { name: string; action: boolean; tier?: string; toolset?: string }[];
  /** Tool groups the user may enable (at least one tool available) and the playbooks the prompt carries for them. */
  toolsets?: { key: string; label: string; description: string }[];
  skills?: { key: string; title: string; when: string }[];
  promptVersion?: string;
  suggestions: string[];
  /** What the server is configured with (no credentials). */
  configured?: { provider: string; model: string | null; baseUrl: string | null };
}

export interface AiTestResult {
  ok: boolean;
  provider: string;
  model: string | null;
  baseUrl: string | null;
  latencyMs: number;
  reply?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: { status: number; code: string; message: string };
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  summary: string;
  ok: boolean;
  action: boolean;
  error?: string;
  /** The action was only proposed; it runs when the user confirms. */
  proposed?: boolean;
  /** A low-risk write applied without confirmation. */
  auto?: boolean;
  /** Query caches to refresh after this action ran. */
  invalidates?: string[];
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallRecord[];
  feedback?: 'up' | 'down' | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  updatedAt: string;
  createdAt: string;
  messageCount: number;
}

/** An action the assistant proposed and the platform holds until the user confirms it. */
export interface PendingAction {
  id: string;
  tool: string;
  tier?: string;
  preview: string;
  /** The exact changes (multi-field, bulk) and the number of records touched (destructive). */
  lines?: string[];
  count?: number;
  expiresAt?: string;
}

/** A decision on the held action, bound to its id (Confirm / Cancel buttons). */
export interface ChatConfirm {
  actionId: string;
  decision: 'confirm' | 'cancel';
}

export interface ChatBody {
  conversationId?: string | null;
  message?: string;
  context?: Record<string, unknown> | null;
  confirm?: ChatConfirm | null;
  skill?: string;
}

/** Something the web does after a reply (navigation); produced by UI tools on the server. */
export interface UiAction {
  type: 'navigate';
  to: string;
  label?: string;
}

export interface ChatReply {
  conversationId: string;
  message: AiMessage;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  pendingAction: PendingAction | null;
  uiActions?: UiAction[];
}

/** Progress events of a streamed turn, in the order the server emits them. */
export type StreamEvent =
  | { type: 'open'; requestId: string }
  | { type: 'turn'; conversationId: string }
  | { type: 'toolsets'; active: string[] }
  | { type: 'step'; status: 'start' | 'done' | 'error'; tool: string; summary: string; action: boolean }
  | { type: 'message'; data: ChatReply };

/**
 * One chat turn over server-sent events: progress while the reply is prepared,
 * then the same result the JSON route returns. Falls back to the JSON reply when
 * the server does not stream, and refreshes the session once on 401.
 */
export async function chatStream(body: ChatBody, opts: { onEvent?: (e: StreamEvent) => void; signal?: AbortSignal } = {}, retry = true): Promise<ChatReply> {
  const token = useAuthStore.getState().accessToken;
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    credentials: 'include',
    signal: opts.signal,
  });
  if (res.status === 401 && retry) {
    if (await tryRefresh()) return chatStream(body, opts, false);
    useAuthStore.getState().clear();
    throw new ApiError(401, 'Session expired');
  }
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('text/event-stream') || !res.body) {
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, data?.message ?? res.statusText, data?.error, data?.details);
    return data as ChatReply;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ChatReply | null = null;
  let failure: ApiError | null = null;
  const handle = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data.join('\n')) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event === 'message') {
      result = payload as unknown as ChatReply;
      opts.onEvent?.({ type: 'message', data: result });
    } else if (event === 'error') {
      const e = payload as { statusCode?: number; error?: string; message?: string; details?: unknown };
      failure = new ApiError(e.statusCode ?? 500, e.message ?? 'The assistant failed', e.error, e.details);
    } else {
      opts.onEvent?.({ ...payload, type: event } as StreamEvent);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (block.trim() && !block.startsWith(':')) handle(block);
    }
  }
  if (buffer.trim()) handle(buffer);
  if (failure) throw failure;
  if (!result) throw new ApiError(502, 'The assistant closed the connection without a reply', 'ai_stream');
  return result;
}

export type Tone = 'neutral' | 'formal' | 'friendly' | 'apologetic';

interface Base {
  suggestionId: string;
  aiGenerated: boolean;
}
export interface SummaryResult extends Base {
  summary: string;
  keyFacts: string[];
  nextSteps: string[];
}
export interface ClassificationResult extends Base {
  categoryKey: string | null;
  subcategoryKey: string | null;
  impactKey: string | null;
  urgencyKey: string | null;
  priorityKey: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  impactId: string | null;
  urgencyId: string | null;
  priorityId: string | null;
  confidence: number;
  rationale: string;
  labels: Record<'category' | 'subcategory' | 'impact' | 'urgency' | 'priority', string | null>;
  current?: { categoryId: string | null; subcategoryId: string | null; impactId: string | null; urgencyId: string | null; priorityId: string | null };
}
export type DraftClassification = Omit<ClassificationResult, 'suggestionId'>;
export interface AssignmentResult extends Base {
  teamKey: string | null;
  teamId: string | null;
  teamName: string | null;
  userId: string | null;
  userName: string | null;
  rationale: string;
  source: string;
  alternatives: { userId: string; name: string; resolvedSimilar: number; resolvedForCustomer: number; openLoad: number }[];
  current: { teamId: string | null; assigneeId: string | null };
}
export interface ResolutionResult extends Base {
  suggestions: { source: 'ticket' | 'kb'; ref: string; title: string; steps: string[]; link?: string | null }[];
  sources: { resolvedTickets: number; articles: number };
}
export interface DraftResult extends Base {
  draft: string;
  tone: Tone;
}
export interface DuplicateResult extends Base {
  items: { id: string; number: string; title: string; type: string; status: string; createdAt: string; score: number; reasons: string[]; link: string }[];
  likely: string[];
}
export interface SimilarResult extends Base {
  items: { id: string; number: string; title: string; status: { label: string; color: string | null } | null; sameCustomer: boolean; customerName: string | null; resolutionNotes: string | null; link: string; reason: string }[];
  rationale: string;
}
export interface ChangeImpactResult extends Base {
  change: { number: string; title: string; scheduledStart: string | null; scheduledEnd: string | null; downtimeExpectedMinutes: number | null };
  affectedCis: { id: string; name: string; type: string | null; criticality: string | null; dependents: number; businessServices: string[]; openTickets: number }[];
  downstream: { name: string; type: string; criticality: string; via: string; from: string }[];
  businessServices: string[];
  openTickets: { number: string; title: string; status: string; link: string }[];
  otherChanges: { id: string; number: string; title: string; scheduledStart: string | null; scheduledEnd: string | null; status: string | null; link: string }[];
  /** Scheduling conflicts of the window (shared systems, the same business service, blackouts) and the questionnaire's verdict. */
  conflicts?: { kind: 'ci' | 'service' | 'blackout'; text: string; ticket: { id: string; number: string; link: string } | null }[];
  questionnaire?: { level: 'low' | 'medium' | 'high'; score: number | null } | null;
  riskSummary: string;
  riskLevel: 'low' | 'medium' | 'high';
  recommendations: string[];
}
export interface ProblemCluster {
  key: string;
  customerId: string;
  customerName: string;
  categoryLabel: string | null;
  ciName: string | null;
  serviceName: string | null;
  count: number;
  openCount: number;
  firstAt: string;
  lastAt: string;
  commonTerms: string[];
  suggestedTitle: string;
  sampleTickets: { id: string; number: string; title: string; status: string; createdAt: string; link: string }[];
}
export interface ProblemClustersResult {
  days: number;
  minCount: number;
  aiGenerated: boolean;
  totalIncidents: number;
  clusters: ProblemCluster[];
}

export const aiQk = {
  status: ['ai', 'status'] as const,
  conversations: ['ai', 'conversations'] as const,
  conversation: (id: string) => ['ai', 'conversation', id] as const,
  clusters: (params: Record<string, unknown>) => ['ai', 'problem-clusters', params] as const,
  suggestions: (ticketId: string) => ['ai', 'suggestions', ticketId] as const,
};

export interface KnowledgeSuggestion {
  id: string;
  number: string;
  title: string;
  summary: string | null;
  articleType?: string | null;
  link: string;
  reason: string;
}
export interface KnowledgeResult extends Base {
  items: KnowledgeSuggestion[];
  rationale: string;
}
export interface ResolutionNotesResult extends Base {
  notes: string;
}
export interface KnownErrorWordingResult extends Base {
  summary: string;
  workaround: string;
}
/** A stored suggestion row (what triage on arrival or the Assist rail produced). */
export interface StoredSuggestion {
  id: string;
  kind: string;
  status: 'proposed' | 'accepted' | 'rejected' | 'applied';
  confidence: number | null;
  rationale: string | null;
  payload: Record<string, unknown>;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export const aiApi = {
  status: () => get<AiStatus>('/ai/status'),
  test: () => post<AiTestResult>('/ai/test'),
  conversations: () => get<{ items: Conversation[] }>('/ai/conversations'),
  conversation: (id: string) => get<{ id: string; title: string | null; messages: AiMessage[]; pendingAction: PendingAction | null }>(`/ai/conversations/${id}`),
  deleteConversation: (id: string) => del(`/ai/conversations/${id}`),
  chat: (body: ChatBody) => post<ChatReply>('/ai/chat', body),
  chatStream,
  feedback: (messageId: string, rating: 'up' | 'down' | null, note?: string | null) => post<{ id: string; feedback: 'up' | 'down' | null }>(`/ai/messages/${messageId}/feedback`, { rating, note: note ?? null }),
  summarize: (id: string) => post<SummaryResult>(`/ai/tickets/${id}/summarize`),
  classify: (id: string) => post<ClassificationResult>(`/ai/tickets/${id}/classify`),
  classifyDraft: (body: { title: string; description?: string | null; customerId?: string; type?: string }) => post<DraftClassification>('/ai/classify-draft', body),
  recommendAssignment: (id: string) => post<AssignmentResult>(`/ai/tickets/${id}/recommend-assignment`),
  similar: (id: string) => post<SimilarResult>(`/ai/tickets/${id}/similar`),
  resolutionSuggestions: (id: string) => post<ResolutionResult>(`/ai/tickets/${id}/resolution-suggestions`),
  draftCustomerUpdate: (id: string, tone: Tone) => post<DraftResult>(`/ai/tickets/${id}/draft-customer-update`, { tone }),
  draftMajorUpdate: (id: string, audience: 'customer' | 'internal') => post<{ suggestionId: string; aiGenerated: boolean; draft: string; audience: 'customer' | 'internal' }>(`/ai/tickets/${id}/major/draft-update`, { audience }),
  duplicateCheck: (id: string) => post<DuplicateResult>(`/ai/tickets/${id}/duplicate-check`),
  changeImpact: (id: string) => post<ChangeImpactResult>(`/ai/changes/${id}/impact`),
  problemClusters: (params: { days?: number; customerId?: string; minCount?: number }) => get<ProblemClustersResult>('/ai/problem-clusters', params),
  decide: (id: string, status: 'accepted' | 'rejected', note?: string | null, opts?: { apply?: boolean; targetTicketId?: string | null }) => post<{ id: string; status: string; changes?: string[] }>(`/ai/suggestions/${id}/decide`, { status, note: note ?? undefined, ...(opts ?? {}) }),
  suggestKnowledge: (id: string) => post<KnowledgeResult>(`/ai/tickets/${id}/suggest-knowledge`),
  draftResolution: (id: string) => post<ResolutionNotesResult>(`/ai/tickets/${id}/draft-resolution`),
  /** Customer-facing wording of a known error (feature kedb_draft; deterministic fallback without a provider). */
  draftKnownError: (id: string) => post<KnownErrorWordingResult>(`/ai/known-errors/${id}/draft`),
  listSuggestions: (id: string, kind?: string) => get<{ items: StoredSuggestion[] }>(`/ai/tickets/${id}/suggestions`, kind ? { kind } : undefined),
};
