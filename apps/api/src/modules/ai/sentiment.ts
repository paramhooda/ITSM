import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withSystem } from '@/db/client';
import { logger } from '@/core/logger';
import { systemCtx, reloadTicket, addActivity } from '@/modules/tickets/common';
import { notifyTicketEvent } from '@/modules/tickets/notify';
import { aiCtx, llmJson } from './service';
import { loadAiSettings, featureEnabled } from './guards';
import { SENTIMENT_SYSTEM } from './prompt';

/**
 * Sentiment of customer comments. A job runs after every customer-written
 * comment: the model labels it when a provider is configured, a small lexicon
 * otherwise. The label lands on the comment and, as "last sentiment", on the
 * ticket; a negative or angry comment adds an internal activity and tells the
 * assignee and the team manager (`ticket.sentiment_negative`), once per ticket
 * per six hours.
 */

export type Sentiment = 'positive' | 'neutral' | 'negative' | 'angry';
export const SENTIMENTS: Sentiment[] = ['positive', 'neutral', 'negative', 'angry'];
export const UNHAPPY: Sentiment[] = ['negative', 'angry'];
const REMIND_HOURS = 6;

const sentimentSchema = z.object({ sentiment: z.enum(['positive', 'neutral', 'negative', 'angry']), score: z.number().min(-100).max(100), reason: z.string().max(300).optional() });

const ANGRY = ['unacceptable', 'ridiculous', 'furious', 'outrage', 'disgrace', 'incompetent', 'useless', 'worst', 'pathetic', 'livid', 'fed up', 'absolutely not', 'lawyer', 'cancel the contract', 'escalate this', 'how dare', 'joke'];
const NEGATIVE = ['not working', 'still not', 'still broken', 'again', 'frustrat', 'disappoint', 'unhappy', 'delay', 'waiting', 'poor', 'slow', 'no response', 'nobody', 'ignored', 'urgent', 'asap', 'unacceptable', 'complain', 'bad', 'fail', 'wrong', 'terrible', 'horrible', 'annoy', 'upset', 'angry', 'late', 'missed', 'why', 'third time', 'second time'];
const POSITIVE = ['thank', 'thanks', 'great', 'resolved', 'appreciate', 'perfect', 'works now', 'working now', 'excellent', 'brilliant', 'well done', 'good job', 'cheers', 'fixed', 'happy', 'quick', 'fast', 'helpful', 'sorted'];

const count = (text: string, words: string[]) => words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

/** Deterministic fallback: a weighted word list plus shouting (capitals, exclamation marks). */
export function lexiconSentiment(body: string): { sentiment: Sentiment; score: number; reason: string } {
  const text = body.toLowerCase();
  const letters = body.replace(/[^a-z]/gi, '');
  const caps = letters.length >= 12 ? (letters.replace(/[^A-Z]/g, '').length / letters.length) : 0;
  const bangs = (body.match(/!/g) ?? []).length;
  const angry = count(text, ANGRY);
  const negative = count(text, NEGATIVE);
  const positive = count(text, POSITIVE);
  let score = positive * 25 - negative * 20 - angry * 40 - (caps > 0.6 ? 20 : 0) - Math.min(20, bangs * 7);
  score = Math.max(-100, Math.min(100, score));
  const sentiment: Sentiment = angry > 0 || score <= -80 ? 'angry' : score <= -20 ? 'negative' : score >= 20 ? 'positive' : 'neutral';
  const reasons = [angry ? `${angry} strong word${angry === 1 ? '' : 's'}` : null, negative ? `${negative} negative cue${negative === 1 ? '' : 's'}` : null, positive ? `${positive} positive cue${positive === 1 ? '' : 's'}` : null, caps > 0.6 ? 'written in capitals' : null, bangs >= 2 ? 'exclamation marks' : null].filter(Boolean) as string[];
  return { sentiment, score, reason: reasons.join(', ') || 'no strong cues' };
}

export interface SentimentOutcome {
  commentId: string;
  skipped?: string;
  sentiment?: Sentiment;
  score?: number;
  aiGenerated?: boolean;
  notified?: boolean;
}

