import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { SurveyChannel } from '@itsm/shared';
import { schema, withSystem, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { limitOffset } from '@/core/query';
import { config } from '@/config';
import { logger } from '@/core/logger';
import { sha256, randomToken, encryptSecret, decryptSecret } from '@/lib/crypto';
import { addActivity, isCustomerUser, loadTicket, optionById, reloadTicket, requireRead, systemCtx, userIdOf, type TicketRow } from '@/modules/tickets/common';
import { resolveRecipients, notifyTicketEvent } from '@/modules/tickets/notify';
import { queueNotification, type Recipient } from '@/modules/notifications/dispatch';
import { effectivePolicy, isSampled, loadSurveyDefaults, type EffectivePolicy, type SurveyPolicy } from './policy';
import { csatFigures, csatGroups, csatLowest, hidesSoc, type CsatFilter } from './figures';
import type { ConfigInput, ConfigPatch, GroupBy, ResponsesQuery, SummaryQuery } from './schemas';

/**
 * Customer satisfaction surveys. One `ticket_surveys` row per ticket: issued
 * when the ticket ends (the status hook), withdrawn when it is reopened,
 * answered once from the email link, the portal or the assistant. The email
 * token is random, stored hashed (lookup) and encrypted (reminder resend).
 *
 * Import discipline: this file reads `tickets/common`, `tickets/notify` and
 * `notifications/dispatch` only. `tickets/status`, `tickets/service` and
 * `portal/service` import it, so importing any of them here would close a
 * cycle; the two portal functions live in `./portal` for that reason.
 */

export type SurveyRow = typeof schema.ticketSurveys.$inferSelect;
export type SurveyTrigger = SurveyRow['trigger'];
export type SkipReason = 'disabled' | 'type' | 'sampling' | 'fatigue' | 'no_recipient' | 'answered' | 'not_ended';
type ConfigRow = typeof schema.surveyConfigs.$inferSelect;

const S = schema.ticketSurveys;
const T = schema.tickets;
const DAY = 86_400_000;
const RESEND_AFTER_MS = 24 * 3_600_000;
const appUrl = () => config.APP_URL.replace(/\/$/, '');
export const RATING_LABELS: Record<number, string> = { 1: 'Very dissatisfied', 2: 'Dissatisfied', 3: 'Neutral', 4: 'Satisfied', 5: 'Very satisfied' };
const RATING_COLORS: Record<number, string> = { 1: '#dc2626', 2: '#ea580c', 3: '#d97706', 4: '#16a34a', 5: '#15803d' };

/** The survey can no longer be answered (expired, withdrawn, or its ticket is open again): HTTP 410. `mark` says what state the row should be left in. */
export class SurveyClosedError extends AppError {
  constructor(public mark: 'expired' | 'cancelled' | null = null, message = 'This survey has closed') {
    super(410, message, 'gone');
  }
}

const ended = (cat: string | null | undefined) => cat === 'resolved' || cat === 'closed';

// ---------------------------------------------------------------- configuration

export interface ConfigView extends ConfigRow {
  customerName: string;
  contractNumber: string | null;
  contractName: string | null;
}

function requireConfigAccess(ctx: Ctx, customerId?: string | null) {
  if (!ctx.can('surveys:manage', customerId) && !ctx.can('admin:config', customerId)) throw new ForbiddenError('Missing permission: surveys:manage');
}

async function configRows(ctx: Ctx, where?: SQL): Promise<ConfigView[]> {
  const rows = await ctx.tx
    .select({ config: schema.surveyConfigs, customerName: schema.customers.name, contractNumber: schema.contracts.number, contractName: schema.contracts.name })
    .from(schema.surveyConfigs)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.surveyConfigs.customerId))
    .leftJoin(schema.contracts, eq(schema.contracts.id, schema.surveyConfigs.contractId))
    .where(where)
    .orderBy(asc(schema.customers.name), sql`${schema.contracts.number} NULLS FIRST`);
  return rows.map((r) => ({ ...r.config, customerName: r.customerName, contractNumber: r.contractNumber ?? null, contractName: r.contractName ?? null }));
}

export async function listConfigs(ctx: Ctx, q: { customerId?: string } = {}): Promise<{ items: ConfigView[] }> {
  requireConfigAccess(ctx, q.customerId);
  if (q.customerId) ctx.requireCustomer(q.customerId);
  return { items: await configRows(ctx, q.customerId ? eq(schema.surveyConfigs.customerId, q.customerId) : undefined) };
}

async function loadConfig(ctx: Ctx, id: string): Promise<ConfigView> {
  const [row] = await configRows(ctx, eq(schema.surveyConfigs.id, id));
  if (!row) throw new NotFoundError('Survey policy');
  ctx.requireCustomer(row.customerId);
  return row;
}

async function assertContract(ctx: Ctx, customerId: string, contractId: string | null | undefined) {
  if (!contractId) return;
  const [c] = await ctx.tx.select({ customerId: schema.contracts.customerId }).from(schema.contracts).where(eq(schema.contracts.id, contractId)).limit(1);
  if (!c) throw new NotFoundError('Contract');
  if (c.customerId !== customerId) throw new ValidationError('The contract belongs to another customer');
}

