import { inArray, sql } from 'drizzle-orm';
import { schema, type Tx } from '@/db/client';
import { sha256, randomToken, encryptSecret } from '@/lib/crypto';
import { customer, type DemoState } from './state';
import { addDays, addMinutes, HOUR, minDate } from './rng';

/**
 * Customer satisfaction over the last ninety days: every resolved incident or
 * request of a surveyed customer gets its survey row two minutes after the
 * resolution; about half are answered (Apex answers more and rates lower,
 * Riverside answers less), two in five answers carry a comment, poor ratings
 * were alerted, unanswered surveys were reminded and expired on schedule, and
 * the closure resend is recorded where the ticket closed with the survey still
 * open. Rows are inserted directly (no services, so no outbox), and the
 * tickets' denormalised rating follows. Three policy overrides show the
 * configuration: Helios (switched off by contract), Apex (stricter) and one
 * Meridian contract with its own question.
 */

const DAY = 86_400_000;
const EXPIRY_DAYS = 14;
const REMINDER_DAYS = 3;

const COMMENTS: Record<number, string[]> = {
  5: ['Fixed within the hour, thank you Priya.', 'Quick, clear and polite. Exactly what we need.', 'Resolved before most of the team noticed.', 'Great follow-up after the fix as well.', 'Kept us informed at every step.', 'The engineer explained the cause so we can avoid it next time.'],
  4: ['Good outcome, a little slow to pick up at first.', 'Sorted, though we had to chase once.', 'Helpful engineer; the portal updates could be more frequent.', 'Fine overall. Would have liked a call when it was done.', 'Resolved properly on the second attempt.'],
  3: ['It works now but took longer than the SLA suggested.', 'Mixed: fast response, slow fix.', 'Had to explain the problem twice.', 'Acceptable, nothing more.', 'The workaround was fine; the real fix took a while.'],
  2: ['Took three follow-ups before anyone called back.', 'The ticket was closed before the problem was actually fixed.', 'Nobody told us about the maintenance window.', 'Too many hand-offs between engineers.', 'Communication was poor throughout.'],
  1: ['Still not fixed properly and the ticket was closed anyway.', 'We lost half a day and nobody kept us informed.', 'Very disappointing; the escalation went nowhere.', 'The fix broke something else.', 'Had to raise it again under a new number.'],
};
const BASE_WEIGHTS: readonly (readonly [number, number])[] = [[5, 45], [4, 30], [3, 13], [2, 7], [1, 5]];
const LOW_WEIGHTS: readonly (readonly [number, number])[] = [[5, 25], [4, 30], [3, 20], [2, 15], [1, 10]];
const CHANNELS: readonly (readonly ['email' | 'portal' | 'assistant', number])[] = [['email', 60], ['portal', 35], ['assistant', 5]];
const NO_SURVEY_CUSTOMERS = ['helios'];