/** Job entry: labels one comment (idempotent; a labelled comment is left alone). */
export async function analyseComment(commentId: string): Promise<SentimentOutcome> {
  const g = await withSystem(async (tx) => {
    const [c] = await tx.select().from(schema.ticketComments).where(eq(schema.ticketComments.id, commentId)).limit(1);
    if (!c) throw new Error(`Comment ${commentId} not found (not committed yet?)`);
    if (c.sentiment) return { skipped: 'already labelled' as const };
    if (c.kind !== 'comment' || c.isInternal) return { skipped: 'not a customer comment' as const };
    const [author] = c.authorId ? await tx.select({ userType: schema.users.userType }).from(schema.users).where(eq(schema.users.id, c.authorId)).limit(1) : [];
    const customerWritten = author ? author.userType === 'customer' : c.source === 'whatsapp' || c.source === 'email' || c.source === 'portal';
    if (!customerWritten) return { skipped: 'written by staff' as const };
    const settings = await loadAiSettings(tx);
    if (!featureEnabled(settings, 'sentiment')) return { skipped: 'sentiment is switched off' as const };
    return { comment: c };
  });
  if ('skipped' in g) return { commentId, skipped: g.skipped };
  const c = g.comment;

  // The model, with the lexicon as the fallback (no transaction open while the model answers).
  const llm = await llmJson(SENTIMENT_SYSTEM, JSON.stringify({ comment: c.body.slice(0, 4000) }), (v) => sentimentSchema.parse(v), { maxTokens: 200 });
  const verdict = llm ? { sentiment: llm.data.sentiment, score: Math.round(llm.data.score), reason: llm.data.reason ?? 'model' } : lexiconSentiment(c.body);

  return withSystem(async (tx) => {
    const ctx = aiCtx(systemCtx(tx, 'sentiment'));
    const now = new Date();
    await tx.update(schema.ticketComments).set({ sentiment: verdict.sentiment, sentimentScore: verdict.score }).where(eq(schema.ticketComments.id, c.id));
    await tx.update(schema.tickets).set({ lastSentiment: verdict.sentiment, lastSentimentAt: now }).where(eq(schema.tickets.id, c.ticketId));
    const out: SentimentOutcome = { commentId, sentiment: verdict.sentiment, score: verdict.score, aiGenerated: !!llm, notified: false };
    if (UNHAPPY.includes(verdict.sentiment)) {
      const ticket = await reloadTicket(tx, c.ticketId);
      const since = new Date(now.getTime() - REMIND_HOURS * 3600_000);
      const [recent] = await tx.select({ id: schema.ticketActivities.id }).from(schema.ticketActivities).where(and(eq(schema.ticketActivities.ticketId, ticket.id), eq(schema.ticketActivities.activityType, 'sentiment'), gte(schema.ticketActivities.createdAt, since))).orderBy(desc(schema.ticketActivities.createdAt)).limit(1);
      const excerpt = c.body.replace(/\s+/g, ' ').trim().slice(0, 160);
      await addActivity(ctx, ticket, { type: 'sentiment', summary: `${verdict.sentiment === 'angry' ? 'The customer sounds angry' : 'The customer sounds unhappy'}: "${excerpt}"`, data: { commentId: c.id, sentiment: verdict.sentiment, score: verdict.score, reason: verdict.reason, aiGenerated: !!llm }, customerVisible: false });
      await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'ai.sentiment', customerId: ticket.customerId, metadata: { commentId: c.id, sentiment: verdict.sentiment, score: verdict.score } });
      if (!recent) {
        await notifyTicketEvent(ctx, 'ticket.sentiment_negative', ticket, { comment: c.body, reason: verdict.sentiment, recipientFallback: { assignee: true, manager: true }, channels: ['in_app', 'email'] });
        out.notified = true;
      }
    }
    return out;
  });
}

/** Safety net: customer comments that never got a label (a lost job), newest first. */
export async function sweepUnlabelled(limit = 50) {
  const on = await withSystem(async (tx) => featureEnabled(await loadAiSettings(tx), 'sentiment'));
  if (!on) return 0;
  const rows = await withSystem((tx) =>
    tx
      .select({ id: schema.ticketComments.id })
      .from(schema.ticketComments)
      .where(and(eq(schema.ticketComments.kind, 'comment'), eq(schema.ticketComments.isInternal, false), sql`${schema.ticketComments.sentiment} IS NULL`, gte(schema.ticketComments.createdAt, new Date(Date.now() - 7 * 86_400_000))))
      .orderBy(desc(schema.ticketComments.createdAt))
      .limit(limit),
  );
  let labelled = 0;
  for (const { id } of rows) {
    try {
      const out = await analyseComment(id);
      if (out.sentiment) labelled++;
      else if (out.skipped === 'written by staff' || out.skipped === 'not a customer comment') {
        // Staff comments stay unlabelled by design: mark them so the sweep stops revisiting them.
        await withSystem((tx) => tx.update(schema.ticketComments).set({ sentiment: 'n/a' }).where(and(eq(schema.ticketComments.id, id), sql`${schema.ticketComments.sentiment} IS NULL`)));
      }
    } catch (err) {
      logger.warn({ err, commentId: id }, 'sentiment sweep failed for a comment');
    }
  }
  return labelled;
}
