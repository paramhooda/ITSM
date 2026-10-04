import { z } from 'zod';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { createTicket } from '@/modules/tickets/service';
import type { CreateTicketInput } from '@/modules/tickets/schemas';
import { listTemplates, riskQuestionnaire, assessRisk, assertWindowAllowed, previewConflicts, listMeetings, getMeeting, cabQueue, addItem, calendar, plannedChangeState, type PlannedState } from '@/modules/changes/service';
import { scoreChange, type RiskQuestion } from '@/modules/changes/risk';
import { windowOf } from '@/modules/changes/conflicts';
import { portalPlannedChanges } from '@/modules/portal/service';
import { define } from './types';
import { ticketRef } from './core';
import { isCustomerUser, ticketLink, iso, trunc, resolveTicket, resolveCustomerId, resolveEngineer, resolveSite, resolveCi, parseWhen, forCustomer, customerName, resolveChangeTemplate, resolveCabMeeting } from '../helpers';

/**
 * Change management tools: the standard change catalog and raising from it,
 * the CAB agenda and queue, the risk questionnaire, and the planned changes a
 * customer sees. Every tool runs through the same service functions as the
 * pages, so permissions, the blackout refusal and the assessment gate apply.
 */

type ChangeType = 'standard' | 'normal' | 'emergency';
const CATALOG_LINK = '/operations/change-catalog';
const CAB_LINK = '/operations/cab';
const PLANNED_STATES = ['upcoming', 'in_progress', 'past', 'all'] as const;

// ---------------------------------------------------------------- raise from a template

async function resolveRaise(ctx: Ctx, input: { template: string; customer: string; scheduledStart: string; scheduledEnd?: string; title?: string; site?: string; cis?: string[]; assignee?: string }) {
  const template = await resolveChangeTemplate(ctx, input.template);
  const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
  if (template.customerIds.length && !template.customerIds.includes(customerId)) throw new ValidationError(`Template "${template.name}" is not offered to this customer`);
  const start = parseWhen(input.scheduledStart, 'window start')!;
  const end = parseWhen(input.scheduledEnd, 'window end');
  if (end && end.getTime() <= start.getTime()) throw new ValidationError('The window must end after it starts');
  const site = await resolveSite(ctx, customerId, input.site);
  const ciIds: string[] = [];
  for (const ref of input.cis ?? []) ciIds.push((await resolveCi(ctx, ref, customerId)).id);
  const assignee = await resolveEngineer(ctx, input.assignee);
  const title = (input.title?.trim() || template.titleTemplate || template.name).slice(0, 300);
  // The refusal (blackout, when the setting blocks it) shows before confirmation; everything else is a warning line.
  await assertWindowAllowed(ctx, { customerId, changeType: template.changeType, start, end });
  const { conflicts } = await previewConflicts(ctx, { customerId, scheduledStart: start, scheduledEnd: end ?? undefined, changeType: template.changeType as ChangeType, ciIds, primaryCiId: ciIds[0] ?? null });
  return { template, customerId, customerLabel: await customerName(ctx, customerId), start, end, site, ciIds, assignee, title, conflicts };
}

// ---------------------------------------------------------------- questionnaire answers

/** Maps the model's answers (question key or wording → option key or wording) to the questionnaire's keys. */
function mapAnswers(questions: RiskQuestion[], answers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const norm = (s: string) => s.trim().toLowerCase();
  for (const [k, v] of Object.entries(answers)) {
    const key = norm(k);
    const q = questions.find((x) => x.key.toLowerCase() === key) ?? questions.find((x) => norm(x.question).startsWith(key)) ?? questions.find((x) => norm(x.question).includes(key));
    if (!q) throw new ValidationError(`Unknown risk question "${k}"; the questions are: ${questions.map((x) => `${x.key} (${x.question})`).join('; ')}`);
    const val = norm(v);
    const opt = q.options.find((o) => o.key.toLowerCase() === val) ?? q.options.find((o) => norm(o.label) === val) ?? q.options.find((o) => norm(o.label).startsWith(val)) ?? q.options.find((o) => norm(o.label).includes(val));
    if (!opt) throw new ValidationError(`Unknown answer "${v}" for "${q.question}"; the options are: ${q.options.map((o) => `${o.key} (${o.label})`).join(', ')}`);
    out[q.key] = opt.key;
  }
  return out;
}

const bucketOf = (state: PlannedState, start: Date, end: Date | null, now: Date): 'upcoming' | 'in_progress' | 'past' => (state === 'in_progress' ? 'in_progress' : state === 'implemented' || state === 'cancelled' || windowOf(start, end).end.getTime() <= now.getTime() ? 'past' : 'upcoming');

