import { get, post, del } from '@/api/client';

/** Shapes of the AI module (kept in sync with apps/api/src/modules/ai). */
export interface AiStatus {
  enabled: boolean;
  provider: string;
  model: string | null;
  features: string[];
  canAct: boolean;
  tools: { name: string; action: boolean }[];
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
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallRecord[];
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  updatedAt: string;
  createdAt: string;
  messageCount: number;
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
};

export const aiApi = {
  status: () => get<AiStatus>('/ai/status'),
  test: () => post<AiTestResult>('/ai/test'),
  conversations: () => get<{ items: Conversation[] }>('/ai/conversations'),
  conversation: (id: string) => get<{ id: string; title: string | null; messages: AiMessage[] }>(`/ai/conversations/${id}`),
  deleteConversation: (id: string) => del(`/ai/conversations/${id}`),
  chat: (body: { conversationId?: string | null; message: string; context?: Record<string, unknown> | null }) => post<{ conversationId: string; message: AiMessage }>('/ai/chat', body),
  summarize: (id: string) => post<SummaryResult>(`/ai/tickets/${id}/summarize`),
  classify: (id: string) => post<ClassificationResult>(`/ai/tickets/${id}/classify`),
  classifyDraft: (body: { title: string; description?: string | null; customerId?: string; type?: string }) => post<DraftClassification>('/ai/classify-draft', body),
  recommendAssignment: (id: string) => post<AssignmentResult>(`/ai/tickets/${id}/recommend-assignment`),
  similar: (id: string) => post<SimilarResult>(`/ai/tickets/${id}/similar`),
  resolutionSuggestions: (id: string) => post<ResolutionResult>(`/ai/tickets/${id}/resolution-suggestions`),
  draftCustomerUpdate: (id: string, tone: Tone) => post<DraftResult>(`/ai/tickets/${id}/draft-customer-update`, { tone }),
  duplicateCheck: (id: string) => post<DuplicateResult>(`/ai/tickets/${id}/duplicate-check`),
  changeImpact: (id: string) => post<ChangeImpactResult>(`/ai/changes/${id}/impact`),
  problemClusters: (params: { days?: number; customerId?: string; minCount?: number }) => get<ProblemClustersResult>('/ai/problem-clusters', params),
  decide: (id: string, status: 'accepted' | 'rejected', note?: string) => post<{ id: string; status: string }>(`/ai/suggestions/${id}/decide`, { status, note }),
};
