import { get, post, patch, del } from '@/api/client';

/** API shapes of the change management module (apps/api/src/modules/changes). */

export type ChangeType = 'standard' | 'normal' | 'emergency';
export type RiskLevel = 'low' | 'medium' | 'high';
export type CabDecision = 'pending' | 'approved' | 'rejected' | 'deferred';
export type CabStatus = 'scheduled' | 'in_progress' | 'closed' | 'cancelled';
export type ConflictKind = 'ci' | 'service' | 'blackout';

export interface Conflict {
  kind: ConflictKind;
  text: string;
  ticket?: { id: string; number: string; title: string; customerName: string | null; start: string; end: string } | null;
  shared?: string[];
  blackout?: { id: string; name: string; reason: string | null; start: string; end: string } | null;
}

export interface CalendarChange {
  ticketId: string;
  number: string;
  title: string;
  customerId: string;
  customerName: string | null;
  changeType: ChangeType | string;
  status: { key: string | null; label: string | null; color: string | null; category: string | null };
  approvalStatus: string | null;
  riskLevel: RiskLevel | null;
  riskScore: number | null;
  riskLabel: string | null;
  scheduledStart: string;
  scheduledEnd: string | null;
  downtimeExpectedMinutes: number | null;
  assigneeName: string | null;
  primaryCiId: string | null;
  cabMeetingId: string | null;
  conflicts: Conflict[];
}
export interface Blackout {
  id: string;
  customerId: string | null;
  customerName?: string | null;
  name: string;
  reason: string | null;
  startsAt: string;
  endsAt: string;
  allowEmergency: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface Calendar {
  from: string;
  to: string;
  items: CalendarChange[];
  blackouts: Blackout[];
  counts: { changes: number; conflicts: number; blackouts: number };
}

export interface RiskOption {
  key: string;
  label: string;
  score: number;
}
export interface RiskQuestion {
  id: string;
  key: string;
  question: string;
  hint: string | null;
  weight: number;
  options: RiskOption[];
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface RiskThresholds {
  medium: number;
  high: number;
}
export interface RiskResult {
  score: number;
  level: RiskLevel;
  points: number;
  maxPoints: number;
  answered: number;
  missing: string[];
  drivers: { key: string; question: string; option: string; points: number }[];
  thresholds: RiskThresholds;
  riskId: string | null;
}

export interface ChangeTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  changeType: ChangeType | string;
  categoryId: string | null;
  categoryLabel: string | null;
  serviceId: string | null;
  serviceName: string | null;
  riskId: string | null;
  riskLabel: string | null;
  titleTemplate: string | null;
  descriptionTemplate: string | null;
  justification: string | null;
  implementationPlan: string | null;
  testPlan: string | null;
  backoutPlan: string | null;
  communicationPlan: string | null;
  downtimeExpectedMinutes: number | null;
  skipApproval: boolean;
  customerIds: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CabMeeting {
  id: string;
  title: string;
  scheduledAt: string;
  chairUserId: string | null;
  chairName: string | null;
  status: CabStatus;
  minutes: string | null;
  closedAt: string | null;
  items: number;
  pending: number;
  createdAt: string;
  updatedAt: string;
}
export interface CabItem {
  id: string;
  ticketId: string;
  number: string;
  title: string;
  customerId: string;
  customerName: string | null;
  changeType: string;
  riskLevel: RiskLevel | null;
  riskScore: number | null;
  riskLabel: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  status: { label: string | null; color: string | null; category: string | null };
  approvalStatus: string | null;
  assigneeName: string | null;
  decision: CabDecision;
  notes: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  sortOrder: number;
  pendingApproval: { id: string; stepName: string | null; step: number } | null;
}
export interface CabMeetingDetail extends Omit<CabMeeting, 'items'> {
  items: CabItem[];
  canDecide: boolean;
}
/** The decide call also says whether the ticket's approval step was decided with it. */
export type CabDecideResult = CabMeetingDetail & { approval: { applied: boolean; note: string | null } };

export const changeKeys = {
  all: ['changes'] as const,
  calendar: (params: Record<string, unknown>) => ['changes', 'calendar', params] as const,
  conflicts: (ticketId: string) => ['changes', 'conflicts', ticketId] as const,
  questionnaire: ['changes', 'questionnaire'] as const,
  questions: ['changes', 'questions'] as const,
  blackouts: (params: Record<string, unknown> = {}) => ['changes', 'blackouts', params] as const,
  templates: (params: Record<string, unknown> = {}) => ['changes', 'templates', params] as const,
  meetings: (params: Record<string, unknown>) => ['cab', 'meetings', params] as const,
  meeting: (id: string) => ['cab', 'meeting', id] as const,
};

export const changesApi = {
  calendar: (params: { from: string; to: string; customerId?: string }) => get<Calendar>('/changes/calendar', params),
  previewConflicts: (body: { ticketId?: string; customerId: string; scheduledStart: string; scheduledEnd?: string; changeType?: string; ciIds?: string[]; primaryCiId?: string | null }) => post<{ window: { start: string; end: string }; conflicts: Conflict[] }>('/changes/conflicts', body),
  conflicts: (ticketId: string) => get<{ window: { start: string; end: string } | null; conflicts: Conflict[] }>(`/changes/${ticketId}/conflicts`),
  questionnaire: () => get<{ questions: RiskQuestion[]; thresholds: RiskThresholds }>('/changes/risk-questionnaire'),
  assessRisk: (ticketId: string, answers: Record<string, string>) => post<RiskResult>(`/changes/${ticketId}/assess-risk`, { answers }),
  blackouts: (params: Record<string, unknown> = {}) => get<{ items: Blackout[] }>('/changes/blackouts', params),
  createBlackout: (body: Record<string, unknown>) => post<Blackout>('/changes/blackouts', body),
  updateBlackout: (id: string, body: Record<string, unknown>) => patch<Blackout>(`/changes/blackouts/${id}`, body),
  deleteBlackout: (id: string) => del(`/changes/blackouts/${id}`),
  questions: (all = true) => get<{ items: RiskQuestion[] }>('/changes/risk-questions', { all }),
  createQuestion: (body: Record<string, unknown>) => post<RiskQuestion>('/changes/risk-questions', body),
  updateQuestion: (id: string, body: Record<string, unknown>) => patch<RiskQuestion>(`/changes/risk-questions/${id}`, body),
  deleteQuestion: (id: string) => del(`/changes/risk-questions/${id}`),
  templates: (params: { customerId?: string; all?: boolean } = {}) => get<{ items: ChangeTemplate[] }>('/changes/templates', params),
  createTemplate: (body: Record<string, unknown>) => post<ChangeTemplate>('/changes/templates', body),
  updateTemplate: (id: string, body: Record<string, unknown>) => patch<ChangeTemplate>(`/changes/templates/${id}`, body),
  deleteTemplate: (id: string) => del(`/changes/templates/${id}`),
  meetings: (params: Record<string, unknown>) => get<{ items: CabMeeting[]; total: number; page: number; pageSize: number }>('/cab/meetings', params),
  meeting: (id: string) => get<CabMeetingDetail>(`/cab/meetings/${id}`),
  createMeeting: (body: { title: string; scheduledAt: string; chairUserId?: string | null; ticketIds?: string[] }) => post<CabMeetingDetail>('/cab/meetings', body),
  updateMeeting: (id: string, body: Record<string, unknown>) => patch<CabMeetingDetail>(`/cab/meetings/${id}`, body),
  addItem: (id: string, body: { ticketId: string; notes?: string | null }) => post<CabMeetingDetail>(`/cab/meetings/${id}/items`, body),
  removeItem: (id: string, itemId: string) => del<CabMeetingDetail>(`/cab/meetings/${id}/items/${itemId}`),
  decideItem: (id: string, itemId: string, body: { decision: 'approved' | 'rejected' | 'deferred'; notes?: string | null; applyToApproval?: boolean }) => post<CabDecideResult>(`/cab/meetings/${id}/items/${itemId}/decide`, body),
  closeMeeting: (id: string, minutes: string | null) => post<CabMeetingDetail>(`/cab/meetings/${id}/close`, { minutes }),
};
