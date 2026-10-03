import { z } from 'zod';
import type { Ctx } from '@/core/context';
import { ForbiddenError } from '@/core/errors';
import { asSteps, llmJson, type Steps } from '@/modules/ai/service';
import { assertFeature } from '@/modules/ai/guards';
import { ANNOUNCEMENT_SYSTEM } from '@/modules/ai/prompt';
import { getTicket } from '@/modules/tickets/service';
import { getMajor } from '@/modules/tickets/major';
import { isCustomerUser } from '@/modules/tickets/common';
import type { DraftAnnouncementInput } from './schemas';

/**
 * A drafted announcement (title and body) from a ticket or free notes: the
 * model writes it when a provider is configured, a template otherwise. Nothing
 * is published here; the draft lands in the editor for a person to approve.
 */

const draftSchema = z.object({ title: z.string().min(3).max(200), body: z.string().min(10).max(2000) });
const trunc = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : '');

interface Facts {
  number: string;
  title: string;
  type: string;
  status: string | null;
  priority: string | null;
  customer: string | null;
  affected: string[];
  description: string;
  isMajor: boolean;
  latestUpdate: string | null;
  window: { start: Date | null; end: Date | null } | null;
}

export async function draftAnnouncement(who: Ctx | Steps, input: DraftAnnouncementInput) {
  const s = asSteps(who);
  const facts = await s.tx(async (ctx) => {
    await assertFeature(ctx, 'draft');
    if (isCustomerUser(ctx)) throw new ForbiddenError();
    ctx.require('announcements:manage');
    if (!input.ticketId) return null;
    const t = await getTicket(ctx, input.ticketId);
    const major = t.isMajor ? await getMajor(ctx, t.id) : null;
    const latest = major?.updates.find((u) => u.kind === 'stakeholder')?.body ?? null;
    const f: Facts = {
      number: t.number,
      title: t.title,
      type: t.type,
      status: t.status?.label ?? null,
      priority: t.priority?.label ?? null,
      customer: t.customer?.name ?? null,
      affected: t.cis.map((c) => c.name).slice(0, 8),
      description: trunc(t.description, 600),
      isMajor: t.isMajor,
      latestUpdate: latest ? trunc(latest, 400) : null,
      window: t.change ? { start: t.change.scheduledStart ?? null, end: t.change.scheduledEnd ?? null } : null,
    };
    return f;
  });
  const type = input.type ?? (facts?.type === 'change' ? 'maintenance' : facts?.isMajor || facts?.type === 'incident' ? 'outage' : 'info');
  const audience = input.audience ?? 'all';
  const llm = await llmJson(ANNOUNCEMENT_SYSTEM, JSON.stringify({ type, audience, ticket: facts, notes: input.notes ?? null, now: new Date().toISOString() }), (v) => draftSchema.parse(v), { maxTokens: 400 });
  const draft = llm?.data ?? fallbackDraft(type, facts, input.notes ?? null);
  return { ...draft, type, audience, aiGenerated: !!llm, sourceTicketId: input.ticketId ?? null };
}

function fallbackDraft(type: 'info' | 'maintenance' | 'outage', f: Facts | null, notes: string | null): { title: string; body: string } {
  const subject = f ? f.title : trunc(notes?.split(/\r?\n/)[0], 90) || 'Service notice';
  const affected = f?.affected.length ? ` affecting ${f.affected.slice(0, 3).join(', ')}` : '';
  const fmt = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null);
  if (type === 'outage') {
    const state = f?.status && /resolved|closed/i.test(f.status) ? 'Service has been restored and we are monitoring closely.' : 'Our engineers are working on it as the highest priority.';
    return { title: `Service disruption: ${subject}`, body: `We are aware of a disruption${affected}. ${state}${f?.latestUpdate ? ` Latest: ${f.latestUpdate}` : ''} We will post updates here as soon as we have them. We apologise for the inconvenience.` };
  }
  if (type === 'maintenance') {
    const start = fmt(f?.window?.start ?? null);
    const end = fmt(f?.window?.end ?? null);
    const when = start && end ? ` between ${start} and ${end}` : start ? ` from ${start}` : '';
    return { title: `Planned maintenance: ${subject}`, body: `Planned maintenance${affected} will take place${when}. Short interruptions are possible while the work is carried out. No action is needed on your side; we will confirm here once it is complete.${notes ? ` ${trunc(notes, 300)}` : ''}` };
  }
  return { title: subject, body: f?.description || notes || 'Please see the details on the ticket.' };
}
