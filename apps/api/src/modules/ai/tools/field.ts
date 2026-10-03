import { z } from 'zod';
import { eq, and, inArray, gte, lte, asc } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { listVisits, getVisit, createVisit, scheduleVisit, rescheduleVisit, cancelVisit, addNote, engineerWorkload } from '@/modules/field/service';
import { listPrograms, listOccurrences, scheduleOccurrence, pmSummary } from '@/modules/pm/service';
import { portalMaintenance, acknowledgePortalVisit } from '@/modules/portal/service';
import { define, type PreviewDetail } from './types';
import { ticketRef } from './core';
import { isCustomerUser, ticketLink, trunc, iso, dayStr, parseWhen, resolveCustomerId, resolveVisit, resolveTicket, resolveSite, resolveService, resolveContract, resolveEngineer, resolveTeam, resolveOption, customerName } from '../helpers';

/** Field service tools: visits, the engineer calendar, preventive maintenance (customer users see their own visits and maintenance). */

const visitLink = (ctx: Ctx, id: string) => (isCustomerUser(ctx) ? '/portal/maintenance' : `/field/${id}`);
const visitRef = z.string().max(80).describe('Visit number (e.g. FSV-000123) or id');
const OPEN = ['requested', 'scheduled', 'in_progress'];

type VisitListItem = { id: string; number: string; title: string; status: string; customerId: string; customerName?: string | null; siteName?: string | null; engineerName?: string | null; typeLabel?: string | null; ticketNumber?: string | null; scheduledStart: Date | null; scheduledEnd: Date | null; actualStart: Date | null; actualEnd: Date | null; purpose?: string | null };
const compactVisit = (ctx: Ctx, v: VisitListItem) => ({ number: v.number, title: v.title, status: v.status, customer: v.customerName ?? null, site: v.siteName ?? null, engineer: v.engineerName ?? null, type: v.typeLabel ?? null, ticket: v.ticketNumber ?? null, scheduledStart: iso(v.scheduledStart), scheduledEnd: iso(v.scheduledEnd), actualStart: iso(v.actualStart), actualEnd: iso(v.actualEnd), link: visitLink(ctx, v.id) });

async function findOccurrence(ctx: Ctx, input: { occurrence?: string; program?: string; customer?: string; plannedDate?: string }) {
  if (input.occurrence) {
    const res = await listOccurrences(ctx, { page: 1, pageSize: 1, q: input.occurrence } as never);
    const item = (res.items as unknown as { id: string }[]).find((o) => o.id === input.occurrence);
    if (item) return item as unknown as OccurrenceItem;
  }
  if (!input.program) throw new ValidationError('Name the maintenance program (or give the occurrence id)');
  const customerId = await resolveCustomerId(ctx, input.customer);
  const programs = await listPrograms(ctx, { page: 1, pageSize: 5, q: input.program, customerId, isActive: true } as never);
  const r = input.program.toLowerCase();
  const exact = programs.items.filter((p) => p.name.toLowerCase() === r);
  const pick = exact.length === 1 ? exact : programs.items;
  if (!pick.length) throw new ValidationError(`No maintenance program matching "${input.program}"`);
  if (pick.length > 1) throw new ValidationError(`Program "${input.program}" is ambiguous: ${pick.map((p) => `${p.name} (${(p as { customerName?: string }).customerName ?? ''})`).join(', ')}`);
  const program = pick[0]!;
  const occ = await listOccurrences(ctx, { page: 1, pageSize: 20, programId: program.id, status: 'planned,rescheduled', from: input.plannedDate ?? dayStr(new Date(Date.now() - 30 * 86_400_000)), sort: 'plannedDate', order: 'asc' } as never);
  const items = occ.items as unknown as OccurrenceItem[];
  const hit = input.plannedDate ? items.find((o) => o.plannedDate === input.plannedDate) : items[0];
  if (!hit) throw new ValidationError(`No planned occurrence of "${program.name}"${input.plannedDate ? ` on ${input.plannedDate}` : ''}. Planned: ${items.map((o) => o.plannedDate).join(', ') || 'none'}`);
  return hit;
}
type OccurrenceItem = { id: string; programId: string; programName?: string; plannedDate: string; scheduledDate: string | null; status: string; customerId: string; siteName?: string | null };

