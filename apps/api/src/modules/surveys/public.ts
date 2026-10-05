import { eq } from 'drizzle-orm';
import { schema, withSystem } from '@/db/client';
import { ConflictError } from '@/core/errors';
import { config } from '@/config';
import { systemCtx } from '@/modules/tickets/common';
import { addComment, markSurvey, recordAnswer, surveyByToken, SurveyClosedError } from './service';

/**
 * The public survey page behind the email link: no sign-in, the token is the
 * only credential, and nothing leaves but the respondent's own ticket number
 * and title. Unknown, withdrawn and malformed tokens are indistinguishable.
 */

export interface PublicSurvey {
  status: 'pending' | 'answered' | 'expired' | 'cancelled';
  question: string;
  commentPrompt: string | null;
  ticket: { number: string; title: string };
  rating: number | null;
  hasComment: boolean;
  answeredAt: Date | null;
  expiresAt: Date;
  hasPortal: boolean;
  portalLink: string | null;
}

export type PublicOutcome<T> = { ok: true; data: T } | { ok: false; code: 'not_found' | 'gone' | 'conflict' };

const appUrl = () => config.APP_URL.replace(/\/$/, '');

export async function publicSurvey(token: string): Promise<PublicSurvey | null> {
  return withSystem(async (tx) => {
    const s = await surveyByToken(tx, token);
    if (!s || s.status === 'cancelled') return null;
    const [t] = await tx.select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title }).from(schema.tickets).where(eq(schema.tickets.id, s.ticketId)).limit(1);
    if (!t) return null;
    const status = s.status === 'pending' && s.expiresAt.getTime() < Date.now() ? 'expired' : s.status;
    return {
      status,
      question: s.question,
      commentPrompt: s.commentPrompt,
      ticket: { number: t.number, title: t.title },
      rating: s.rating,
      hasComment: !!s.comment,
      answeredAt: s.answeredAt,
      expiresAt: s.expiresAt,
      hasPortal: !!s.recipientUserId,
      portalLink: s.recipientUserId ? `${appUrl()}/portal/tickets/${t.id}?survey=1` : null,
    };
  });
}

async function attempt<T>(token: string, fn: (survey: NonNullable<Awaited<ReturnType<typeof surveyByToken>>>) => Promise<T>): Promise<PublicOutcome<T>> {
  const survey = await withSystem((tx) => surveyByToken(tx, token));
  if (!survey || survey.status === 'cancelled') return { ok: false, code: 'not_found' };
  try {
    return { ok: true, data: await fn(survey) };
  } catch (err) {
    if (err instanceof SurveyClosedError) {
      if (err.mark) await markSurvey(survey.id, err.mark);
      return { ok: false, code: 'gone' };
    }
    if (err instanceof ConflictError) return { ok: false, code: 'conflict' };
    throw err;
  }
}

export function publicRate(token: string, rating: number) {
  return attempt(token, async (survey) => {
    const row = await withSystem((tx) => recordAnswer(systemCtx(tx, 'survey-public'), survey, { rating, comment: null, channel: 'email', byUserId: survey.recipientUserId, byName: survey.recipientName ?? 'the customer' }));
    return { status: 'answered' as const, rating: row.rating, hasComment: false };
  });
}

export function publicComment(token: string, comment: string) {
  return attempt(token, async (survey) => {
    await withSystem((tx) => addComment(systemCtx(tx, 'survey-public'), survey, comment, survey.recipientUserId));
    return { status: 'answered' as const, hasComment: true };
  });
}