const scopeLabel = (c: Pick<ConfigView, 'customerName' | 'contractNumber'>) => (c.contractNumber ? `${c.customerName} · ${c.contractNumber}` : c.customerName);

export async function createConfig(ctx: Ctx, input: ConfigInput): Promise<ConfigView> {
  requireConfigAccess(ctx, input.customerId);
  ctx.requireCustomer(input.customerId);
  await assertContract(ctx, input.customerId, input.contractId);
  const contractId = input.contractId ?? null;
  const [dup] = await ctx.tx.select({ id: schema.surveyConfigs.id }).from(schema.surveyConfigs).where(and(eq(schema.surveyConfigs.customerId, input.customerId), contractId ? eq(schema.surveyConfigs.contractId, contractId) : isNull(schema.surveyConfigs.contractId))).limit(1);
  if (dup) throw new ConflictError('A survey policy already exists for this scope');
  const { customerId: _c, contractId: _k, ...fields } = input;
  const [row] = await ctx.tx.insert(schema.surveyConfigs).values({ ...fields, customerId: input.customerId, contractId, createdBy: userIdOf(ctx), updatedBy: userIdOf(ctx) }).returning({ id: schema.surveyConfigs.id });
  const view = await loadConfig(ctx, row!.id);
  await ctx.audit({ entityType: 'survey_config', entityId: view.id, entityLabel: scopeLabel(view), action: 'survey_config.create', customerId: view.customerId, metadata: { contractId } });
  return view;
}

export async function updateConfig(ctx: Ctx, id: string, patch: ConfigPatch): Promise<ConfigView> {
  const before = await loadConfig(ctx, id);
  requireConfigAccess(ctx, before.customerId);
  if (patch.contractId !== undefined) {
    await assertContract(ctx, before.customerId, patch.contractId);
    const contractId = patch.contractId ?? null;
    if (contractId !== before.contractId) {
      const [dup] = await ctx.tx.select({ id: schema.surveyConfigs.id }).from(schema.surveyConfigs).where(and(eq(schema.surveyConfigs.customerId, before.customerId), contractId ? eq(schema.surveyConfigs.contractId, contractId) : isNull(schema.surveyConfigs.contractId), ne(schema.surveyConfigs.id, id))).limit(1);
      if (dup) throw new ConflictError('A survey policy already exists for this scope');
    }
  }
  await ctx.tx.update(schema.surveyConfigs).set({ ...patch, updatedBy: userIdOf(ctx), updatedAt: new Date() }).where(eq(schema.surveyConfigs.id, id));
  const after = await loadConfig(ctx, id);
  const { customerName: _a, contractNumber: _b, contractName: _d, ...b } = before;
  const { customerName: _e, contractNumber: _f, contractName: _g, ...a } = after;
  await ctx.audit({ entityType: 'survey_config', entityId: id, entityLabel: scopeLabel(after), action: 'survey_config.update', customerId: after.customerId, changes: diffChanges(b as Record<string, unknown>, a as Record<string, unknown>, ['updatedAt', 'updatedBy']) });
  return after;
}

export async function deleteConfig(ctx: Ctx, id: string): Promise<{ ok: true }> {
  const row = await loadConfig(ctx, id);
  requireConfigAccess(ctx, row.customerId);
  await ctx.tx.delete(schema.surveyConfigs).where(eq(schema.surveyConfigs.id, id));
  await ctx.audit({ entityType: 'survey_config', entityId: id, entityLabel: scopeLabel(row), action: 'survey_config.delete', customerId: row.customerId });
  return { ok: true };
}

/** The effective policy for a scope (the admin Defaults card, the ticket page hint). */
export async function getPolicy(ctx: Ctx, q: { customerId?: string; contractId?: string } = {}): Promise<EffectivePolicy & { scope: { customerId: string | null; contractId: string | null } }> {
  if (!ctx.can('surveys:read', q.customerId) && !ctx.can('surveys:manage', q.customerId) && !ctx.can('admin:config', q.customerId)) throw new ForbiddenError('Missing permission: surveys:read');
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    await assertContract(ctx, q.customerId, q.contractId);
    const p = await effectivePolicy(ctx.tx, { customerId: q.customerId, contractId: q.contractId ?? null });
    return { ...p, scope: { customerId: q.customerId, contractId: q.contractId ?? null } };
  }
  return { ...(await loadSurveyDefaults(ctx.tx)), source: 'default', scope: { customerId: null, contractId: null } };
}

// ---------------------------------------------------------------- issuing

const mintToken = () => {
  const token = randomToken(24);
  return { tokenHash: sha256(token), tokenPrefix: token.slice(0, 6), tokenEnc: encryptSecret(token) };
};

export async function surveyRowFor(tx: Tx, ticketId: string): Promise<SurveyRow | null> {
  const [row] = await tx.select().from(S).where(eq(S.ticketId, ticketId)).limit(1);
  return row ?? null;
}