export const FIELD: ReturnType<typeof define>[] = [
  define({
    name: 'list_visits',
    toolset: 'field',
    description: 'Field visits by customer, status, engineer, date range or free text (default: open visits, soonest first).',
    inputSchema: z.object({ customer: z.string().max(200).optional(), status: z.array(z.enum(['requested', 'scheduled', 'in_progress', 'completed', 'cancelled'])).max(5).optional(), engineer: z.string().max(200).optional().describe('"me", a name or an email'), from: z.string().max(30).optional(), to: z.string().max(30).optional(), q: z.string().max(200).optional(), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['field:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const engineer = isCustomerUser(ctx) ? null : await resolveEngineer(ctx, input.engineer);
      const statuses = input.status?.length ? input.status : OPEN;
      const res = await listVisits(ctx, { page: 1, pageSize: input.limit ?? 20, customerId, status: statuses.join(','), engineerId: engineer?.id, from: input.from, to: input.to, q: input.q, sort: 'scheduledStart', order: 'asc' } as never);
      const items = res.items as unknown as VisitListItem[];
      return { total: res.total, facts: [`${res.total} visit(s) with status ${statuses.join('/')}${input.customer ? ` for ${input.customer}` : ''}${engineer ? ` assigned to ${engineer.name}` : ''}`], items: items.map((v) => compactVisit(ctx, v)) };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} field visits`,
  }),

  define({
    name: 'get_visit',
    toolset: 'field',
    description: 'One field visit: purpose, schedule, engineer, checklist progress, parts, notes, linked ticket and maintenance occurrence, customer acknowledgement.',
    inputSchema: z.object({ visit: visitRef }),
    requires: ['field:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const ref = await resolveVisit(ctx, input.visit);
      const v = (await getVisit(ctx, ref.id)) as unknown as VisitListItem & Record<string, unknown> & { notes: { body: string; isInternal: boolean; authorName: string | null; createdAt: Date }[]; parts: { name: string; quantity: number; partNumber: string | null }[]; ticket: { id: string; number: string; title: string; status: string | null } | null; pmOccurrence: { programName: string; plannedDate: string; status: string } | null; checklist?: { item?: string; label?: string; done?: boolean; checked?: boolean }[] };
      const checklist = Array.isArray(v.checklist) ? v.checklist : [];
      return {
        ...compactVisit(ctx, v),
        purpose: trunc(v.purpose, 800),
        workSummary: trunc(v.workSummary as string | null, 1200),
        recommendations: trunc(v.recommendations as string | null, 600),
        checklist: { total: checklist.length, done: checklist.filter((c) => c.done || c.checked).length },
        parts: v.parts.slice(0, 15).map((p) => ({ name: p.name, quantity: p.quantity, partNumber: p.partNumber })),
        notes: v.notes.slice(-5).map((n) => ({ at: iso(n.createdAt), by: n.authorName, internal: n.isInternal, body: trunc(n.body, 500) })),
        ticket: v.ticket ? { number: v.ticket.number, title: v.ticket.title, status: v.ticket.status, link: ticketLink(ctx, v.ticket.id) } : null,
        maintenance: v.pmOccurrence ? { program: v.pmOccurrence.programName, plannedDate: v.pmOccurrence.plannedDate, status: v.pmOccurrence.status } : null,
        acknowledged: !!v.customerAckAt,
        acknowledgedBy: (v.customerAckName as string | null) ?? null,
        rating: (v.customerRating as number | null) ?? null,
      };
    },
    summary: (input) => `Read visit ${input.visit}`,
  }),

  define({
    name: 'engineer_workload',
    toolset: 'field',
    description: 'Field engineers\' scheduled visits per day over a date range (who is free, who is overloaded).',
    inputSchema: z.object({ from: z.string().max(30).optional().describe('ISO date, default today'), to: z.string().max(30).optional().describe('ISO date, default +7 days'), team: z.string().max(200).optional() }),
    requires: ['field:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const from = input.from ?? dayStr(new Date());
      const to = input.to ?? dayStr(new Date(Date.now() + 7 * 86_400_000));
      const team = await resolveTeam(ctx, input.team);
      const res = await engineerWorkload(ctx, { from, to, teamId: team?.id });
      return { from, to, facts: [`${res.engineers.length} engineer(s) with visits between ${from} and ${to}`], engineers: res.engineers.map((e) => ({ engineer: e.engineerName, visits: e.total, byDay: e.days })) };
    },
    summary: (_i, result) => `Read field workload (${(result as { engineers: unknown[] }).engineers.length} engineers)`,
  }),

  define({
    name: 'upcoming_maintenance',
    toolset: 'field',
    description: 'Planned preventive-maintenance occurrences and scheduled field visits for a customer in the next N days (default 60).',
    inputSchema: z.object({ customer: z.string().max(200).optional(), days: z.number().int().min(1).max(365).optional() }),
    requires: ['pm:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const days = input.days ?? 60;
      if (isCustomerUser(ctx)) {
        const m = await portalMaintenance(ctx, { pastDays: 0, futureDays: days });
        const occ = m.upcoming.occurrences as unknown as { programName: string; plannedDate: string; scheduledDate: string | null; status: string; siteName: string | null; engineerName: string | null }[];
        const visits = m.upcoming.visits as unknown as { number: string; title: string; status: string; scheduledStart: Date | null; siteName: string | null; engineerName: string | null }[];
        return { days, facts: [`${occ.length} maintenance occurrence(s) and ${visits.length} visit(s) in the next ${days} days`], maintenance: occ.slice(0, 20).map((o) => ({ program: o.programName, plannedDate: o.plannedDate, scheduledDate: o.scheduledDate, status: o.status, site: o.siteName, engineer: o.engineerName })), visits: visits.slice(0, 20).map((v) => ({ number: v.number, title: v.title, status: v.status, scheduledStart: iso(v.scheduledStart), site: v.siteName, engineer: v.engineerName, link: '/portal/maintenance' })), link: '/portal/maintenance' };
      }
      const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
      const today = dayStr(new Date());
      const until = new Date(Date.now() + days * 86_400_000);
      const pm = await ctx.tx
        .select({ id: schema.pmOccurrences.id, program: schema.pmPrograms.name, plannedDate: schema.pmOccurrences.plannedDate, scheduledDate: schema.pmOccurrences.scheduledDate, status: schema.pmOccurrences.status, site: schema.sites.name, engineer: schema.users.name })
        .from(schema.pmOccurrences)
        .innerJoin(schema.pmPrograms, eq(schema.pmPrograms.id, schema.pmOccurrences.programId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.pmPrograms.siteId))
        .leftJoin(schema.users, eq(schema.users.id, schema.pmOccurrences.engineerId))
        .where(and(eq(schema.pmOccurrences.customerId, customerId), inArray(schema.pmOccurrences.status, ['planned', 'scheduled', 'rescheduled']), gte(schema.pmOccurrences.plannedDate, today), lte(schema.pmOccurrences.plannedDate, dayStr(until))))
        .orderBy(asc(schema.pmOccurrences.plannedDate))
        .limit(20);
      const visits = await ctx.tx
        .select({ id: schema.fieldVisits.id, number: schema.fieldVisits.number, title: schema.fieldVisits.title, status: schema.fieldVisits.status, scheduledStart: schema.fieldVisits.scheduledStart, scheduledEnd: schema.fieldVisits.scheduledEnd, site: schema.sites.name, engineer: schema.users.name })
        .from(schema.fieldVisits)
        .leftJoin(schema.sites, eq(schema.sites.id, schema.fieldVisits.siteId))
        .leftJoin(schema.users, eq(schema.users.id, schema.fieldVisits.engineerId))
        .where(and(eq(schema.fieldVisits.customerId, customerId), inArray(schema.fieldVisits.status, OPEN), gte(schema.fieldVisits.scheduledStart, new Date(Date.now() - 86_400_000)), lte(schema.fieldVisits.scheduledStart, until)))
        .orderBy(asc(schema.fieldVisits.scheduledStart))
        .limit(20);
      return { days, facts: [`${pm.length} maintenance occurrence(s) and ${visits.length} visit(s) in the next ${days} days for ${await customerName(ctx, customerId)}`], maintenance: pm.map((o) => ({ ...o, link: `/pm/occurrences/${o.id}` })), visits: visits.map((v) => ({ ...v, scheduledStart: iso(v.scheduledStart), scheduledEnd: iso(v.scheduledEnd), link: `/field/${v.id}` })) };
    },
    summary: (input, result) => `Read upcoming maintenance (${(result as { maintenance: unknown[] }).maintenance.length} PM, ${(result as { visits: unknown[] }).visits.length} visits) for the next ${input.days ?? 60} days`,
  }),

  define({
    name: 'pm_programs',
    toolset: 'field',
    description: 'Preventive-maintenance programs (frequency, site, assigned team or engineer) with the completion figures and the overdue occurrences.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), q: z.string().max(200).optional(), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['pm:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const res = await listPrograms(ctx, { page: 1, pageSize: input.limit ?? 20, customerId, q: input.q, isActive: true, sort: 'name', order: 'asc' } as never);
      const items = res.items as unknown as Record<string, unknown>[];
      const summary = await pmSummary(ctx, { customerId });
      const keys = ['name', 'customerName', 'siteName', 'serviceName', 'frequency', 'startDate', 'endDate', 'requiresSiteVisit', 'assignedTeamName', 'assignedEngineerName', 'checklistCount', 'nextPlannedDate', 'nextDue', 'lastCompletedAt', 'planned', 'scheduled', 'completed', 'missed', 'overdue'];
      return {
        total: res.total,
        facts: [`${res.total} active maintenance program(s)${input.customer ? ` for ${input.customer}` : ''}; ${summary.counts.completed ?? 0} completed and ${summary.overdue.length} overdue occurrence(s) in the period`],
        programs: items.map((p) => ({ ...Object.fromEntries(keys.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])), ...(isCustomerUser(ctx) ? {} : { link: `/pm/programs/${p.id}` }) })),
        summary: { counts: summary.counts, onTimePct: summary.onTimePct, completionPct: summary.completionPct },
        overdue: (summary.overdue as unknown as Record<string, unknown>[]).slice(0, 10).map((o) => ({ program: o.programName, plannedDate: o.plannedDate, status: o.status, site: o.siteName })),
      };
    },
    summary: (_i, result) => `Listed ${(result as { programs: unknown[] }).programs.length} maintenance programs`,
  }),

  define({
    name: 'create_visit',
    toolset: 'field',
    description: 'Create a field visit for a customer (optionally for a ticket), with a type, purpose and, if known, the schedule and engineer.',
    inputSchema: z.object({ customer: z.string().max(200), site: z.string().max(200).optional(), ticket: ticketRef.optional(), type: z.string().max(80).optional().describe('Visit type (e.g. break-fix, installation, preventive maintenance); default: the first active type'), title: z.string().min(3).max(300), purpose: z.string().max(4000).optional(), start: z.string().max(40).optional().describe('ISO date-time'), end: z.string().max(40).optional(), engineer: z.string().max(200).optional(), team: z.string().max(200).optional(), service: z.string().max(200).optional(), contract: z.string().max(80).optional() }),
    requires: ['field:manage'],
    portal: null,
    action: true,
    invalidates: ['visits'],
    run: async (ctx, input) => {
      const p = await visitPlan(ctx, input);
      const v = await createVisit(ctx, { customerId: p.customerId, siteId: p.site?.id ?? null, ticketId: p.ticket?.id ?? null, contractId: p.contract?.id ?? null, serviceId: p.service?.id ?? null, typeId: p.type.id, title: input.title, purpose: input.purpose ?? null, scheduledStart: p.start, scheduledEnd: p.end, engineerId: p.engineer?.id ?? null, teamId: p.team?.id ?? null } as never);
      return { visit: v.number, status: v.status, scheduledStart: iso(v.scheduledStart), link: `/field/${v.id}` };
    },
    summary: (_i, result) => `Created visit ${(result as { visit: string }).visit}`,
    preview: async (ctx, input) => {
      const p = await visitPlan(ctx, input);
      return `Create a ${p.type.label.toLowerCase()} visit "${input.title}" for ${p.customerLabel}${p.site ? ` at ${p.site.name}` : ''}${p.ticket ? ` on ${p.ticket.number}` : ''}${p.start ? `, ${p.start.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ' (unscheduled)'}${p.engineer ? `, engineer ${p.engineer.name}` : p.team ? `, team ${p.team.name}` : ''}`;
    },
  }),

  define({
    name: 'schedule_visit',
    toolset: 'field',
    description: 'Schedule a requested visit (engineer and start time), or reschedule a scheduled one (a reason is required then). The engineer and the customer are notified.',
    inputSchema: z.object({ visit: visitRef, start: z.string().max(40).describe('ISO date-time'), end: z.string().max(40).optional(), engineer: z.string().max(200).optional().describe('Required when the visit is not scheduled yet'), reason: z.string().max(1000).optional().describe('Required when moving an already scheduled visit') }),
    requires: ['field:manage'],
    portal: null,
    action: true,
    invalidates: ['visits'],
    run: async (ctx, input) => {
      const v = await resolveVisit(ctx, input.visit);
      const start = parseWhen(input.start, 'start time')!;
      const end = parseWhen(input.end, 'end time');
      if (v.status === 'scheduled') {
        if (!input.reason) throw new ValidationError('A reason is required to move a scheduled visit');
        const r = await rescheduleVisit(ctx, v.id, { scheduledStart: start, scheduledEnd: end, reason: input.reason });
        return { visit: r.number, status: r.status, scheduledStart: iso(r.scheduledStart), link: `/field/${r.id}` };
      }
      const engineer = await resolveEngineer(ctx, input.engineer);
      if (!engineer) throw new ValidationError('Name the engineer for this visit');
      const r = await scheduleVisit(ctx, v.id, { scheduledStart: start, scheduledEnd: end, engineerId: engineer.id } as never);
      return { visit: r.number, status: r.status, scheduledStart: iso(r.scheduledStart), engineer: engineer.name, link: `/field/${r.id}` };
    },
    summary: (input, result) => `Scheduled visit ${(result as { visit: string }).visit ?? input.visit} for ${(result as { scheduledStart: string }).scheduledStart ?? input.start}`,
    preview: async (ctx, input) => {
      const v = await resolveVisit(ctx, input.visit);
      const start = parseWhen(input.start, 'start time')!;
      const when = `${start.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      if (v.status === 'scheduled') return `Move visit ${v.number} ("${v.title.slice(0, 60)}") to ${when}${input.reason ? ` because ${input.reason.slice(0, 100)}` : ' (a reason is required)'}; the engineer and the customer are notified`;
      if (!['requested'].includes(v.status)) throw new ValidationError(`Visit ${v.number} is ${v.status.replace('_', ' ')} and cannot be scheduled`);
      const engineer = await resolveEngineer(ctx, input.engineer);
      return `Schedule visit ${v.number} ("${v.title.slice(0, 60)}") for ${when}${engineer ? ` with ${engineer.name}` : ' (an engineer is required)'}; they and the customer are notified`;
    },
  }),

  define({
    name: 'cancel_visit',
    toolset: 'field',
    description: 'Cancel a field visit with a reason (the engineer and the customer are notified).',
    inputSchema: z.object({ visit: visitRef, reason: z.string().min(3).max(1000) }),
    requires: ['field:manage'],
    portal: null,
    action: true,
    tier: 'destructive',
    invalidates: ['visits'],
    run: async (ctx, input) => {
      const v = await resolveVisit(ctx, input.visit);
      const r = await cancelVisit(ctx, v.id, { reason: input.reason });
      return { visit: r.number, status: r.status, link: `/field/${r.id}` };
    },
    summary: (input) => `Cancelled visit ${input.visit}`,
    preview: async (ctx, input): Promise<PreviewDetail> => {
      const v = await resolveVisit(ctx, input.visit);
      if (!OPEN.includes(v.status)) throw new ValidationError(`Visit ${v.number} is already ${v.status}`);
      return { text: `Cancel visit ${v.number} ("${v.title.slice(0, 60)}") because ${input.reason.slice(0, 120)}; the engineer and the customer are notified`, count: 1 };
    },
  }),

  define({
    name: 'add_visit_note',
    toolset: 'field',
    description: 'Add a note to a field visit (staff may mark it internal; customer notes are always visible to the provider).',
    inputSchema: z.object({ visit: visitRef, body: z.string().min(1).max(4000), internal: z.boolean().optional() }),
    requires: ['field:execute'],
    portal: ['portal:access'],
    action: true,
    tier: 'write_low',
    invalidates: ['visits'],
    run: async (ctx, input) => {
      const v = await resolveVisit(ctx, input.visit);
      const n = await addNote(ctx, v.id, { body: input.body, isInternal: isCustomerUser(ctx) ? false : !!input.internal });
      return { visit: v.number, noteId: n.id, link: visitLink(ctx, v.id) };
    },
    summary: (input) => `Added a note to visit ${input.visit}`,
    preview: async (ctx, input) => {
      const v = await resolveVisit(ctx, input.visit);
      return `Add ${input.internal && !isCustomerUser(ctx) ? 'an internal' : 'a'} note to visit ${v.number}: "${trunc(input.body.replace(/\s+/g, ' '), 140)}"`;
    },
  }),

  define({
    name: 'acknowledge_visit',
    toolset: 'field',
    description: 'Acknowledge a completed visit on behalf of the customer, with an optional rating (1-5) and remarks.',
    inputSchema: z.object({ visit: visitRef, rating: z.number().int().min(1).max(5).optional(), notes: z.string().max(2000).optional() }),
    requires: [],
    portalOnly: true,
    portal: ['portal:access'],
    action: true,
    invalidates: ['visits'],
    run: async (ctx, input) => {
      const v = await resolveVisit(ctx, input.visit);
      await acknowledgePortalVisit(ctx, v.id, { name: ctx.user.name, title: null, notes: input.notes ?? null, rating: input.rating ?? null });
      return { visit: v.number, acknowledged: true, link: visitLink(ctx, v.id) };
    },
    summary: (input) => `Acknowledged visit ${input.visit}`,
    preview: async (ctx, input) => {
      const v = await resolveVisit(ctx, input.visit);
      if (v.status !== 'completed') throw new ValidationError(`Visit ${v.number} is ${v.status.replace('_', ' ')}; only completed visits can be acknowledged`);
      return `Acknowledge visit ${v.number} ("${v.title.slice(0, 60)}") as ${ctx.user.name}${input.rating ? ` with a rating of ${input.rating}/5` : ''}${input.notes ? ` and the remark "${trunc(input.notes, 100)}"` : ''}`;
    },
  }),

  define({
    name: 'schedule_pm_occurrence',
    toolset: 'field',
    description: 'Schedule a planned preventive-maintenance occurrence on a date (and time) with an engineer; a field visit is created for it.',
    inputSchema: z.object({ occurrence: z.string().uuid().optional().describe('Occurrence id when known'), program: z.string().max(200).optional().describe('Program name'), customer: z.string().max(200).optional(), plannedDate: z.string().max(10).optional().describe('The planned date of the occurrence to pick (YYYY-MM-DD)'), date: z.string().max(10).describe('Date to schedule (YYYY-MM-DD)'), time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('Local start time HH:MM (default 10:00)'), durationMinutes: z.number().int().min(15).max(1440).optional(), engineer: z.string().max(200).optional(), notes: z.string().max(1000).optional() }),
    requires: ['pm:manage'],
    portal: null,
    action: true,
    invalidates: ['visits'],
    run: async (ctx, input) => {
      const o = await findOccurrence(ctx, input);
      const engineer = await resolveEngineer(ctx, input.engineer);
      const res = (await scheduleOccurrence(ctx, o.id, { scheduledDate: input.date, scheduledTime: input.time, durationMinutes: input.durationMinutes, engineerId: engineer?.id ?? null, createVisit: true, notes: input.notes ?? null })) as unknown as Record<string, unknown>;
      return { program: o.programName ?? input.program, plannedDate: o.plannedDate, scheduledDate: input.date, engineer: engineer?.name ?? null, visit: (res.visitNumber as string | undefined) ?? null, link: `/pm/occurrences/${o.id}` };
    },
    summary: (input, result) => `Scheduled maintenance "${(result as { program: string }).program}" for ${input.date}`,
    preview: async (ctx, input) => {
      const o = await findOccurrence(ctx, input);
      const engineer = await resolveEngineer(ctx, input.engineer);
      return `Schedule the ${o.plannedDate} occurrence of "${o.programName ?? input.program}" for ${input.date} at ${input.time ?? '10:00'}${engineer ? ` with ${engineer.name}` : ''} and create the field visit`;
    },
  }),
];

type VisitInput = { customer: string; site?: string; ticket?: string; type?: string; start?: string; end?: string; engineer?: string; team?: string; service?: string; contract?: string };
async function visitPlan(ctx: Ctx, input: VisitInput) {
  const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
  const customerLabel = await customerName(ctx, customerId);
  const [site, ticket, engineer, team, service, contract] = await Promise.all([resolveSite(ctx, customerId, input.site), input.ticket ? resolveTicket(ctx, input.ticket) : null, resolveEngineer(ctx, input.engineer), resolveTeam(ctx, input.team), resolveService(ctx, input.service), input.contract ? resolveContract(ctx, input.contract) : null]);
  if (ticket && ticket.customerId !== customerId) throw new ValidationError(`${ticket.number} belongs to another customer`);
  let type: { id: string; label: string } | null = await resolveOption(ctx, 'field_visit_type', input.type);
  if (!type) {
    const first = await resolveOption(ctx, 'field_visit_type', 'break').catch(() => null);
    type = first ?? (await ctx.tx.select({ id: schema.configOptions.id, label: schema.configOptions.label }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'field_visit_type'), eq(schema.configOptions.isActive, true))).orderBy(asc(schema.configOptions.sortOrder)).limit(1))[0] ?? null;
    if (!type) throw new ValidationError('No field visit type is configured');
  }
  return { customerId, customerLabel, site, ticket, engineer, team, service, contract, type, start: parseWhen(input.start, 'start time'), end: parseWhen(input.end, 'end time') };
}