export const CHANGES: ReturnType<typeof define>[] = [
  define({
    name: 'standard_changes',
    toolset: 'tickets',
    description: 'The standard change catalog: pre-approved, repeatable change templates with their type, risk, category, service, expected downtime, whether approval is skipped and how often each was raised. Use for "which standard changes can I raise", "is there a template for patching", "what is the most used standard change".',
    inputSchema: z.object({
      q: z.string().max(200).optional().describe('Search over the template name, key and description'),
      customer: z.string().max(200).optional().describe('Customer name, code or id: only the templates offered to that organisation'),
      preApprovedOnly: z.boolean().optional().describe('Only templates that skip approval'),
    }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const { items } = await listTemplates(ctx, { customerId, q: input.q, preApproved: input.preApprovedOnly ? true : undefined });
      const top = [...items].sort((a, b) => b.usageCount - a.usageCount)[0];
      const preApproved = items.filter((t) => t.skipApproval).length;
      return {
        items: items.slice(0, 40).map((t) => ({ id: t.id, key: t.key, name: t.name, description: trunc(t.description, 300), changeType: t.changeType, risk: t.riskLabel, category: t.categoryLabel, service: t.serviceName, preApproved: t.skipApproval, downtimeMinutes: t.downtimeExpectedMinutes, usageCount: t.usageCount, usage90d: t.usage90d, lastUsedAt: iso(t.lastUsedAt), link: CATALOG_LINK })),
        facts: [`${items.length} standard change template(s) available${await forCustomer(ctx, customerId)}: ${preApproved} pre-approved; most used: ${top && top.usageCount ? `${top.name} (${top.usageCount} times)` : 'none yet'}`],
        link: CATALOG_LINK,
      };
    },
    summary: (_input, result) => `Listed ${(result as { items: unknown[] }).items.length} standard change template(s)`,
  }),

  define({
    name: 'raise_standard_change',
    toolset: 'tickets',
    description: 'Raise a change from a standard change template for a customer: the template prefills the plans and a pre-approved template needs no approval. Give the template (name or key), the customer, the window start (and end), optionally a title, the site, the affected configuration items and the assignee. Use for "raise the firewall patch for ABC on Saturday 22:00".',
    inputSchema: z.object({
      template: z.string().max(200).describe('Template name or key'),
      customer: z.string().max(200).describe('Customer name, code or id'),
      scheduledStart: z.string().max(40).describe('ISO date-time the window opens'),
      scheduledEnd: z.string().max(40).optional().describe('ISO date-time the window closes (default one hour)'),
      title: z.string().max(300).optional().describe("Title (default the template's title)"),
      site: z.string().max(200).optional().describe('Site name or code of the customer'),
      cis: z.array(z.string().max(200)).max(20).optional().describe('Configuration items touched (names, hostnames or ids); the first one is the primary'),
      assignee: z.string().max(200).optional().describe('Engineer name, email, id or "me"'),
      description: z.string().max(5000).optional().describe("Description (default the template's text)"),
    }),
    requires: ['tickets:create'],
    portal: null,
    action: true,
    tier: 'write',
    invalidates: ['tickets', 'changes'],
    preview: async (ctx, input) => {
      const r = await resolveRaise(ctx, input);
      return {
        text: `Raise the standard change "${r.title}" for ${r.customerLabel} from template "${r.template.name}" (${r.template.changeType}, ${r.template.skipApproval ? 'pre-approved' : 'needs approval'}), window ${iso(r.start)} to ${iso(r.end ?? windowOf(r.start, r.end).end)}${r.assignee ? `, assigned to ${r.assignee.name}` : ''}`,
        lines: r.conflicts.map((c) => `Warning: ${c.text}`),
      };
    },
    run: async (ctx, input) => {
      const r = await resolveRaise(ctx, input);
      const body: CreateTicketInput = { type: 'change', customerId: r.customerId, siteId: r.site?.id ?? null, title: r.title, description: input.description ?? null, changeTemplateId: r.template.id, primaryCiId: r.ciIds[0] ?? null, ciIds: r.ciIds, assigneeId: r.assignee?.id ?? null, change: { scheduledStart: r.start, scheduledEnd: r.end ?? null } };
      const t = await createTicket(ctx, body);
      return { ticket: t.number, id: t.id, title: t.title, customer: r.customerLabel, approvalStatus: t.approvalStatus, template: r.template.name, scheduledStart: iso(r.start), scheduledEnd: iso(r.end), conflicts: r.conflicts.map((c) => c.text), link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => `Raised ${(result as { ticket: string }).ticket} from "${(result as { template: string }).template}"${input.customer ? ` for ${input.customer}` : ''}`,
  }),

  define({
    name: 'cab_agenda',
    toolset: 'approvals',
    description: 'CAB meetings and their agendas: the next meetings (or one meeting by title), each change on the agenda with its window, risk, approval state and the board\'s decision, the minutes of a closed meeting, and the changes awaiting the board that are on no agenda yet. Use for "what is on next week\'s CAB", "what did the CAB decide on CHG-000120", "which changes still need the CAB".',
    inputSchema: z.object({
      meeting: z.string().max(200).optional().describe('One meeting by title or id'),
      status: z.enum(['upcoming', 'closed', 'all']).optional().describe('Which meetings to list (default upcoming)'),
      includeQueue: z.boolean().optional().describe('Also list the changes awaiting the board on no agenda (default yes for upcoming)'),
    }),
    requires: ['tickets:read'],
    anyOf: ['changes:cab', 'changes:approve', 'changes:manage'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const status = input.status ?? 'upcoming';
      const meetings: Awaited<ReturnType<typeof getMeeting>>[] = [];
      if (input.meeting) meetings.push(await getMeeting(ctx, (await resolveCabMeeting(ctx, input.meeting)).id));
      else for (const m of (await listMeetings(ctx, { status, page: 1, pageSize: 5 })).items) meetings.push(await getMeeting(ctx, m.id));
      const includeQueue = input.includeQueue ?? (status === 'upcoming' && !input.meeting);
      const queue = includeQueue ? (await cabQueue(ctx, { limit: 20 })).items : [];
      const count = (m: (typeof meetings)[number], d: string) => m.items.filter((i) => i.decision === d).length;
      return {
        meetings: meetings.map((m) => ({
          meeting: { id: m.id, title: m.title, scheduledAt: iso(m.scheduledAt), status: m.status, chair: m.chairName, location: m.location, attendees: m.attendees.map((a) => a.name), items: m.items.length, pending: m.pending, link: `${CAB_LINK}/${m.id}` },
          agenda: m.items.map((i) => ({ number: i.number, title: i.title, customer: i.customerName, window: i.scheduledStart ? `${iso(i.scheduledStart)} to ${iso(i.scheduledEnd)}` : null, risk: i.riskLevel ?? i.riskLabel, approval: i.approvalStatus, pendingStep: i.pendingApproval?.stepName ?? null, decision: i.decision, decidedBy: i.decidedByName, notes: trunc(i.notes, 200), link: ticketLink(ctx, i.ticketId) })),
          minutes: trunc(m.minutes, 1500),
        })),
        queue: queue.map((q) => ({ number: q.number, title: q.title, customer: q.customerName, window: q.scheduledStart ? `${iso(q.scheduledStart)} to ${iso(q.scheduledEnd)}` : 'no window yet', risk: q.riskLevel ?? q.riskLabel, pendingStep: q.pendingStep?.stepName ?? null, link: ticketLink(ctx, q.ticketId) })),
        facts: [
          `${meetings.length} CAB meeting(s) ${input.meeting ? 'matched' : status}: ${meetings.reduce((n, m) => n + m.pending, 0)} change(s) awaiting a decision${includeQueue ? `; ${queue.length} change(s) awaiting the board on no agenda` : ''}`,
          ...meetings.map((m) => `"${m.title}" on ${iso(m.scheduledAt)} (${m.status}): ${m.items.length} on the agenda, ${count(m, 'approved')} approved, ${count(m, 'rejected')} rejected, ${count(m, 'deferred')} deferred, ${count(m, 'pending')} pending`),
        ],
        link: CAB_LINK,
      };
    },
    summary: (_input, result) => `Read ${(result as { meetings: unknown[] }).meetings.length} CAB meeting(s) and ${(result as { queue: unknown[] }).queue.length} queued change(s)`,
  }),

  define({
    name: 'add_to_cab_agenda',
    toolset: 'approvals',
    description: 'Put a change on the agenda of a CAB meeting (the next scheduled one when no meeting is named), with a note for the board. Use for "add CHG-000120 to Tuesday\'s CAB".',
    inputSchema: z.object({
      ticket: ticketRef,
      meeting: z.string().max(200).optional().describe('Meeting title or id (default the next scheduled meeting)'),
      notes: z.string().max(2000).optional().describe('Note for the board'),
    }),
    requires: ['changes:cab'],
    portal: null,
    action: true,
    tier: 'write',
    invalidates: ['changes', 'tickets'],
    preview: async (ctx, input) => {
      const { t, m } = await resolveAgendaTarget(ctx, input);
      return `Add ${t.number} (${t.title.slice(0, 80)}) to the agenda of "${m.title}" on ${iso(m.scheduledAt)}${input.notes ? ` with the note "${trunc(input.notes, 120)}"` : ''}`;
    },
    run: async (ctx, input) => {
      const { t, m } = await resolveAgendaTarget(ctx, input);
      const view = await addItem(ctx, m.id, { ticketId: t.id, notes: input.notes ?? null });
      const position = view.items.findIndex((i) => i.ticketId === t.id) + 1;
      return { ticket: t.number, meeting: view.title, scheduledAt: iso(view.scheduledAt), position, items: view.items.length, link: `${CAB_LINK}/${view.id}` };
    },
    summary: (input, result) => `Added ${input.ticket.toUpperCase()} to the agenda of "${(result as { meeting: string }).meeting}"`,
  }),

  define({
    name: 'assess_change_risk',
    toolset: 'tickets',
    description: 'Score a change with the risk questionnaire from the answers given (question key or wording → option key or wording) and write the level on the change; the raiser, the assignee or a change manager may do it. Call with empty answers to list the questions and the thresholds without writing anything. Use for "assess CHG-000120: everyone affected, full outage, tested backout, done before, off hours, shared component".',
    inputSchema: z.object({
      ticket: ticketRef,
      answers: z.record(z.string().max(60), z.string().max(160)).describe('Question key or wording → option key or wording; {} lists the questions'),
    }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    tier: 'write',
    invalidates: ['tickets', 'changes'],
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      if (t.type !== 'change') throw new ValidationError(`${t.number} is not a change`);
      const { questions, thresholds } = await riskQuestionnaire(ctx);
      if (!Object.keys(input.answers).length) return { text: `List the ${questions.length} risk question(s) and the thresholds for ${t.number} (nothing is written)` };
      const r = scoreChange(questions, mapAnswers(questions, input.answers), thresholds);
      return { text: `Assess ${t.number} as ${r.level} (${r.score}/100) from ${r.answered} answer(s)${r.missing.length ? `; unanswered: ${r.missing.join(', ')}` : ''}`, lines: r.drivers.map((d) => `${d.question}: ${d.option} (${d.points} pts)`) };
    },
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      if (t.type !== 'change') throw new ValidationError(`${t.number} is not a change`);
      const qn = await riskQuestionnaire(ctx);
      if (!Object.keys(input.answers).length) {
        return { ticket: t.number, questions: qn.questions.map((q) => ({ key: q.key, question: q.question, hint: q.hint, weight: q.weight, options: q.options })), thresholds: qn.thresholds, facts: [`${qn.questions.length} question(s) in the risk questionnaire; medium from ${qn.thresholds.medium}, high from ${qn.thresholds.high}`], link: ticketLink(ctx, t.id) };
      }
      const r = await assessRisk(ctx, t.id, mapAnswers(qn.questions, input.answers));
      return { ticket: t.number, score: r.score, level: r.level, answered: r.answered, drivers: r.drivers, missing: r.missing, facts: [`${t.number} assessed as ${r.level} risk (${r.score}/100) from ${r.answered} answer(s)${r.missing.length ? `; unanswered: ${r.missing.join(', ')}` : ''}`], link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => {
      const r = result as { level?: string; score?: number; questions?: unknown[] };
      return r.questions ? `Listed ${r.questions.length} risk question(s) for ${input.ticket.toUpperCase()}` : `Assessed ${input.ticket.toUpperCase()} as ${r.level} risk (${r.score}/100)`;
    },
  }),

  define({
    name: 'planned_changes',
    toolset: 'tickets',
    description: 'Changes planned on a customer\'s services: the window, the state (planned, approved, in progress, implemented, cancelled), the expected downtime and the services touched; for customer users their own organisation only. Use for "what changes are planned for us", "is anything scheduled on ABC\'s network this weekend".',
    inputSchema: z.object({
      customer: z.string().max(200).optional().describe('Customer name, code or id (staff only; ignored for customer users)'),
      state: z.enum(PLANNED_STATES).optional().describe('upcoming (default), in_progress, past (last 30 days) or all'),
      days: z.number().int().min(1).max(120).optional().describe('How many days ahead (default 30)'),
    }),
    requires: ['tickets:read'],
    portal: ['portal:status'],
    action: false,
    run: async (ctx, input) => {
      const state = input.state ?? 'upcoming';
      if (isCustomerUser(ctx)) {
        // The customer input is ignored on purpose: the portal pins the organisation.
        const res = await portalPlannedChanges(ctx, { state });
        return {
          state,
          window: { from: iso(res.window.from), to: iso(res.window.to) },
          counts: res.counts,
          items: res.items.slice(0, 40).map((c) => ({ number: c.number, title: c.title, state: c.state, outcome: c.outcome, changeType: c.changeType, scheduledStart: iso(c.scheduledStart), scheduledEnd: iso(c.scheduledEnd), downtimeMinutes: c.downtimeExpectedMinutes, service: c.service?.name ?? null, businessServices: c.businessServices.map((b) => b.name), link: ticketLink(ctx, c.id) })),
          facts: [`${res.items.length} change(s) planned for your organisation (${state}): ${res.counts.inProgress} in progress now, ${res.counts.upcoming} upcoming, ${res.counts.past} completed or cancelled in the last 30 days`],
          link: '/portal/changes',
        };
      }
      const customerId = await resolveCustomerId(ctx, input.customer);
      const now = new Date();
      const days = Math.min(input.days ?? 30, state === 'upcoming' || state === 'in_progress' ? 120 : 90);
      const from = state === 'upcoming' ? now : new Date(now.getTime() - 30 * 86_400_000);
      const to = new Date(now.getTime() + days * 86_400_000);
      const cal = await calendar(ctx, { from, to, customerId, blackouts: false });
      const ids = cal.items.map((c) => c.ticketId);
      const services = ids.length ? await ctx.tx.select({ id: schema.tickets.id, name: schema.services.name }).from(schema.tickets).innerJoin(schema.services, eq(schema.services.id, schema.tickets.serviceId)).where(inArray(schema.tickets.id, ids)) : [];
      const bs = ids.length ? await ctx.tx.select({ ticketId: schema.ticketCis.ticketId, name: schema.cis.name }).from(schema.ticketCis).innerJoin(schema.cis, eq(schema.cis.id, schema.ticketCis.ciId)).innerJoin(schema.ciTypes, eq(schema.ciTypes.id, schema.cis.typeId)).where(and(inArray(schema.ticketCis.ticketId, ids), eq(schema.ciTypes.key, 'business_service'))) : [];
      const all = cal.items.map((c) => {
        const { state: s, outcome } = plannedChangeState({ statusKey: c.status.key, statusCategory: c.status.category, approvalStatus: c.approvalStatus, start: c.scheduledStart, end: c.scheduledEnd }, now);
        return { bucket: bucketOf(s, c.scheduledStart, c.scheduledEnd, now), item: { number: c.number, title: c.title, customer: c.customerName, state: s, outcome, changeType: c.changeType, scheduledStart: iso(c.scheduledStart), scheduledEnd: iso(c.scheduledEnd), downtimeMinutes: c.downtimeExpectedMinutes, service: services.find((x) => x.id === c.ticketId)?.name ?? null, businessServices: bs.filter((x) => x.ticketId === c.ticketId).map((x) => x.name), link: ticketLink(ctx, c.ticketId) } };
      });
      const counts = { upcoming: all.filter((x) => x.bucket === 'upcoming').length, inProgress: all.filter((x) => x.bucket === 'in_progress').length, past: all.filter((x) => x.bucket === 'past').length };
      const items = (state === 'all' ? all : all.filter((x) => x.bucket === state)).map((x) => x.item);
      return {
        state,
        window: { from: iso(from), to: iso(to) },
        counts,
        items: items.slice(0, 40),
        facts: [`${items.length} change(s) planned${await forCustomer(ctx, customerId)} (${state}, ${iso(from)} to ${iso(to)}): ${counts.inProgress} in progress now, ${counts.upcoming} upcoming`],
        link: '/operations/change-calendar',
      };
    },
    summary: (input, result) => `Listed ${(result as { items: unknown[] }).items.length} planned change(s)${input.state ? ` (${input.state})` : ''}`,
  }),
];

/** The change and the meeting an agenda action is about: the named meeting, or the next scheduled one. */
async function resolveAgendaTarget(ctx: Ctx, input: { ticket: string; meeting?: string }) {
  const t = await resolveTicket(ctx, input.ticket);
  if (t.type !== 'change') throw new ValidationError(`${t.number} is not a change`);
  if (input.meeting) return { t, m: await resolveCabMeeting(ctx, input.meeting) };
  const m = schema.cabMeetings;
  const [next] = await ctx.tx.select().from(m).where(and(inArray(m.status, ['scheduled', 'in_progress']), gte(m.scheduledAt, new Date(Date.now() - 86_400_000)))).orderBy(asc(m.scheduledAt)).limit(1);
  if (!next) throw new ValidationError('No upcoming CAB meeting; create one first');
  return { t, m: next };
}