/** The person the survey goes to, rebuilt from the row (the reminder and the closure resend have no request context). */
async function recipientOf(tx: Tx, survey: SurveyRow): Promise<Recipient> {
  if (survey.recipientUserId) {
    const [u] = await tx.select({ email: schema.users.email, name: schema.users.name, phone: schema.users.phone, whatsappOptIn: schema.users.whatsappOptIn }).from(schema.users).where(eq(schema.users.id, survey.recipientUserId)).limit(1);
    if (u) return { userId: survey.recipientUserId, email: u.email, name: u.name, phone: u.phone, whatsappOptIn: u.whatsappOptIn };
  }
  if (survey.recipientContactId) {
    const [c] = await tx.select({ email: schema.contacts.email, name: schema.contacts.name, phone: schema.contacts.phone, mobile: schema.contacts.mobile, whatsappOptIn: schema.contacts.whatsappOptIn }).from(schema.contacts).where(eq(schema.contacts.id, survey.recipientContactId)).limit(1);
    if (c) return { email: c.email ?? survey.recipientEmail, name: c.name, phone: c.mobile ?? c.phone, whatsappOptIn: c.whatsappOptIn };
  }
  return { userId: survey.recipientUserId, email: survey.recipientEmail, name: survey.recipientName };
}

/**
 * Queues the invitation (or its reminder / closure resend) for the recipient:
 * email with five one-click links, an in-app notification when the recipient
 * has a portal account, WhatsApp when opted in. The links carry `?rating=`,
 * which the email template emits with triple braces.
 */
export async function sendInvitation(tx: Tx, survey: SurveyRow, ticket: TicketRow, opts: { reminder: boolean; outcome?: 'resolved' | 'closed' }): Promise<number> {
  const recipient = await recipientOf(tx, survey);
  const token = decryptSecret(survey.tokenEnc);
  const link = `${appUrl()}/survey/${token}`;
  const options = [1, 2, 3, 4, 5].map((value) => ({ value, label: RATING_LABELS[value]!, color: RATING_COLORS[value]!, link: `${link}?rating=${value}` }));
  const outcome = opts.outcome ?? (ticket.closedAt ? 'closed' : 'resolved');
  const portalLink = recipient.userId ? `${appUrl()}/portal/tickets/${ticket.id}?survey=1` : null;
  const [customer] = await tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, ticket.customerId)).limit(1);
  return queueNotification(tx, {
    event: 'ticket.survey_requested',
    recipients: [recipient],
    data: {
      ticket: { id: ticket.id, number: ticket.number, title: ticket.title, customerName: customer?.name ?? '', resolutionNotes: ticket.resolutionNotes ?? '', link: portalLink ?? link },
      survey: { question: survey.question, commentPrompt: survey.commentPrompt ?? '', link, options, expiresAt: survey.expiresAt.toISOString(), reminder: opts.reminder, outcome, portalLink },
    },
    customerId: ticket.customerId,
    channels: ['email', 'in_app', 'whatsapp'],
    entityType: 'ticket',
    entityId: ticket.id,
    link: `/portal/tickets/${ticket.id}?survey=1`,
    whatsappLink: link,
    title: `${opts.reminder ? 'Reminder: ' : ''}How did we do on ${ticket.number}?`,
    body: survey.question,
  });
}

export interface RequestOutcome {
  sent: boolean;
  reason?: SkipReason;
  survey?: SurveyRow;
}

const skipLabel: Record<SkipReason, string> = { disabled: 'surveys are switched off for this customer', type: 'this ticket type is not surveyed', sampling: 'sampling', fatigue: 'the requester was surveyed recently', no_recipient: 'no customer requester', answered: 'already answered', not_ended: 'the ticket is still open' };

/**
 * Issues (or re-issues) the survey for a ticket under the effective policy.
 * Never throws: the status hook and the manual send read the outcome.
 */