export async function seedSurveys(state: DemoState, tx: Tx) {
  const { rng, now } = state;

  // ---- policy overrides
  const helios = customer(state, 'helios');
  const apex = customer(state, 'apex');
  const meridian = customer(state, 'meridian');
  const meridianContract = meridian.contracts.find((c) => c.status === 'active') ?? meridian.contracts[0] ?? null;
  const configs: (typeof schema.surveyConfigs.$inferInsert)[] = [
    { customerId: helios.id, contractId: null, enabled: false, notes: 'Government customer: no surveys by contract' },
    { customerId: apex.id, contractId: null, samplingPct: 100, reminderDays: 2, lowRatingThreshold: 3, notes: 'Retail: every ticket surveyed, a quick reminder, three counts as a poor rating' },
    ...(meridianContract ? [{ customerId: meridian.id, contractId: meridianContract.id, question: 'How satisfied are you with the security desk on this ticket?', notes: 'Security contract: its own question' }] : []),
  ];
  await tx.insert(schema.surveyConfigs).values(configs).onConflictDoNothing();
  state.counts.surveyConfigs = configs.length;

  // ---- one survey per resolved incident or request of the last ninety days
  const since = addDays(now, -90);
  const candidates = [...state.tickets.values()].filter((t) => (t.type === 'incident' || t.type === 'request') && !!t.resolvedAt && t.resolvedAt >= since && t.resolvedAt <= now && !NO_SURVEY_CUSTOMERS.includes(t.customerKey));
  const ids = candidates.map((t) => t.id);
  const ticketRows = ids.length
    ? await tx
        .select({ id: schema.tickets.id, closedAt: schema.tickets.closedAt, requesterUserId: schema.tickets.requesterUserId, requesterContactId: schema.tickets.requesterContactId, assigneeId: schema.tickets.assigneeId, assignedTeamId: schema.tickets.assignedTeamId, serviceId: schema.tickets.serviceId, priorityId: schema.tickets.priorityId, customerId: schema.tickets.customerId })
        .from(schema.tickets)
        .where(inArray(schema.tickets.id, ids))
    : [];
  const rowById = new Map(ticketRows.map((r) => [r.id, r]));
  const values: (typeof schema.ticketSurveys.$inferInsert)[] = [];
  let answeredCount = 0;
  for (const t of candidates) {
    const row = rowById.get(t.id);
    if (!row || !t.resolvedAt) continue;
    const cust = customer(state, t.customerKey);
    const requestedAt = addMinutes(t.resolvedAt, 2);
    const expiresAt = addDays(requestedAt, EXPIRY_DAYS);
    // The recipient: the ticket's own portal requester, its contact, or (as the email case) a contact with an address.
    const ownUser = row.requesterUserId ? cust.portalUsers.find((p) => p.id === row.requesterUserId) ?? null : null;
    const ownContact = row.requesterContactId ? cust.contacts.find((c) => c.id === row.requesterContactId && c.email) ?? null : null;
    const contact = ownContact ?? cust.contacts.find((c) => c.email) ?? null;
    const portalUser = ownUser ?? cust.portalUsers[0] ?? null;
    const useContact = !ownUser && (ownContact !== null || !portalUser || rng.chance(0.25));
    const recipient = useContact && contact
      ? { userId: contact.userId, contactId: contact.id, email: contact.email, name: contact.name }
      : portalUser
        ? { userId: portalUser.id, contactId: portalUser.contactId, email: portalUser.email, name: portalUser.name }
        : null;
    if (!recipient) continue;
    const token = randomToken(24);
    const answerP = t.customerKey === 'apex' ? 0.65 : t.customerKey === 'riverside' ? 0.4 : 0.55;
    const answered = rng.chance(answerP);
    const answeredAt = answered ? minDate(addMinutes(requestedAt, rng.int(1, 72) * 60), now) : null;
    const lower = t.priorityKey === 'p1' || t.customerKey === 'apex';
    const rating = answered ? rng.weighted(lower ? LOW_WEIGHTS : BASE_WEIGHTS) : null;
    let channel = answered ? rng.weighted(CHANNELS) : null;
    if (channel && channel !== 'email' && !recipient.userId) channel = 'email';
    const comment = answered && rating !== null && rng.chance(0.4) ? rng.pick(COMMENTS[rating]!) : null;
    const closedUnanswered = !!row.closedAt && row.closedAt.getTime() - requestedAt.getTime() >= 24 * HOUR && (!answeredAt || answeredAt > row.closedAt);
    const expired = !answered && expiresAt < now;
    const reminded = !answered || (answeredAt && answeredAt.getTime() > requestedAt.getTime() + REMINDER_DAYS * DAY) ? addDays(requestedAt, REMINDER_DAYS) < now : false;
    values.push({
      ticketId: t.id,
      customerId: row.customerId,
      assigneeId: row.assigneeId,
      assignedTeamId: row.assignedTeamId,
      serviceId: row.serviceId,
      priorityId: row.priorityId,
      ticketType: t.type as 'incident' | 'request',
      trigger: 'resolved',
      question: meridianContract && t.customerKey === 'meridian' ? 'How satisfied are you with the security desk on this ticket?' : 'How satisfied are you with how we handled this ticket?',
      commentPrompt: 'Anything we could have done better?',
      recipientUserId: recipient.userId,
      recipientContactId: recipient.userId ? null : recipient.contactId,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      tokenHash: sha256(token),
      tokenPrefix: token.slice(0, 6),
      tokenEnc: encryptSecret(token),
      status: answered ? 'answered' : expired ? 'expired' : 'pending',
      requestedAt,
      expiresAt,
      remindedAt: reminded ? addDays(requestedAt, REMINDER_DAYS) : null,
      resentAt: closedUnanswered ? row.closedAt : null,
      sendCount: 1 + (reminded ? 1 : 0) + (closedUnanswered ? 1 : 0),
      rating,
      comment,
      answeredAt,
      answeredByUserId: answered && channel !== 'email' ? recipient.userId : null,
      channel,
      lowRatingAlertedAt: answered && rating !== null && rating <= 2 && answeredAt ? addMinutes(answeredAt, 1) : null,
      createdAt: requestedAt,
      updatedAt: answeredAt ?? (closedUnanswered ? row.closedAt! : requestedAt),
    });
    if (answered) answeredCount++;
  }
  for (let i = 0; i < values.length; i += 200) await tx.insert(schema.ticketSurveys).values(values.slice(i, i + 200)).onConflictDoNothing();
  await tx.execute(sql`UPDATE tickets SET csat_rating = s.rating, csat_at = s.answered_at FROM ticket_surveys s WHERE s.ticket_id = tickets.id AND s.rating IS NOT NULL`);
  state.counts.surveys = values.length;
  state.counts.surveyResponses = answeredCount;
}
