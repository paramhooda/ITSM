import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { TICKET_TYPES, type TicketType, type SurveySendOn } from '@itsm/shared';
import { schema, type Tx } from '@/db/client';
import { sha256 } from '@/lib/crypto';

/**
 * The survey policy: the global `surveys.*` settings, overridden per customer
 * and per contract by `survey_configs` rows (a non-null column wins, contract
 * over customer over defaults). Pure data helpers with no permission checks:
 * the status hook, the portal, the job and the aggregates all read it.
 */
export interface SurveyPolicy {
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
  ticketTypes: TicketType[];
}

export type PolicySource = 'contract' | 'customer' | 'default';
export type EffectivePolicy = SurveyPolicy & { source: PolicySource };

export const DEFAULT_POLICY: SurveyPolicy = {
  enabled: true,
  sendOn: 'resolved',
  resendOnClose: true,
  samplingPct: 100,
  question: 'How satisfied are you with how we handled this ticket?',
  commentPrompt: 'Anything we could have done better?',
  reminderDays: 3,
  expiryDays: 14,
  fatigueDays: 7,
  lowRatingThreshold: 2,
  satisfiedThreshold: 4,
  ticketTypes: ['incident', 'request'],
};

const KEYS = ['surveys.enabled', 'surveys.send_on', 'surveys.resend_on_close', 'surveys.sampling_pct', 'surveys.question', 'surveys.comment_prompt', 'surveys.reminder_days', 'surveys.expiry_days', 'surveys.fatigue_days', 'surveys.low_rating_threshold', 'surveys.satisfied_threshold', 'surveys.ticket_types'];

const clampNum = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const str = (v: unknown, fallback: string, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback);
const types = (v: unknown, fallback: TicketType[]): TicketType[] => {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((t): t is TicketType => (TICKET_TYPES as readonly string[]).includes(String(t)));
  return out.length ? out : fallback;
};
const sendOn = (v: unknown, fallback: SurveySendOn): SurveySendOn => (v === 'closed' || v === 'resolved' ? v : fallback);

/** The twelve `surveys.*` settings, clamped, with the shipped defaults for anything missing. */
export async function loadSurveyDefaults(tx: Tx): Promise<SurveyPolicy> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, KEYS));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const d = DEFAULT_POLICY;
  return {
    enabled: bool(get('surveys.enabled'), d.enabled),
    sendOn: sendOn(get('surveys.send_on'), d.sendOn),
    resendOnClose: bool(get('surveys.resend_on_close'), d.resendOnClose),
    samplingPct: clampNum(get('surveys.sampling_pct'), d.samplingPct, 0, 100),
    question: str(get('surveys.question'), d.question, 300),
    commentPrompt: str(get('surveys.comment_prompt'), d.commentPrompt, 300),
    reminderDays: clampNum(get('surveys.reminder_days'), d.reminderDays, 0, 60),
    expiryDays: clampNum(get('surveys.expiry_days'), d.expiryDays, 1, 90),
    fatigueDays: clampNum(get('surveys.fatigue_days'), d.fatigueDays, 0, 365),
    lowRatingThreshold: clampNum(get('surveys.low_rating_threshold'), d.lowRatingThreshold, 1, 4),
    satisfiedThreshold: clampNum(get('surveys.satisfied_threshold'), d.satisfiedThreshold, 2, 5),
    ticketTypes: types(get('surveys.ticket_types'), d.ticketTypes),
  };
}

type ConfigRow = typeof schema.surveyConfigs.$inferSelect;

/** Lays a config row over a policy: every non-null column wins. */
export function applyConfig(base: SurveyPolicy, row: ConfigRow | null | undefined): SurveyPolicy {
  if (!row) return base;
  return {
    enabled: row.enabled ?? base.enabled,
    sendOn: sendOn(row.sendOn, base.sendOn),
    resendOnClose: row.resendOnClose ?? base.resendOnClose,
    samplingPct: row.samplingPct === null ? base.samplingPct : clampNum(row.samplingPct, base.samplingPct, 0, 100),
    question: row.question?.trim() ? row.question.trim() : base.question,
    commentPrompt: row.commentPrompt === null ? base.commentPrompt : row.commentPrompt.trim(),
    reminderDays: row.reminderDays === null ? base.reminderDays : clampNum(row.reminderDays, base.reminderDays, 0, 60),
    expiryDays: row.expiryDays === null ? base.expiryDays : clampNum(row.expiryDays, base.expiryDays, 1, 90),
    fatigueDays: row.fatigueDays === null ? base.fatigueDays : clampNum(row.fatigueDays, base.fatigueDays, 0, 365),
    lowRatingThreshold: row.lowRatingThreshold === null ? base.lowRatingThreshold : clampNum(row.lowRatingThreshold, base.lowRatingThreshold, 1, 4),
    satisfiedThreshold: base.satisfiedThreshold,
    ticketTypes: row.ticketTypes?.length ? types(row.ticketTypes, base.ticketTypes) : base.ticketTypes,
  };
}

/** The policy that applies to a ticket: the contract row over the customer row over the settings. */
export async function effectivePolicy(tx: Tx, scope: { customerId: string; contractId?: string | null }): Promise<EffectivePolicy> {
  const defaults = await loadSurveyDefaults(tx);
  const rows = await tx
    .select()
    .from(schema.surveyConfigs)
    .where(and(eq(schema.surveyConfigs.customerId, scope.customerId), scope.contractId ? or(isNull(schema.surveyConfigs.contractId), eq(schema.surveyConfigs.contractId, scope.contractId)) : isNull(schema.surveyConfigs.contractId)));
  const customerRow = rows.find((r) => r.contractId === null) ?? null;
  const contractRow = scope.contractId ? rows.find((r) => r.contractId === scope.contractId) ?? null : null;
  const merged = applyConfig(applyConfig(defaults, customerRow), contractRow);
  return { ...merged, source: contractRow ? 'contract' : customerRow ? 'customer' : 'default' };
}

/** Deterministic sampling: a ticket is either always or never sampled at a given percentage. */
export const isSampled = (ticketId: string, pct: number): boolean => {
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  return parseInt(sha256(ticketId).slice(0, 8), 16) % 100 < pct;
};

/**
 * Whether a customer may rate an ended ticket that has no survey row: the policy must allow surveys for the customer
 * and the ticket type, and the ticket must have ended within the expiry window. Sampling and fatigue do not apply (a
 * voluntary rating is never fatigue). The portal read (`actions.rate`) and the portal write share this rule.
 */
export function voluntaryRatingOpen(policy: Pick<SurveyPolicy, 'enabled' | 'ticketTypes' | 'expiryDays'>, ticket: { type: TicketType; resolvedAt: Date | null; closedAt: Date | null }, now = Date.now()): boolean {
  if (!policy.enabled || !policy.ticketTypes.includes(ticket.type)) return false;
  const ref = ticket.closedAt ?? ticket.resolvedAt;
  return !!ref && now - ref.getTime() <= policy.expiryDays * 86_400_000;
}

export const satisfiedThresholdOf = (p: Pick<SurveyPolicy, 'satisfiedThreshold'>) => p.satisfiedThreshold;
export const lowThresholdOf = (p: Pick<SurveyPolicy, 'lowRatingThreshold'>) => p.lowRatingThreshold;