export async function requestSurvey(ctx: Ctx, ticket: TicketRow, opts: { trigger: SurveyTrigger; force?: boolean; policy?: SurveyPolicy }): Promise<RequestOutcome> {
  const policy = opts.policy ?? (await effectivePolicy(ctx.tx, { customerId: ticket.customerId, contractId: ticket.contractId }));
  const skip = async (reason: SkipReason, note = true): Promise<RequestOutcome> => {
    if (note) {
      await addActivity(ctx, ticket, { type: 'survey', summary: `Satisfaction survey not sent: ${skipLabel[reason]}`, data: { action: 'skip', reason, trigger: opts.trigger }, customerVisible: false });
      await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'survey.skip', customerId: ticket.customerId, metadata: { reason, trigger: opts.trigger } });
    }
    return { sent: false, reason };
  };
  if (!policy.enabled && !opts.force) return skip('disabled', false);
  if (!policy.ticketTypes.includes(ticket.type) && !opts.force) return skip('type', false);
  const existing = await surveyRowFor(ctx.tx, ticket.id);
  if (existing?.status === 'answered') return { sent: false, reason: 'answered', survey: existing };
  const { portal } = await resolveRecipients(ctx.tx, ticket, { requester: true });
  const recipient = portal[0];
  if (!recipient) return skip('no_recipient');
  const now = new Date();
  if (!opts.force) {
    if (!isSampled(ticket.id, policy.samplingPct)) return skip('sampling');
    if (policy.fatigueDays > 0) {
      const since = new Date(now.getTime() - policy.fatigueDays * DAY);
      const who = recipient.userId ? eq(S.recipientUserId, recipient.userId) : recipient.email ? ilike(S.recipientEmail, recipient.email) : null;
      if (who) {
        const [recent] = await ctx.tx.select({ id: S.id }).from(S).where(and(who, ne(S.ticketId, ticket.id), gt(S.requestedAt, since))).limit(1);
        if (recent) return skip('fatigue');
      }
    }
  }
  const token = mintToken();
  const snapshot = {
    customerId: ticket.customerId,
    assigneeId: ticket.assigneeId,
    assignedTeamId: ticket.assignedTeamId,
    serviceId: ticket.serviceId,
    priorityId: ticket.priorityId,
    ticketType: ticket.type,
    trigger: opts.trigger,
    question: policy.question,
    commentPrompt: policy.commentPrompt || null,
    recipientUserId: recipient.userId ?? null,
    recipientContactId: recipient.userId ? null : ticket.requesterContactId ?? null,
    recipientEmail: recipient.email ?? null,
    recipientName: recipient.name ?? null,
    ...token,
    status: 'pending' as const,
    requestedAt: now,
    expiresAt: new Date(now.getTime() + policy.expiryDays * DAY),
    remindedAt: null,
    resentAt: null,
    rating: null,
    comment: null,
    answeredAt: null,
    answeredByUserId: null,
    channel: null,
    lowRatingAlertedAt: null,
    updatedAt: now,
  };
  let survey: SurveyRow;
  if (existing) {
    [survey] = await ctx.tx.update(S).set({ ...snapshot, sendCount: existing.sendCount + 1 }).where(eq(S.id, existing.id)).returning() as SurveyRow[];
  } else {
    [survey] = await ctx.tx.insert(S).values({ ...snapshot, ticketId: ticket.id, sendCount: 1 }).returning() as SurveyRow[];
  }
  await sendInvitation(ctx.tx, survey!, ticket, { reminder: false, outcome: opts.trigger === 'closed' ? 'closed' : undefined });
  const channel = recipient.email ? 'email' : recipient.whatsappOptIn ? 'WhatsApp' : 'in-app';
  await addActivity(ctx, ticket, { type: 'survey', summary: `Satisfaction survey sent to ${recipient.name ?? recipient.email ?? 'the requester'} (${channel})${survey!.sendCount > 1 ? ' again' : ''}`, data: { action: 'send', trigger: opts.trigger, sendCount: survey!.sendCount }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'survey.send', customerId: ticket.customerId, metadata: { trigger: opts.trigger, recipient: recipient.email ?? null, sendCount: survey!.sendCount, forced: !!opts.force } });
  return { sent: true, survey: survey! };
}

/**
 * Status hook: a ticket reached resolved or closed. Never fails the transition.
 * `from` is the previous status category: a transition inside the same category
 * (amending the resolution) never re-issues a live survey, and a closure that
 * did not come from resolved (closed straight from open, or reopened and then
 * closed) is the ticket's first ending, so the survey is issued at closure.
 */
export async function onTicketEnded(ctx: Ctx, ticket: TicketRow, info: { category: 'resolved' | 'closed'; from?: string | null; action: string }): Promise<void> {
  try {
    if (info.from === info.category) return;
    const policy = await effectivePolicy(ctx.tx, { customerId: ticket.customerId, contractId: ticket.contractId });
    const existing = await surveyRowFor(ctx.tx, ticket.id);
    if (existing?.status === 'answered') return;
    const now = Date.now();
    const live = existing?.status === 'pending' && existing.expiresAt.getTime() > now;
    if (info.category === 'resolved') {
      if (policy.sendOn === 'resolved' && !live) await requestSurvey(ctx, ticket, { trigger: 'resolved', policy });
      return;
    }
    // Closure is the issue point when the policy says so, or when the ticket never ended through resolved (a skip at
    // resolution stays a skip: the closure of a ticket that was resolved does not ask again).
    if (!live && (policy.sendOn === 'closed' || info.from !== 'resolved')) {
      await requestSurvey(ctx, ticket, { trigger: 'closed', policy });
      return;
    }
    if (existing && policy.resendOnClose && live && !existing.resentAt && now - existing.requestedAt.getTime() >= RESEND_AFTER_MS) {
      await sendInvitation(ctx.tx, existing, ticket, { reminder: true, outcome: 'closed' });
      await ctx.tx.update(S).set({ resentAt: new Date(now), sendCount: existing.sendCount + 1, updatedAt: new Date(now) }).where(eq(S.id, existing.id));
      await addActivity(ctx, ticket, { type: 'survey', summary: 'Satisfaction survey sent again at closure', data: { action: 'resend', trigger: 'closed', sendCount: existing.sendCount + 1 }, customerVisible: false });
    }
  } catch (err) {
    logger.error({ err, ticketId: ticket.id, category: info.category, action: info.action }, 'survey hook failed');
  }
}

/** Status hook: a resolved or closed ticket was reopened or cancelled; a pending survey is withdrawn, an answer stands. */
export async function onTicketReopened(ctx: Ctx, ticket: TicketRow, reason: 'reopened' | 'cancelled' = 'reopened'): Promise<void> {
  try {
    const existing = await surveyRowFor(ctx.tx, ticket.id);
    if (!existing || existing.status !== 'pending') return;
    await ctx.tx.update(S).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(S.id, existing.id));
    await addActivity(ctx, ticket, { type: 'survey', summary: `Satisfaction survey withdrawn (ticket ${reason})`, data: { action: 'cancel', reason }, customerVisible: false });
    await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'survey.cancel', customerId: ticket.customerId, metadata: { reason } });
  } catch (err) {
    logger.error({ err, ticketId: ticket.id, reason }, 'survey withdrawal failed');
  }
}

