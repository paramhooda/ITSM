import { get, post, patch, del } from '@/api/client';
import type { Paginated } from '@/components/tickets/api';

/** API shapes of the customer satisfaction module (apps/api/src/modules/surveys). */

export type SurveyStatus = 'pending' | 'answered' | 'expired' | 'cancelled';
export type SurveyChannel = 'email' | 'portal' | 'assistant';
export type SurveyTrigger = 'resolved' | 'closed' | 'manual';
export type SurveySendOn = 'resolved' | 'closed';
export type PolicySource = 'contract' | 'customer' | 'default';

export const RATING_LABELS: Record<number, string> = { 1: 'Very dissatisfied', 2: 'Dissatisfied', 3: 'Neutral', 4: 'Satisfied', 5: 'Very satisfied' };
export const CHANNEL_LABELS: Record<string, string> = { email: 'Email link', portal: 'Portal', assistant: 'Assistant' };
export const SURVEY_STATUS_LABELS: Record<string, string> = { pending: 'Awaiting reply', answered: 'Answered', expired: 'Expired', cancelled: 'Withdrawn', none: 'No survey' };
export const SKIP_REASON_LABELS: Record<string, string> = { disabled: 'surveys are off for this customer', type: 'this ticket type is not surveyed', sampling: 'sampling', fatigue: 'the requester was surveyed recently', no_recipient: 'no customer recipient', answered: 'already rated', not_ended: 'the ticket is still open' };
export const SEND_ON_LABELS: Record<string, string> = { resolved: 'On resolution', closed: 'On closure' };

/** The survey of one ticket as the record pages see it; staff get the recipient and the send history. */
export interface TicketSurvey {
  id: string;
  ticketId: string;
  status: SurveyStatus;
  question: string;
  commentPrompt: string | null;
  rating: number | null;
  comment: string | null;
  answeredAt: string | null;
  answeredBy: { name: string } | null;
  channel: SurveyChannel | null;
  requestedAt: string;
  expiresAt: string;
  trigger: SurveyTrigger;
  sendCount: number;
  canAnswer: boolean;
  recipientName?: string | null;
  recipientEmail?: string | null;
  recipientUserId?: string | null;
  remindedAt?: string | null;
  resentAt?: string | null;
  lowRatingAlertedAt?: string | null;
}
/** No survey row: staff learn why none was sent and which policy applied. */
export interface NoSurvey {
  status: 'none';
  reason: string | null;
  policy: { enabled: boolean; sendOn: SurveySendOn; source: PolicySource } | null;
}
export type SurveyEmbed = TicketSurvey | NoSurvey;
/** The portal's view of a ticket without a survey row: just the question to ask. */
export type PortalSurvey = TicketSurvey | { status: 'none'; question: string; commentPrompt: string | null };

export interface CsatFigures {
  sent: number;
  responses: number;
  avg: number | null;
  satisfiedPct: number | null;
  low: number;
  responseRate: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  series: { week: string; responses: number; avg: number | null }[];
}
export interface CsatGroup {
  key: string;
  label: string;
  sent: number;
  responses: number;
  avg: number | null;
  satisfiedPct: number | null;
  low: number;
}
export interface CsatLowest {
  id: string;
  ticketId: string;
  number: string;
  title: string;
  customerId: string;
  customerName: string | null;
  rating: number;
  comment: string | null;
  channel: string | null;
  answeredAt: string;
  assigneeName?: string | null;
}
export type CsatGroupBy = 'customer' | 'engineer' | 'team' | 'service' | 'priority' | 'channel' | 'month';
export interface CsatSummary {
  period: { from: string; to: string; days: number };
  groupBy: CsatGroupBy;
  thresholds: { satisfied: number; low: number };
  figures: CsatFigures;
  groups: CsatGroup[];
  lowest: CsatLowest[];
}

export interface SurveyResponse {
  id: string;
  ticketId: string;
  number: string;
  title: string;
  customerId: string;
  customerName: string | null;
  rating: number | null;
  comment: string | null;
  channel: SurveyChannel | null;
  status: SurveyStatus;
  trigger: SurveyTrigger;
  requestedAt: string;
  answeredAt: string | null;
  respondentName: string | null;
  serviceName: string | null;
  assigneeName?: string | null;
  teamName?: string | null;
  recipientEmail?: string | null;
}

/** A policy override for one customer (contractId null) or one contract; null fields inherit. */
export interface SurveyConfig {
  id: string;
  customerId: string;
  contractId: string | null;
  enabled: boolean | null;
  sendOn: SurveySendOn | null;
  resendOnClose: boolean | null;
  samplingPct: number | null;
  question: string | null;
  commentPrompt: string | null;
  reminderDays: number | null;
  expiryDays: number | null;
  fatigueDays: number | null;
  lowRatingThreshold: number | null;
  ticketTypes: string[] | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  customerName: string;
  contractNumber: string | null;
  contractName: string | null;
}
export type SurveyConfigInput = Partial<Omit<SurveyConfig, 'id' | 'createdAt' | 'updatedAt' | 'customerName' | 'contractNumber' | 'contractName'>> & { customerId: string };

