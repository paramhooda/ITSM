import { z } from 'zod';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { schema } from '@/db/client';
import { eq } from 'drizzle-orm';
import { loadTicket, requireAction } from '@/modules/tickets/common';
import { llmJson, asSteps, type Steps } from '@/modules/ai/service';
import { assertFeature } from '@/modules/ai/guards';
import { storeSuggestion } from '@/modules/ai/suggestions';
import { KNOWN_ERROR_SYSTEM } from '@/modules/ai/prompt';

/**
 * Customer-facing wording of a known error, drafted from the engineers'
 * problem record. Runs as gather → model → store (Steps pattern): the model
 * call holds no database connection, and without a provider the wording is
 * assembled deterministically from the symptoms and the internal workaround
 * with hostnames and addresses removed.
 */
const wordingSchema = z.object({ summary: z.string().min(10).max(2000), workaround: z.string().min(10).max(4000) });
export type KnownErrorWording = z.infer<typeof wordingSchema>;

const HOST_OR_IP = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/gi;
export const scrubSystems = (s: string) => s.replace(HOST_OR_IP, 'the affected system');
const firstSentence = (s: string) => {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(s.trim());
  return (m ? m[0] : s.trim()).replace(/\s+/g, ' ').trim();
};

interface ProblemFacts {
  number: string;
  title: string;
  symptoms: string | null;
  impactSummary: string | null;
  workaround: string | null;
  service: string | null;
  customerName: string | null;
}

export function fallbackWording(p: ProblemFacts): KnownErrorWording {
  const summary = scrubSystems(p.symptoms?.trim() ? firstSentence(p.symptoms) : p.title);
  const workaround = p.workaround?.trim() ? scrubSystems(p.workaround.trim()) : 'No action is needed on your side; our team is working on a permanent fix.';
  return { summary: summary.length >= 10 ? summary : `${summary} (${p.title})`.slice(0, 2000), workaround: workaround.slice(0, 4000) };
}

export async function draftCustomerWording(who: Ctx | Steps, ticketId: string) {
  const s = asSteps(who);
  const g = await s.tx(async (ctx) => {
    await assertFeature(ctx, 'kedb_draft');
    const t = await loadTicket(ctx, ticketId);
    if (t.type !== 'problem') throw new ValidationError('Not a problem record');
    requireAction(ctx, t, 'problems:manage');
    const [pd] = await ctx.tx.select().from(schema.problemDetails).where(eq(schema.problemDetails.ticketId, t.id)).limit(1);
    const [cust] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, t.customerId)).limit(1);
    const [svc] = t.serviceId ? await ctx.tx.select({ name: schema.services.name }).from(schema.services).where(eq(schema.services.id, t.serviceId)).limit(1) : [];
    const facts: ProblemFacts = { number: t.number, title: t.title, symptoms: pd?.symptoms ?? null, impactSummary: pd?.impactSummary ?? null, workaround: pd?.workaround ?? null, service: svc?.name ?? null, customerName: cust?.name ?? null };
    return { ticketId: t.id, customerId: t.customerId, facts };
  });
  const llm = await llmJson(KNOWN_ERROR_SYSTEM, JSON.stringify(g.facts), (v) => wordingSchema.parse(v), { maxTokens: 500 });
  const wording = llm?.data ?? fallbackWording(g.facts);
  return s.tx(async (ctx) => {
    const suggestionId = await storeSuggestion(ctx, { customerId: g.customerId, entityType: 'ticket', entityId: g.ticketId, kind: 'known_error_wording', payload: { summary: wording.summary, workaround: wording.workaround }, rationale: llm ? 'Drafted by the AI provider from the problem record' : 'Assembled from the symptoms and the workaround (AI provider not configured)' });
    return { suggestionId, summary: wording.summary, workaround: wording.workaround, aiGenerated: !!llm };
  });
}