/** Staff sends (or re-sends) the survey by hand: bypasses sampling and fatigue, never a second survey on an answered ticket. */
export async function sendSurvey(ctx: Ctx, ticketId: string): Promise<SurveyView> {
  const ticket = await loadTicket(ctx, ticketId);
  ctx.require('surveys:manage', ticket.customerId);
  const status = await optionById(ctx.tx, ticket.statusId);
  if (!ended(status?.statusCategory)) throw new ValidationError('Only resolved or closed tickets can be surveyed');
  const out = await requestSurvey(ctx, ticket, { trigger: 'manual', force: true });
  if (out.reason === 'no_recipient') throw new ValidationError('This ticket has no customer requester to survey');
  if (out.reason === 'answered') throw new ConflictError('The customer has already rated this ticket');
  if (!out.sent || !out.survey) throw new ValidationError('The survey could not be sent');
  return (await surveyView(ctx, out.survey))!;
}

// ---------------------------------------------------------------- answering

export interface AnswerInput {
  rating: number;
  comment?: string | null;
  channel: SurveyChannel;
  byUserId: string | null;
  byName: string;
}

/** Records the one answer: shared by the portal, the public page and the assistant. */
export async function recordAnswer(ctx: Ctx, survey: SurveyRow, input: AnswerInput): Promise<SurveyRow> {
  const now = new Date();
  if (survey.status === 'answered') throw new ConflictError('This survey has already been answered');
  if (survey.status !== 'pending') throw new SurveyClosedError(null);
  if (survey.expiresAt.getTime() < now.getTime()) throw new SurveyClosedError('expired');
  const ticket = await reloadTicket(ctx.tx, survey.ticketId);
  const status = await optionById(ctx.tx, ticket.statusId);
  if (!ended(status?.statusCategory)) throw new SurveyClosedError('cancelled');
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw new ValidationError('The rating must be a whole number from 1 to 5');
  const comment = input.comment?.trim() ? input.comment.trim().slice(0, 4000) : null;
  // The write is conditional on the row still being pending: two answers racing on one token (the one-click link open
  // in two tabs, a double send) leave exactly one rating, one activity and one alert; the loser gets the conflict.
  const [row] = (await ctx.tx
    .update(S)
    .set({ rating: input.rating, comment, answeredAt: now, answeredByUserId: input.byUserId, channel: input.channel, status: 'answered', updatedAt: now })
    .where(and(eq(S.id, survey.id), eq(S.status, 'pending')))
    .returning()) as SurveyRow[];
  if (!row) throw new ConflictError('This survey has already been answered');
  await ctx.tx.update(T).set({ csatRating: input.rating, csatAt: now, updatedAt: now }).where(eq(T.id, ticket.id));
  const excerpt = comment ? ` — "${comment.length > 120 ? `${comment.slice(0, 120)}…` : comment}"` : '';
  await addActivity(ctx, ticket, { type: 'survey', summary: `Customer rated this ticket ${input.rating}/5${excerpt}`, data: { action: 'answer', rating: input.rating, channel: input.channel, by: input.byName }, customerVisible: true });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'survey.answer', customerId: ticket.customerId, metadata: { rating: input.rating, channel: input.channel, hasComment: !!comment } });
  const policy = await effectivePolicy(ctx.tx, { customerId: ticket.customerId, contractId: ticket.contractId });
  if (input.rating <= policy.lowRatingThreshold) {
    const [stamped] = await ctx.tx.update(S).set({ lowRatingAlertedAt: now }).where(and(eq(S.id, survey.id), isNull(S.lowRatingAlertedAt))).returning({ id: S.id });
    if (stamped) {
      await notifyTicketEvent(ctx, 'ticket.survey_low_rating', ticket, { comment, reason: `${input.rating}/5`, recipientFallback: { assignee: true, manager: true, accountManager: true }, channels: ['email', 'in_app'] });
      row.lowRatingAlertedAt = now;
    }
  }
  return row;
}

/** The comment can be added once, within a day of the rating. */
export async function addComment(ctx: Ctx, survey: SurveyRow, comment: string, byUserId: string | null): Promise<SurveyRow> {
  const text = comment.trim().slice(0, 4000);
  if (!text) throw new ValidationError('The comment is empty');
  if (survey.status !== 'answered' || !survey.answeredAt) throw new ConflictError('Rate the ticket before adding a comment');
  if (survey.comment) throw new ConflictError('A comment was already added to this rating');
  if (Date.now() - survey.answeredAt.getTime() > DAY) throw new ConflictError('The comment window has closed');
  const [row] = (await ctx.tx.update(S).set({ comment: text, updatedAt: new Date() }).where(and(eq(S.id, survey.id), eq(S.status, 'answered'), isNull(S.comment))).returning()) as SurveyRow[];
  if (!row) throw new ConflictError('A comment was already added to this rating');
  const ticket = await reloadTicket(ctx.tx, survey.ticketId);
  await addActivity(ctx, ticket, { type: 'survey', summary: `Customer added a comment to the rating — "${text.length > 120 ? `${text.slice(0, 120)}…` : text}"`, data: { action: 'comment', by: byUserId }, customerVisible: true });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'survey.comment', customerId: ticket.customerId, metadata: { byUserId } });
  return row!;
}