export interface SurveyPolicyView {
  enabled: boolean;
  sendOn: SurveySendOn;
  resendOnClose: boolean;
  samplingPct: number;
  question: string;
  commentPrompt: string;
  reminderDays: number;
  expiryDays: number;
  fatigueDays: number;
  lowRatingThreshold: number;
  satisfiedThreshold: number;
  ticketTypes: string[];
  source: PolicySource;
  scope: { customerId: string | null; contractId: string | null };
}

export interface PendingSurvey {
  ticketId: string;
  number: string;
  title: string;
  requestedAt: string;
  expiresAt: string;
}

/** The public page behind the email link: the respondent's own ticket and nothing else. */
export interface PublicSurvey {
  status: 'pending' | 'answered' | 'expired' | 'cancelled';
  question: string;
  commentPrompt: string | null;
  ticket: { number: string; title: string };
  rating: number | null;
  hasComment: boolean;
  answeredAt: string | null;
  expiresAt: string;
  hasPortal: boolean;
  portalLink: string | null;
}
/** `retry` is a transient failure (rate limit, server error, no network): the survey is still open and the page says so without changing the card. */
export type PublicOutcome = { ok: true; status: 'answered'; rating: number | null; hasComment: boolean } | { ok: false; error: 'gone' | 'conflict' | 'not_found' | 'retry'; message: string };

export const surveyKeys = {
  summary: (p: Record<string, unknown>) => ['surveys', 'summary', p] as const,
  responses: (p: Record<string, unknown>) => ['surveys', 'responses', p] as const,
  configs: ['surveys', 'configs'] as const,
  policy: (p: Record<string, unknown>) => ['surveys', 'policy', p] as const,
  ticket: (id: string) => ['surveys', 'ticket', id] as const,
  portalPending: ['portal', 'surveys', 'pending'] as const,
};

export const surveysApi = {
  summary: (p: Record<string, unknown>) => get<CsatSummary>('/surveys/summary', p),
  responses: (p: Record<string, unknown>) => get<Paginated<SurveyResponse>>('/surveys/responses', p),
  policy: (p?: Record<string, unknown>) => get<SurveyPolicyView>('/surveys/policy', p),
  configs: () => get<{ items: SurveyConfig[] }>('/surveys/configs'),
  createConfig: (body: SurveyConfigInput) => post<SurveyConfig>('/surveys/configs', body),
  updateConfig: (id: string, body: Partial<SurveyConfigInput>) => patch<SurveyConfig>(`/surveys/configs/${id}`, body),
  deleteConfig: (id: string) => del(`/surveys/configs/${id}`),
  ticket: (id: string) => get<SurveyEmbed>(`/surveys/tickets/${id}`),
  send: (id: string) => post<TicketSurvey>(`/surveys/tickets/${id}/send`),
  // portal
  answer: (ticketId: string, body: { rating: number; comment?: string | null }) => post<TicketSurvey>(`/portal/tickets/${ticketId}/survey`, body),
  pending: () => get<{ count: number; items: PendingSurvey[] }>('/portal/surveys'),
};

/** The public page needs no session: a plain fetch against the API, the token is the only credential. */
export async function fetchPublicSurvey(token: string): Promise<PublicSurvey | null> {
  const res = await fetch(`/api/public/surveys/${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Survey unavailable (${res.status})`);
  return (await res.json()) as PublicSurvey;
}

const RETRY_MESSAGE = 'Your answer could not be saved just now. Please try again in a moment.';
async function publicPost(path: string, body: Record<string, unknown>): Promise<PublicOutcome> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  } catch {
    return { ok: false, error: 'retry', message: RETRY_MESSAGE };
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) return { ok: true, status: 'answered', rating: (json?.rating as number | null) ?? null, hasComment: !!json?.hasComment };
  if (res.status === 410) return { ok: false, error: 'gone', message: String(json?.message ?? 'This survey has closed.') };
  if (res.status === 409) return { ok: false, error: 'conflict', message: String(json?.message ?? 'This ticket has already been rated.') };
  if (res.status === 404) return { ok: false, error: 'not_found', message: String(json?.message ?? 'This survey link is not valid.') };
  return { ok: false, error: 'retry', message: res.status === 429 ? 'Too many attempts from this connection. Please wait a minute and try again.' : RETRY_MESSAGE };
}
export const submitPublicRating = (token: string, rating: number) => publicPost(`/api/public/surveys/${encodeURIComponent(token)}/rating`, { rating });
export const submitPublicComment = (token: string, comment: string) => publicPost(`/api/public/surveys/${encodeURIComponent(token)}/comment`, { comment });

/** Average rating → tile tone: 4 and above is good, 3.5 is a warning, below that is bad. */
export const ratingTone = (avg: number | null | undefined): 'default' | 'good' | 'warn' | 'bad' => (avg == null ? 'default' : avg >= 4 ? 'good' : avg >= 3.5 ? 'warn' : 'bad');
export const fmtRating = (avg: number | null | undefined) => (avg == null ? '—' : `${avg.toFixed(1)}/5`);
