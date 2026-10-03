import { z } from 'zod';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { getTicket, updateTicket, assignTicket } from '@/modules/tickets/service';
import { similarTickets } from '@/modules/tickets/list';
import { addComment, timeline, addLink } from '@/modules/tickets/activity';
import { getMajor } from '@/modules/tickets/major';
import type { TicketRow } from '@/modules/tickets/common';
import { suggest as kbSuggest, getArticle } from '@/modules/knowledge/service';
import { gatherClassification, recommendAssignmentIn, duplicateCheckIn, _internal } from '../suggestions';
import { define, type PreviewDetail } from './types';
import { ticketRef } from './core';
import { isCustomerUser, ticketLink, trunc, iso, resolveTicket, resolveOption, resolveEngineer, resolveTeam, resolveArticle, compactDetail, compactTimeline, articleLink } from '../helpers';

/**
 * Triage tools. They gather structured signals through the platform's own
 * logic (option lists, the classification heuristic, assignment rules and
 * workload, duplicate candidates, knowledge matches, resolved look-alikes) and
 * leave the reasoning to the assistant, so no second model call runs inside a
 * tool. `apply_triage` then commits the chosen changes in one confirmed step.
 */

const short = (t: Pick<TicketRow, 'number' | 'title'>) => `${t.number} ("${t.title.slice(0, 80)}")`;
const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] || null;

async function softly<T>(fn: () => Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await fn();
  } catch (err) {
    return { unavailable: err instanceof Error ? err.message.slice(0, 160) : 'not available' };
  }
}