// ---------------------------------------------------------------- views

export interface SurveyView {
  id: string;
  ticketId: string;
  status: SurveyRow['status'];
  question: string;
  commentPrompt: string | null;
  rating: number | null;
  comment: string | null;
  answeredAt: Date | null;
  answeredBy: { name: string } | null;
  channel: SurveyChannel | null;
  requestedAt: Date;
  expiresAt: Date;
  trigger: SurveyTrigger;
  sendCount: number;
  canAnswer: boolean;
  /** Staff only. */
  recipientName?: string | null;
  recipientEmail?: string | null;
  recipientUserId?: string | null;
  remindedAt?: Date | null;
  resentAt?: Date | null;
  lowRatingAlertedAt?: Date | null;
}

export type SurveyEmbed = SurveyView | { status: 'none'; reason: SkipReason | null; policy: { enabled: boolean; sendOn: SurveyPolicy['sendOn']; source: EffectivePolicy['source'] } | null };

export async function surveyView(ctx: Ctx, row: SurveyRow | null): Promise<SurveyView | null> {
  if (!row) return null;
  const [by] = row.answeredByUserId ? await ctx.tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, row.answeredByUserId)).limit(1) : [];
  const base: SurveyView = {
    id: row.id,
    ticketId: row.ticketId,
    status: row.status,
    question: row.question,
    commentPrompt: row.commentPrompt,
    rating: row.rating,
    comment: row.comment,
    answeredAt: row.answeredAt,
    answeredBy: by ? { name: by.name } : row.answeredAt ? { name: row.recipientName ?? 'the customer' } : null,
    channel: row.channel,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    trigger: row.trigger,
    sendCount: row.sendCount,
    canAnswer: row.status === 'pending' && row.expiresAt.getTime() > Date.now(),
  };
  if (isCustomerUser(ctx)) return base;
  return { ...base, recipientName: row.recipientName, recipientEmail: row.recipientEmail, recipientUserId: row.recipientUserId, remindedAt: row.remindedAt, resentAt: row.resentAt, lowRatingAlertedAt: row.lowRatingAlertedAt };
}

/** The survey block of a ticket read (staff and portal); without a row, staff learn why none was sent. */
export async function ticketSurveyEmbed(ctx: Ctx, ticket: TicketRow): Promise<SurveyEmbed> {
  const row = await surveyRowFor(ctx.tx, ticket.id);
  if (row) return (await surveyView(ctx, row))!;
  if (isCustomerUser(ctx)) return { status: 'none', reason: null, policy: null };
  const [skip] = await ctx.tx
    .select({ data: schema.ticketActivities.data })
    .from(schema.ticketActivities)
    .where(and(eq(schema.ticketActivities.ticketId, ticket.id), eq(schema.ticketActivities.activityType, 'survey'), sql`${schema.ticketActivities.data}->>'action' = 'skip'`))
    .orderBy(desc(schema.ticketActivities.createdAt))
    .limit(1);
  const policy = await effectivePolicy(ctx.tx, { customerId: ticket.customerId, contractId: ticket.contractId });
  return { status: 'none', reason: ((skip?.data as { reason?: SkipReason } | undefined)?.reason as SkipReason | undefined) ?? null, policy: { enabled: policy.enabled, sendOn: policy.sendOn, source: policy.source } };
}

export async function ticketSurvey(ctx: Ctx, ticketId: string): Promise<SurveyEmbed> {
  const ticket = await loadTicket(ctx, ticketId);
  requireRead(ctx, ticket);
  return ticketSurveyEmbed(ctx, ticket);
}

// ---------------------------------------------------------------- aggregates

