import type { SurveyChannel } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { sha256, randomToken, encryptSecret } from '@/lib/crypto';
import { loadTicket, optionById, requireAction } from '@/modules/tickets/common';
import { resolvePortalCustomer } from '@/modules/portal/service';
import { effectivePolicy, voluntaryRatingOpen } from './policy';
import { pendingSurveyCount, pendingSurveyItems } from './figures';
import { recordAnswer, surveyRowFor, surveyView, type SurveyRow, type SurveyView } from './service';
import type { AnswerBody } from './schemas';

/**
 * The customer side of surveys: rating a ticket from the portal (or through
 * the assistant) and the "to rate" list. These two need `resolvePortalCustomer`,
 * which lives in a module that imports the ticket status hook, so they sit
 * apart from `./service` to keep the import graph acyclic.
 */

const DAY = 86_400_000;

/**
 * A customer rates a resolved or closed ticket. When sampling skipped the
 * ticket (no row) and it ended recently, a row is created silently: a
 * voluntary rating is never fatigue.
 */
export async function answerPortalSurvey(ctx: Ctx, ticketId: string, body: AnswerBody, channel: SurveyChannel = 'portal'): Promise<SurveyView> {
  resolvePortalCustomer(ctx, 'portal:tickets', null, { mutation: true });
  const t = await loadTicket(ctx, ticketId);
  requireAction(ctx, t, 'tickets:resolve', 'portal:tickets');
  const status = await optionById(ctx.tx, t.statusId);
  const cat = status?.statusCategory;
  if (cat !== 'resolved' && cat !== 'closed') throw new ValidationError('Only resolved or closed tickets can be rated');
  let row = await surveyRowFor(ctx.tx, t.id);
  if (!row) {
    const policy = await effectivePolicy(ctx.tx, { customerId: t.customerId, contractId: t.contractId });
    if (!policy.enabled || !policy.ticketTypes.includes(t.type)) throw new ValidationError('Surveys are not enabled for this ticket');
    if (!voluntaryRatingOpen(policy, t)) throw new ValidationError('The rating window for this ticket has closed');
    const token = randomToken(24);
    const now = new Date();
    [row] = (await ctx.tx
      .insert(schema.ticketSurveys)
      .values({
        ticketId: t.id, customerId: t.customerId, assigneeId: t.assigneeId, assignedTeamId: t.assignedTeamId, serviceId: t.serviceId, priorityId: t.priorityId, ticketType: t.type, trigger: 'manual',
        question: policy.question, commentPrompt: policy.commentPrompt || null, recipientUserId: ctx.user.id, recipientEmail: ctx.user.email, recipientName: ctx.user.name,
        tokenHash: sha256(token), tokenPrefix: token.slice(0, 6), tokenEnc: encryptSecret(token), status: 'pending', requestedAt: now, expiresAt: new Date(now.getTime() + policy.expiryDays * DAY), sendCount: 0,
      })
      .returning()) as SurveyRow[];
  }
  const answered = await recordAnswer(ctx, row!, { rating: body.rating, comment: body.comment ?? null, channel, byUserId: ctx.user.id, byName: ctx.user.name });
  return (await surveyView(ctx, answered))!;
}

/** The organisation's tickets still waiting for a rating (newest first, at most five), for the portal home and the "To rate" chip. */
export async function pendingForPortal(ctx: Ctx, requested?: string | null) {
  const scope = resolvePortalCustomer(ctx, 'portal:tickets', requested);
  const [count, items] = [await pendingSurveyCount(ctx.tx, scope.customerId), await pendingSurveyItems(ctx.tx, scope.customerId, null, 5)];
  return { count, items };
}