export const TRIAGE: ReturnType<typeof define>[] = [
  define({
    name: 'triage_ticket',
    toolset: 'triage',
    description: 'Everything needed to triage one ticket in one call: its current classification, the option lists with the platform\'s heuristic suggestion, the assignment recommendation (rules, service team, workload, past resolvers), likely duplicates among the customer\'s open tickets and matching knowledge articles. Reason over the result, then propose apply_triage with the chosen values.',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['tickets:update'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const d = await getTicket(ctx, t.id);
      const g = await gatherClassification(ctx, { title: t.title, description: t.description, type: t.type, domainHint: d.service?.key ? null : t.domain });
      const assignment = await softly(() => recommendAssignmentIn(ctx, t.id));
      const duplicates = await softly(() => duplicateCheckIn(ctx, t.id));
      const kb = await softly(() => kbSuggest(ctx, { q: `${t.title} ${trunc(t.description, 300) ?? ''}`.trim(), customerId: t.customerId, serviceId: t.serviceId ?? undefined, limit: 5 }));
      const strip = <T extends { suggestionId?: string; aiGenerated?: boolean }>(x: T) => {
        const { suggestionId: _s, aiGenerated: _a, ...rest } = x;
        return rest;
      };
      return {
        ticket: { number: d.number, title: d.title, type: d.type, description: trunc(d.description, 1200), customer: d.customer?.name ?? null, service: d.service?.name ?? null, site: d.site?.name ?? null, status: d.status?.label ?? null, assignee: d.assignee?.name ?? null, team: d.team?.name ?? null, scope: d.scopeStatus, cis: d.cis.map((c) => c.name), link: ticketLink(ctx, d.id) },
        current: { category: d.category?.label ?? null, subcategory: d.subcategory?.label ?? null, impact: d.impact?.label ?? null, urgency: d.urgency?.label ?? null, priority: d.priority?.label ?? null },
        heuristic: { category: g.heuristic.labels.category, subcategory: g.heuristic.labels.subcategory, impact: g.heuristic.labels.impact, urgency: g.heuristic.labels.urgency, priority: g.heuristic.labels.priority, confidence: g.heuristic.confidence, rationale: g.heuristic.rationale },
        options: { categories: g.cats.map((c) => ({ key: c.key, label: c.label, subcategories: g.subs.filter((s) => s.parentId === c.id).map((s) => s.key) })), impacts: g.impacts.map((o) => o.key), urgencies: g.urgencies.map((o) => o.key), priorities: g.priorities.map((o) => o.key), note: 'Priority normally follows impact × urgency through the priority matrix; set impact and urgency and leave priority unless the user asks for a specific one.' },
        assignment: 'unavailable' in assignment ? assignment : strip(assignment),
        duplicates: 'unavailable' in duplicates ? duplicates : strip(duplicates),
        knowledge: 'unavailable' in kb ? kb : { items: kb.items.map((a) => ({ number: a.number, title: a.title, summary: a.summary, type: a.articleType, link: articleLink(ctx, a.id) })) },
      };
    },
    summary: (input) => `Gathered triage signals for ${input.ticket}`,
  }),

  define({
    name: 'summarize_ticket',
    toolset: 'tickets',
    description: 'The material for a summary of one ticket: its details, SLA state and the last 12 timeline entries, plus a rule-based summary with key facts and next steps. Write the summary from it.',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['tickets:read'],
    portal: ['portal:tickets'],
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const d = await getTicket(ctx, t.id);
      const tl = await timeline(ctx, t.id);
      const items = isCustomerUser(ctx) ? tl.items.filter((i) => !i.isInternal) : tl.items;
      const rule = _internal.fallbackSummary(d, items);
      return { ticket: compactDetail(ctx, d), timeline: compactTimeline(items, 12), ruleSummary: rule.summary, keyFacts: rule.keyFacts, nextSteps: rule.nextSteps };
    },
    summary: (input) => `Read ticket ${input.ticket} for a summary`,
  }),

  define({
    name: 'resolution_ideas',
    toolset: 'triage',
    description: 'Material for resolution suggestions: similar resolved tickets with their resolution notes and the best-matching knowledge articles (with bodies). Propose steps from it and cite the source ticket or article.',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const sim = await similarTickets(ctx, t.id);
      const resolved = sim.items.filter((x) => x.resolutionNotes && x.resolutionNotes.trim().length > 10).slice(0, 5).map((x) => ({ number: x.number, title: x.title, resolutionNotes: trunc(x.resolutionNotes, 800), link: ticketLink(ctx, x.id) }));
      const kb = await kbSuggest(ctx, { q: t.title, customerId: t.customerId, serviceId: t.serviceId ?? undefined, limit: 4 });
      const articles: Record<string, unknown>[] = [];
      for (const a of kb.items.slice(0, 3)) {
        const full = await getArticle(ctx, a.id, { noView: true });
        articles.push({ number: a.number, title: a.title, summary: a.summary, body: trunc(full.body, 1500), link: articleLink(ctx, a.id) });
      }
      return { ticket: t.number, title: t.title, resolvedLookAlikes: resolved, articles };
    },
    summary: (input, result) => `Collected resolution material for ${input.ticket} (${(result as { resolvedLookAlikes: unknown[] }).resolvedLookAlikes.length} tickets, ${(result as { articles: unknown[] }).articles.length} articles)`,
  }),

  define({
    name: 'draft_update',
    toolset: 'triage',
    description: 'Material for a customer-facing update (or a major-incident stakeholder update): the ticket state, the requester\'s first name, the latest public replies and the internal progress notes. Write the update from it in the requested tone, then offer add_comment (or post_major_update) with the final text.',
    inputSchema: z.object({ ticket: ticketRef, kind: z.enum(['customer', 'major']).optional().describe('customer (default): a reply on the ticket; major: a stakeholder update of a major incident'), tone: z.enum(['neutral', 'formal', 'friendly', 'apologetic']).optional() }),
    requires: ['tickets:comment'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const d = await getTicket(ctx, t.id);
      const tl = await timeline(ctx, t.id);
      const comments = tl.items.filter((i) => i.kind === 'comment');
      const base = { ticket: compactDetail(ctx, d), requesterFirstName: firstName(d.requester?.name ?? d.requesterContact?.name), tone: input.tone ?? 'neutral', author: ctx.user.name, latestPublicReplies: compactTimeline(comments.filter((i) => !i.isInternal).slice(-2), 2), internalProgressNotes: compactTimeline(comments.filter((i) => i.isInternal).slice(-3), 3) };
      if (input.kind !== 'major') return { kind: 'customer', ...base, guidance: 'Plain text, 60-140 words, greet by first name when known, state the status in plain language, what has been done, what happens next, close with the ticket number. Never promise times that are not in the data.' };
      const m = await getMajor(ctx, t.id);
      const previous = m.updates.filter((u) => u.kind === 'stakeholder').slice(0, 2).map((u) => ({ at: iso(u.createdAt), body: trunc(u.body, 400) }));
      return { kind: 'major', ...base, affectedCis: d.cis.map((c) => c.name).slice(0, 10), childIncidents: m.children.length, declaredAt: iso(m.record?.declaredAt), updateNumber: m.updates.filter((u) => u.kind === 'stakeholder').length + 1, nextUpdateDueAt: iso(m.record?.nextUpdateDueAt), previousUpdates: previous, guidance: 'Plain language for customers, no internal names or tooling, what is affected, what is being done, when the next update comes; 50-120 words. Never invent times or root causes.' };
    },
    summary: (input) => `Collected material for a ${input.kind === 'major' ? 'stakeholder' : 'customer'} update on ${input.ticket}`,
  }),

  define({
    name: 'apply_triage',
    toolset: 'triage',
    description: 'Commit a triage decision on one ticket in one step: classification (category, subcategory, impact, urgency, optionally priority), owner (team and/or engineer), a duplicate link and a work note citing the knowledge article used. Every part is optional; the preview lists each change.',
    inputSchema: z.object({
      ticket: ticketRef,
      category: z.string().max(80).optional(),
      subcategory: z.string().max(80).optional(),
      impact: z.string().max(40).optional(),
      urgency: z.string().max(40).optional(),
      priority: z.string().max(40).optional().describe('Only when the user asked for a specific priority'),
      team: z.string().max(200).optional(),
      assignee: z.string().max(200).optional().describe('"me", an engineer name or email'),
      duplicateOf: ticketRef.optional().describe('Link this ticket as a duplicate of that one'),
      article: z.string().max(200).optional().describe('Knowledge article number to cite in a work note'),
      note: z.string().max(2000).optional().describe('Work note text (internal)'),
    }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const plan = await triagePlan(ctx, t, input);
      const done: string[] = [];
      if (Object.keys(plan.patch).length) {
        await updateTicket(ctx, t.id, plan.patch as never);
        done.push('classification');
      }
      if (plan.team || plan.engineer) {
        ctx.require('tickets:assign', t.customerId);
        await assignTicket(ctx, t.id, { assigneeId: plan.engineer?.id, teamId: plan.team?.id, autoProgress: true, comment: null });
        done.push('assignment');
      }
      if (plan.duplicate) {
        await addLink(ctx, t.id, { targetTicketId: plan.duplicate.id, linkType: 'duplicate_of' });
        done.push('duplicate link');
      }
      if (plan.note) {
        ctx.require('tickets:work_notes', t.customerId);
        await addComment(ctx, t.id, { kind: 'work_note', body: plan.note });
        done.push('work note');
      }
      return { ticket: t.number, applied: done, changes: plan.lines, link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => `Applied triage to ${input.ticket}: ${((result as { changes?: string[] }).changes ?? []).join('; ') || 'nothing to change'}`,
    preview: async (ctx, input): Promise<PreviewDetail> => {
      const t = await resolveTicket(ctx, input.ticket);
      const plan = await triagePlan(ctx, t, input);
      if (!plan.lines.length) throw new ValidationError('Nothing to apply: give at least one classification value, an owner, a duplicate or a note');
      return { text: `Triage ${short(t)}: ${plan.lines.join('; ')}`, lines: plan.lines };
    },
  }),
];

type TriageInput = { category?: string; subcategory?: string; impact?: string; urgency?: string; priority?: string; team?: string; assignee?: string; duplicateOf?: string; article?: string; note?: string };
async function triagePlan(ctx: Ctx, t: TicketRow, input: TriageInput) {
  const patch: Record<string, unknown> = {};
  const lines: string[] = [];
  const set = async (field: string, type: string, ref: string | undefined, label: string) => {
    if (!ref) return;
    const o = (await resolveOption(ctx, type, ref))!;
    patch[field] = o.id;
    lines.push(`${label} → ${o.label}`);
  };
  await set('categoryId', 'ticket_category', input.category, 'category');
  await set('subcategoryId', 'ticket_subcategory', input.subcategory, 'subcategory');
  await set('impactId', 'ticket_impact', input.impact, 'impact');
  await set('urgencyId', 'ticket_urgency', input.urgency, 'urgency');
  await set('priorityId', 'ticket_priority', input.priority, 'priority');
  const team = await resolveTeam(ctx, input.team);
  const engineer = await resolveEngineer(ctx, input.assignee);
  if (team || engineer) lines.push(`owner → ${[engineer?.name, team?.name].filter(Boolean).join(' / ')}`);
  const duplicate = input.duplicateOf ? await resolveTicket(ctx, input.duplicateOf) : null;
  if (duplicate) {
    if (duplicate.id === t.id) throw new ValidationError('A ticket cannot be a duplicate of itself');
    lines.push(`link as duplicate of ${duplicate.number}`);
  }
  let note = input.note?.trim() || '';
  if (input.article) {
    const a = await resolveArticle(ctx, input.article);
    note = `${note ? `${note}\n\n` : ''}Knowledge: ${a.number} ${a.title} (${articleLink(ctx, a.id)})`;
  }
  if (note) lines.push(`work note: "${trunc(note.replace(/\s+/g, ' '), 100)}"`);
  return { patch, lines, team, engineer, duplicate, note: note || null };
}