const DEFAULT_DAYS = 30;
const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999Z`);

export function periodOf(q: { days?: number; from?: string; to?: string }, now = new Date()): { from: Date; to: Date; days: number } {
  if (q.from && q.to) {
    const from = dayStart(q.from);
    const to = dayEnd(q.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new ValidationError('Invalid period');
    return { from, to, days: Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY)) };
  }
  const days = q.days ?? DEFAULT_DAYS;
  return { from: new Date(now.getTime() - days * DAY), to: now, days };
}

/** The customer a read is about, whether the caller is a customer user (staff need surveys:read), and whether security tickets are fenced off. */
function visibility(ctx: Ctx, requested?: string | null): { customerId: string | null; customer: boolean; excludeSoc: boolean } {
  if (isCustomerUser(ctx)) {
    if (!ctx.user.customerId || !ctx.can('portal:access', ctx.user.customerId)) throw new ForbiddenError('Missing permission: portal:access');
    return { customerId: ctx.user.customerId, customer: true, excludeSoc: false };
  }
  ctx.require('surveys:read', requested ?? undefined);
  if (requested) ctx.requireCustomer(requested);
  return { customerId: requested ?? null, customer: false, excludeSoc: hidesSoc(ctx) };
}

export interface CsatSummary {
  period: { from: string; to: string; days: number };
  groupBy: GroupBy;
  thresholds: { satisfied: number; low: number };
  figures: Awaited<ReturnType<typeof csatFigures>>;
  groups: Awaited<ReturnType<typeof csatGroups>>;
  lowest: { id: string; ticketId: string; number: string; title: string; customerId: string; customerName: string | null; rating: number; comment: string | null; channel: string | null; answeredAt: Date; assigneeName?: string | null }[];
}

/**
 * The CSAT page's figures, trend, breakdown and lowest-rated tickets over a
 * scope (customer, engineer, team, service, period). The response-list
 * filters (`rating`, `low`, `channel`, `q`) are deliberately not part of this
 * query: the tiles are fixed counts over the scope, so toggling "Low ratings"
 * or a rating bar narrows the list below without moving the tiles above it
 * (the same rule as the ticket list's quick filters).
 */
export async function csatSummary(ctx: Ctx, q: SummaryQuery): Promise<CsatSummary> {
  const { customerId, customer, excludeSoc } = visibility(ctx, q.customerId);
  let groupBy: GroupBy = q.groupBy ?? 'customer';
  if (customer && (groupBy === 'customer' || groupBy === 'engineer' || groupBy === 'team')) groupBy = 'service';
  const defaults = await loadSurveyDefaults(ctx.tx);
  const period = periodOf(q);
  const f: CsatFilter = { customerId, from: period.from, to: period.to, assigneeId: customer ? null : q.assigneeId, teamId: customer ? null : q.teamId, serviceId: q.serviceId, domain: q.domain, excludeSoc, satisfiedThreshold: defaults.satisfiedThreshold, lowThreshold: defaults.lowRatingThreshold };
  const figures = await csatFigures(ctx.tx, f);
  const groups = await csatGroups(ctx.tx, { ...f, groupBy });
  const lowest = await csatLowest(ctx.tx, f, 10);
  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString(), days: period.days },
    groupBy,
    thresholds: { satisfied: defaults.satisfiedThreshold, low: defaults.lowRatingThreshold },
    figures,
    groups,
    lowest: lowest.map(({ assigneeName, ...rest }) => (customer ? rest : { ...rest, assigneeName })),
  };
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
  status: SurveyRow['status'];
  trigger: SurveyTrigger;
  requestedAt: Date;
  answeredAt: Date | null;
  respondentName: string | null;
  serviceName: string | null;
  /** Staff only. */
  assigneeName?: string | null;
  teamName?: string | null;
  recipientEmail?: string | null;
}

export async function listResponses(ctx: Ctx, q: ResponsesQuery): Promise<{ items: SurveyResponse[]; total: number; page: number; pageSize: number }> {
  const { customerId, customer, excludeSoc } = visibility(ctx, q.customerId);
  const defaults = await loadSurveyDefaults(ctx.tx);
  const period = periodOf(q);
  const assignee = alias(schema.users, 'sv_assignee');
  const answeredBy = alias(schema.users, 'sv_answered_by');
  const status = q.status ?? 'answered';
  const windowCol = status === 'answered' ? S.answeredAt : S.requestedAt;
  const conds: SQL[] = [eq(S.status, status), sql`${windowCol} >= ${period.from}`, sql`${windowCol} <= ${period.to}`];
  if (customerId) conds.push(eq(S.customerId, customerId));
  if (excludeSoc) conds.push(ne(T.domain, 'soc'));
  if (q.rating) conds.push(eq(S.rating, q.rating));
  if (q.low) conds.push(sql`${S.rating} <= ${q.lowThreshold ?? defaults.lowRatingThreshold}`);
  if (!customer && q.assigneeId) conds.push(eq(S.assigneeId, q.assigneeId));
  if (!customer && q.teamId) conds.push(eq(S.assignedTeamId, q.teamId));
  if (q.serviceId) conds.push(eq(S.serviceId, q.serviceId));
  if (q.channel) conds.push(eq(S.channel, q.channel));
  if (q.q?.trim()) {
    const pattern = `%${q.q.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
    conds.push(or(ilike(T.number, pattern), ilike(T.title, pattern), ilike(S.comment, pattern))!);
  }
  const where = and(...conds);
  const sortable: Record<string, SQL> = { answeredAt: sql`coalesce(${S.answeredAt}, ${S.requestedAt})`, requestedAt: sql`${S.requestedAt}`, rating: sql`${S.rating}`, customer: sql`${schema.customers.name}` };
  const sortCol = sortable[q.sort ?? 'answeredAt'] ?? sortable.answeredAt!;
  const order = q.order === 'asc' ? sql`${sortCol} ASC NULLS LAST` : sql`${sortCol} DESC NULLS LAST`;
  const base = () =>
    ctx.tx
      .select({
        id: S.id, ticketId: S.ticketId, number: T.number, title: T.title, customerId: S.customerId, customerName: schema.customers.name, rating: S.rating, comment: S.comment, channel: S.channel, status: S.status, trigger: S.trigger,
        requestedAt: S.requestedAt, answeredAt: S.answeredAt, answeredByName: answeredBy.name, recipientName: S.recipientName, recipientEmail: S.recipientEmail, serviceName: schema.services.name, assigneeName: assignee.name, teamName: schema.teams.name,
      })
      .from(S)
      .innerJoin(T, eq(T.id, S.ticketId))
      .leftJoin(schema.customers, eq(schema.customers.id, S.customerId))
      .leftJoin(schema.services, eq(schema.services.id, S.serviceId))
      .leftJoin(assignee, eq(assignee.id, S.assigneeId))
      .leftJoin(schema.teams, eq(schema.teams.id, S.assignedTeamId))
      .leftJoin(answeredBy, eq(answeredBy.id, S.answeredByUserId))
      .where(where);
  const [{ n }] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(S).innerJoin(T, eq(T.id, S.ticketId)).leftJoin(schema.customers, eq(schema.customers.id, S.customerId)).where(where);
  const { limit, offset } = limitOffset(q);
  const rows = await base().orderBy(order, desc(S.requestedAt)).limit(limit).offset(offset);
  const items: SurveyResponse[] = rows.map((r) => {
    const item: SurveyResponse = {
      id: r.id, ticketId: r.ticketId, number: r.number, title: r.title, customerId: r.customerId, customerName: r.customerName ?? null, rating: r.rating, comment: r.comment, channel: r.channel, status: r.status, trigger: r.trigger,
      requestedAt: r.requestedAt, answeredAt: r.answeredAt, respondentName: r.answeredByName ?? r.recipientName ?? null, serviceName: r.serviceName ?? null,
    };
    if (!customer) Object.assign(item, { assigneeName: r.assigneeName ?? null, teamName: r.teamName ?? null, recipientEmail: r.recipientEmail ?? null });
    return item;
  });
  return { items, total: n ?? 0, page: q.page, pageSize: q.pageSize };
}

// ---------------------------------------------------------------- the sweep (expiry and reminders)

/** Expires surveys past their date and sends the one reminder per pending survey; idempotent (`reminded_at` guards the reminder). */
export async function sweep(now = new Date()): Promise<{ expired: number; reminded: number }> {
  const expiredRows = await withSystem((tx) => tx.update(S).set({ status: 'expired', updatedAt: now }).where(and(eq(S.status, 'pending'), lt(S.expiresAt, now))).returning({ id: S.id }));
  // Candidates are read in pages by (requested_at, id), so rows that stay pending without a reminder (a customer with
  // reminders off, a survey not yet due) never crowd the ones that are due out of a fixed window.
  const candidates: { id: string }[] = [];
  let cursor: { requestedAt: Date; id: string } | null = null;
  for (;;) {
    const after = cursor;
    const page: { id: string; requestedAt: Date }[] = await withSystem((tx) =>
      tx
        .select({ id: S.id, requestedAt: S.requestedAt })
        .from(S)
        .where(and(eq(S.status, 'pending'), isNull(S.remindedAt), gt(S.expiresAt, now), after ? sql`(${S.requestedAt}, ${S.id}) > (${after.requestedAt}, ${after.id}::uuid)` : undefined))
        .orderBy(asc(S.requestedAt), asc(S.id))
        .limit(500),
    );
    candidates.push(...page.map((r) => ({ id: r.id })));
    if (page.length < 500) break;
    cursor = page[page.length - 1]!;
  }
  let reminded = 0;
  for (const { id } of candidates) {
    try {
      await withSystem(async (tx) => {
        const [row] = await tx.select().from(S).where(eq(S.id, id)).limit(1);
        if (!row || row.status !== 'pending' || row.remindedAt) return;
        const ticket = await reloadTicket(tx, row.ticketId);
        const policy = await effectivePolicy(tx, { customerId: ticket.customerId, contractId: ticket.contractId });
        if (policy.reminderDays <= 0) return;
        if (now.getTime() - row.requestedAt.getTime() < policy.reminderDays * DAY) return;
        const ctx = systemCtx(tx, 'survey-reminder');
        await sendInvitation(tx, row, ticket, { reminder: true });
        await tx.update(S).set({ remindedAt: now, sendCount: row.sendCount + 1, updatedAt: now }).where(eq(S.id, row.id));
        await addActivity(ctx, ticket, { type: 'survey', summary: 'Satisfaction survey reminder sent', data: { action: 'remind', sendCount: row.sendCount + 1 }, customerVisible: false });
        reminded++;
      });
    } catch (err) {
      logger.error({ err, surveyId: id }, 'survey reminder failed');
    }
  }
  if (expiredRows.length || reminded) logger.info({ expired: expiredRows.length, reminded }, 'survey sweep');
  return { expired: expiredRows.length, reminded };
}

/** Looks a survey up by its public token (hash lookup; malformed tokens never reach the database). */
export async function surveyByToken(tx: Tx, token: string): Promise<SurveyRow | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const [row] = await tx.select().from(S).where(eq(S.tokenHash, sha256(token))).limit(1);
  return row ?? null;
}

/** Leaves a row in the state an answer attempt discovered (expired link, reopened ticket) outside the failed transaction. */
export async function markSurvey(id: string, mark: 'expired' | 'cancelled'): Promise<void> {
  await withSystem((tx) => tx.update(S).set({ status: mark, updatedAt: new Date() }).where(and(eq(S.id, id), eq(S.status, 'pending'))));
}

export const surveysOf = (tx: Tx, ticketIds: string[]) => (ticketIds.length ? tx.select().from(S).where(inArray(S.ticketId, ticketIds)) : Promise.resolve([] as SurveyRow[]));
