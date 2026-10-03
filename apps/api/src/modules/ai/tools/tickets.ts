import { z } from 'zod';
import { eq, and, or, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { createTicket, getTicket, updateTicket, assignTicket, changeStatus, resolveTicket as resolveTicketSvc, closeTicket, reopenTicket, cancelTicket, escalateTicket, setScope, bulkAction } from '@/modules/tickets/service';
import { listTickets, ticketStats, similarTickets, problemCandidates } from '@/modules/tickets/list';
import { addComment, timeline, addLink, removeLink, setCis, listTasks, createTask, updateTask, deleteTask, listTimeEntries, addTimeEntry, deleteTimeEntry, addWatcher, removeWatcher } from '@/modules/tickets/activity';
import { listForTicket as approvalsForTicket } from '@/modules/tickets/approvals';
import { escalationHistory } from '@/modules/tickets/escalation';
import { scopePreview } from '@/modules/tickets/scope';
import { optionByKey, type TicketRow } from '@/modules/tickets/common';
import { applicableStatuses } from '@/modules/tickets/status';
import { reopenPortalTicket, confirmResolution } from '@/modules/portal/service';
import { engineerDirectory } from '@/modules/iam/service';
import { define, type PreviewDetail } from './types';
import { ticketRef } from './core';
import { isCustomerUser, ticketLink, trunc, iso, listQuery, resolveTicket, resolveCustomerId, resolveOption, resolveService, resolveSite, resolveCi, resolveEngineer, resolveTeam, resolveUser, parseWhen, compactTicket } from '../helpers';

/** Ticket tools: everything the ticket pages can do, each wrapping the same service function the page uses. */

const short = (t: Pick<TicketRow, 'number' | 'title'>) => `${t.number} ("${t.title.slice(0, 80)}")`;

async function resolveStatus(ctx: Ctx, t: TicketRow, ref: string) {
  const statuses = await applicableStatuses(ctx, t.type);
  const r = ref.trim().toLowerCase();
  const to = statuses.find((s) => s.key === r) ?? statuses.find((s) => s.label.toLowerCase() === r) ?? statuses.find((s) => s.label.toLowerCase().startsWith(r));
  if (!to) throw new ValidationError(`Unknown status "${ref}" for ${t.type}. Valid: ${statuses.map((s) => s.key).join(', ')}`);
  return to;
}

async function findTask(ctx: Ctx, ticketId: string, ref: string) {
  const tasks = (await listTasks(ctx, ticketId)) as { id: string; title: string; status: string }[];
  const r = ref.trim().toLowerCase();
  const hit = tasks.find((t) => t.id === ref) ?? tasks.find((t) => t.title.toLowerCase() === r) ?? tasks.find((t) => t.title.toLowerCase().includes(r));
  if (!hit) throw new ValidationError(`No task matching "${ref}" on this ticket. Tasks: ${tasks.map((t) => t.title).join('; ') || 'none'}`);
  return hit;
}

const listTicketsSchema = z.object({
  type: z.enum(['incident', 'request', 'problem', 'change']).optional(),
  statusCategory: z.enum(['new', 'open', 'pending', 'resolved', 'closed', 'cancelled']).optional(),
  openOnly: z.boolean().optional(),
  priority: z.string().max(40).optional(),
  customer: z.string().max(200).optional(),
  assignee: z.string().max(200).optional(),
  unassigned: z.boolean().optional(),
  service: z.string().max(200).optional(),
  scope: z.enum(['in_scope', 'out_of_scope', 'unknown']).optional(),
  slaState: z.enum(['breached', 'at_risk', 'ok']).optional(),
  isMajor: z.boolean().optional(),
  createdFrom: z.string().max(30).optional(),
  createdTo: z.string().max(30).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'dueAt', 'priority']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export const TICKETS: ReturnType<typeof define>[] = [
  // ---------------------------------------------------------------- read
  define({
    name: 'list_tickets',
    toolset: 'tickets',
    description: 'Superseded by query_tickets (mode list). Kept for stored conversations.',
    inputSchema: listTicketsSchema,
    requires: ['tickets:read'],
    portal: ['portal:tickets'],
    action: false,
    hidden: true,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const priority = await resolveOption(ctx, 'ticket_priority', input.priority);
      const service = await resolveService(ctx, input.service);
      const assignee = isCustomerUser(ctx) ? null : await resolveEngineer(ctx, input.assignee);
      const openOnly = input.openOnly ?? !input.statusCategory;
      const res = await listTickets(ctx, listQuery({ page: 1, pageSize: input.limit ?? 20, sort: input.sort ?? 'createdAt', order: input.sort === 'dueAt' || input.sort === 'priority' ? 'asc' : 'desc', type: input.type, customerId, statusCategory: input.statusCategory, open: openOnly && !input.statusCategory ? true : undefined, priorityId: priority?.id, serviceId: service?.id ?? undefined, assigneeId: assignee?.id, unassigned: input.unassigned ? true : undefined, scopeStatus: input.scope, slaState: input.slaState, isMajor: input.isMajor, createdFrom: input.createdFrom, createdTo: input.createdTo, q: input.q }));
      return { total: res.total, showing: res.items.length, items: res.items.map((t) => compactTicket(ctx, t)) };
    },
    summary: (input, result) => `Listed ${(result as { showing: number }).showing} of ${(result as { total: number }).total} tickets${input.customer ? ` for ${input.customer}` : ''}`,
  }),
  define({
    name: 'ticket_stats',
    toolset: 'tickets',
    description: 'Superseded by query_tickets (mode count / breakdown). Kept for stored conversations.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), type: z.enum(['incident', 'request', 'problem', 'change']).optional() }),
    requires: ['tickets:read'],
    portal: ['portal:tickets'],
    action: false,
    hidden: true,
    run: async (ctx, input) => ticketStats(ctx, { customerId: await resolveCustomerId(ctx, input.customer), type: input.type }),
    summary: (input) => `Computed ticket statistics${input.customer ? ` for ${input.customer}` : ''}`,
  }),
  define({
    name: 'ticket_timeline',
    toolset: 'tickets',
    description: 'Comments, work notes and activity entries of a ticket (newest last).',
    inputSchema: z.object({ ticket: ticketRef, limit: z.number().int().min(1).max(40).optional() }),
    requires: ['tickets:read'],
    portal: ['portal:tickets'],
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const tl = await timeline(ctx, t.id);
      return { ticket: t.number, total: tl.items.length, items: tl.items.slice(-(input.limit ?? 20)).map((i) => ({ at: iso(i.createdAt), by: i.actorName, kind: i.type, internal: i.isInternal, text: trunc(i.kind === 'comment' ? i.body : i.summary, 600) })) };
    },
    summary: (input) => `Read timeline of ${input.ticket.toUpperCase()}`,
  }),
  define({
    name: 'similar_tickets',
    toolset: 'tickets',
    description: 'Tickets similar to a given ticket (full-text + title similarity), including resolution notes of resolved ones. Useful for "has this happened before" and resolution ideas.',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['tickets:read'],
    portal: ['portal:tickets'],
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const res = await similarTickets(ctx, t.id);
      return { ticket: t.number, items: res.items.map((s) => ({ number: s.number, title: s.title, customer: s.customerName, sameCustomer: s.sameCustomer, status: s.status?.label ?? null, resolvedAt: iso(s.resolvedAt), resolutionNotes: trunc(s.resolutionNotes, 400), score: Math.round(s.score * 100) / 100, link: ticketLink(ctx, s.id) })) };
    },
    summary: (input, result) => `Found ${(result as { items: unknown[] }).items.length} tickets similar to ${input.ticket.toUpperCase()}`,
  }),
  define({
    name: 'ticket_tasks',
    toolset: 'tickets',
    description: 'The task checklist of a ticket (title, status, assignee, due date).',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const tasks = (await listTasks(ctx, t.id)) as Record<string, unknown>[];
      return { ticket: t.number, items: tasks.map((x) => ({ id: x.id, title: x.title, status: x.status, assignee: x.assigneeName ?? x.assigneeId ?? null, dueAt: iso(x.dueAt as Date | null) })) };
    },
    summary: (input, result) => `Read ${(result as { items: unknown[] }).items.length} tasks of ${input.ticket.toUpperCase()}`,
  }),
  define({
    name: 'ticket_time',
    toolset: 'tickets',
    description: 'Time logged on a ticket: entries with minutes, work type, billable flag and who logged them.',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const res = await listTimeEntries(ctx, t.id);
      const entries = res.items;
      return { ticket: t.number, totalMinutes: res.totalMinutes, billableMinutes: res.billableMinutes, items: entries.map((e) => ({ id: e.id, minutes: e.minutes, workType: e.workType, billable: e.billable, by: e.userName ?? null, startedAt: iso(e.startedAt), description: trunc(e.description, 200) })), facts: [`${res.totalMinutes} minutes logged on ${t.number} across ${entries.length} entries (${res.billableMinutes} billable)`] };
    },
    summary: (input, result) => `Read time on ${input.ticket.toUpperCase()} (${(result as { totalMinutes: number }).totalMinutes} min)`,
  }),
  define({
    name: 'ticket_approvals',
    toolset: 'tickets',
    description: 'Approval steps of a request or change: step, approver, status, decision and whether the user may decide.',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['tickets:read'],
    portal: ['portal:tickets'],
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const res = await approvalsForTicket(ctx, t.id);
      return { ticket: t.number, approvalStatus: res.approvalStatus, items: res.items.map((a) => ({ id: a.id, step: a.step, name: a.stepName, approver: a.approverUser?.name ?? a.approverTeam?.name ?? a.approverRole?.name ?? null, status: a.status, decidedBy: a.decidedByUser?.name ?? null, decidedAt: iso(a.decidedAt), comment: trunc(a.comment, 300), canDecide: a.canDecide })) };
    },
    summary: (input, result) => `Read ${(result as { items: unknown[] }).items.length} approval steps of ${input.ticket.toUpperCase()}`,
  }),
  define({
    name: 'escalation_history',
    toolset: 'tickets',
    description: 'Escalations recorded on a ticket (level, reason, who was notified, when).',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      return { ticket: t.number, level: t.escalationLevel, items: await escalationHistory(ctx, t.id) };
    },
    summary: (input) => `Read escalation history of ${input.ticket.toUpperCase()}`,
  }),
  define({
    name: 'scope_preview',
    toolset: 'tickets',
    description: 'Whether work for a customer, service, site, category or CI falls inside their contract scope, and which contract and SLA policy would apply.',
    inputSchema: z.object({ customer: z.string().max(200), service: z.string().max(200).optional(), site: z.string().max(200).optional(), category: z.string().max(80).optional(), ci: z.string().max(200).optional() }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
      const [service, site, category] = await Promise.all([resolveService(ctx, input.service), resolveSite(ctx, customerId, input.site), resolveOption(ctx, 'ticket_category', input.category)]);
      const ci = input.ci ? await resolveCi(ctx, input.ci, customerId) : null;
      return scopePreview(ctx, { customerId, serviceId: service?.id ?? null, siteId: site?.id ?? null, ticketCategoryId: category?.id ?? null, primaryCiId: ci?.id ?? null });
    },
    summary: (input, result) => `Checked scope for ${input.customer}: ${(result as { scopeStatus?: string }).scopeStatus ?? 'unknown'}`,
  }),
  define({
    name: 'problem_candidates',
    toolset: 'tickets',
    description: 'Recurring incidents without a problem record, grouped by customer, category and CI (problem management candidates).',
    inputSchema: z.object({ customer: z.string().max(200).optional(), days: z.number().int().min(1).max(365).optional(), minCount: z.number().int().min(2).max(50).optional() }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const res = await problemCandidates(ctx, { customerId: await resolveCustomerId(ctx, input.customer), days: input.days, minCount: input.minCount });
      return { days: res.days, items: res.items.slice(0, 20).map((c) => ({ customer: c.customerName, category: c.categoryLabel, ci: c.ciName, count: c.count, sampleTickets: c.sampleNumbers, firstAt: iso(c.firstAt), lastAt: iso(c.lastAt) })) };
    },
    summary: (_i, result) => `Found ${(result as { items: unknown[] }).items.length} problem candidates`,
  }),
  define({
    name: 'out_of_scope_work',
    toolset: 'tickets',
    description: 'Tickets classified as out of scope in a period, grouped by customer or service, with counts and sample ticket numbers.',
    inputSchema: z.object({ days: z.number().int().min(1).max(365).optional(), groupBy: z.enum(['customer', 'service']).optional(), customer: z.string().max(200).optional() }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const days = input.days ?? 30;
      const customerId = await resolveCustomerId(ctx, input.customer);
      const by = input.groupBy ?? 'customer';
      const conds = [sql`t.scope_status = 'out_of_scope'`, sql`t.created_at >= now() - make_interval(days => ${days})`];
      if (customerId) conds.push(sql`t.customer_id = ${customerId}::uuid`);
      if (!ctx.can('soc:read')) conds.push(sql`t.domain <> 'soc'`);
      const keyCol = by === 'customer' ? sql`c.name` : sql`coalesce(s.name, 'No service')`;
      const res = await ctx.tx.execute(sql`
        SELECT ${keyCol} AS "group", count(*)::int AS "count",
               (array_agg(t.number ORDER BY t.created_at DESC))[1:5] AS "sampleTickets",
               coalesce(sum(te.minutes), 0)::int AS "minutesLogged"
        FROM tickets t
        JOIN customers c ON c.id = t.customer_id
        LEFT JOIN services s ON s.id = t.service_id
        LEFT JOIN (SELECT ticket_id, sum(minutes) AS minutes FROM time_entries GROUP BY ticket_id) te ON te.ticket_id = t.id
        WHERE ${sql.join(conds, sql` AND `)}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 30`);
      const rows = res.rows as { group: string; count: number; sampleTickets: string[]; minutesLogged: number }[];
      const total = rows.reduce((s, r) => s + r.count, 0);
      return { days, groupBy: by, total, groups: rows, facts: [`${total} out-of-scope tickets in the last ${days} days${customerId ? ' for this customer' : ''}`] };
    },
    summary: (input, result) => `Found ${(result as { total: number }).total} out-of-scope tickets in ${input.days ?? 30} days`,
  }),
  define({
    name: 'top_services_by_incidents',
    toolset: 'tickets',
    description: 'Services ranked by number of incidents in a period (optionally one customer).',
    inputSchema: z.object({ days: z.number().int().min(1).max(365).optional(), customer: z.string().max(200).optional(), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const days = input.days ?? 30;
      const customerId = await resolveCustomerId(ctx, input.customer);
      const conds = [sql`t.type = 'incident'`, sql`t.created_at >= now() - make_interval(days => ${days})`];
      if (customerId) conds.push(sql`t.customer_id = ${customerId}::uuid`);
      if (!ctx.can('soc:read')) conds.push(sql`t.domain <> 'soc'`);
      const res = await ctx.tx.execute(sql`
        SELECT coalesce(s.name, 'No service') AS "service", count(*)::int AS "incidents",
               count(*) FILTER (WHERE t.is_major) ::int AS "major",
               count(DISTINCT t.customer_id)::int AS "customers",
               round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60) FILTER (WHERE t.resolved_at IS NOT NULL))::int AS "avgResolutionMinutes"
        FROM tickets t LEFT JOIN services s ON s.id = t.service_id
        WHERE ${sql.join(conds, sql` AND `)}
        GROUP BY 1 ORDER BY 2 DESC LIMIT ${input.limit ?? 10}`);
      return { days, items: res.rows };
    },
    summary: (input) => `Ranked services by incidents (${input.days ?? 30} days)`,
  }),
  define({
    name: 'engineer_directory',
    toolset: 'tickets',
    description: 'Active MSP engineers with their teams (for assignment questions).',
    inputSchema: z.object({ q: z.string().max(200).optional().describe('Name or email filter'), limit: z.number().int().min(1).max(50).optional() }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const rows = await engineerDirectory(ctx, input.q);
      const teams = new Map((await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams)).map((t) => [t.id, t.name]));
      return { items: rows.slice(0, input.limit ?? 30).map((u) => ({ id: u.id, name: u.name, email: u.email, title: u.title, teams: u.teamIds.map((id) => teams.get(id) ?? id) })) };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} engineers`,
  }),

  // ---------------------------------------------------------------- actions
  define({
    name: 'create_ticket',
    toolset: 'tickets',
    tier: 'write',
    description: 'Create an incident or service request. Confirm the customer, title and priority with the user first unless they were stated explicitly. Returns the new ticket number.',
    inputSchema: z.object({
      customer: z.string().max(200).optional().describe('Customer name, code or id (ignored for portal users: always their own customer)'),
      type: z.enum(['incident', 'request']),
      title: z.string().min(3).max(300),
      description: z.string().max(20000).optional(),
      priority: z.string().max(40).optional().describe('Priority key (p1..p5) or label'),
      impact: z.string().max(40).optional(),
      urgency: z.string().max(40).optional(),
      category: z.string().max(80).optional().describe('Ticket category key or label'),
      service: z.string().max(200).optional(),
      site: z.string().max(200).optional(),
      ci: z.string().max(200).optional().describe('Primary CI name, hostname or IP'),
    }),
    requires: ['tickets:create'],
    portal: ['portal:tickets'],
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
      const [priority, impact, urgency, category, service, site, source] = await Promise.all([resolveOption(ctx, 'ticket_priority', input.priority), resolveOption(ctx, 'ticket_impact', input.impact), resolveOption(ctx, 'ticket_urgency', input.urgency), resolveOption(ctx, 'ticket_category', input.category), resolveService(ctx, input.service), resolveSite(ctx, customerId, input.site), optionByKey(ctx.tx, 'ticket_source', 'ai')]);
      const ci = input.ci ? await resolveCi(ctx, input.ci, customerId) : null;
      const t = await createTicket(ctx, { type: input.type, customerId, title: input.title, description: input.description ?? null, priorityId: isCustomerUser(ctx) ? null : (priority?.id ?? null), impactId: impact?.id ?? null, urgencyId: urgency?.id ?? null, categoryId: category?.id ?? null, serviceId: service?.id ?? null, siteId: site?.id ?? null, primaryCiId: ci?.id ?? null, ciIds: ci ? [ci.id] : undefined, sourceId: source?.id ?? null, requesterUserId: isCustomerUser(ctx) ? ctx.user.id : null });
      const d = await getTicket(ctx, t.id);
      return { created: true, number: d.number, id: d.id, title: d.title, status: d.status?.label, priority: d.priority?.label ?? null, customer: d.customer?.name, scope: d.scopeStatus, link: ticketLink(ctx, d.id) };
    },
    summary: (_i, result) => `Created ticket ${(result as { number: string }).number}`,
    preview: async (ctx, input) => {
      const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
      const [cust] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
      const [priority, site, service] = await Promise.all([isCustomerUser(ctx) ? null : resolveOption(ctx, 'ticket_priority', input.priority), resolveSite(ctx, customerId, input.site), resolveService(ctx, input.service)]);
      const parts = [`Create a${input.type === 'incident' ? 'n incident' : ' service request'} for ${cust?.name ?? 'the customer'}`];
      if (site) parts.push(`at ${site.name}`);
      parts.push(`titled "${input.title}"`);
      if (priority) parts.push(`with priority ${priority.label}`);
      if (service) parts.push(`on the service ${service.name}`);
      return parts.join(' ');
    },
  }),
  define({
    name: 'update_ticket',
    toolset: 'tickets',
    tier: 'write',
    description: 'Change fields of a ticket: title, description, category, subcategory, impact, urgency, priority, service, site or tags. Status, assignment and scope have their own tools.',
    inputSchema: z.object({ ticket: ticketRef, title: z.string().min(3).max(300).optional(), description: z.string().max(20000).optional(), category: z.string().max(80).optional(), subcategory: z.string().max(80).optional(), impact: z.string().max(40).optional(), urgency: z.string().max(40).optional(), priority: z.string().max(40).optional(), service: z.string().max(200).optional(), site: z.string().max(200).optional(), tags: z.array(z.string().max(50)).max(30).optional() }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const patch = await buildPatch(ctx, t, input);
      await updateTicket(ctx, t.id, patch as never);
      const d = await getTicket(ctx, t.id);
      return { updated: true, ticket: d.number, changed: Object.keys(patch), status: d.status?.label, priority: d.priority?.label ?? null, category: d.category?.label ?? null, link: ticketLink(ctx, d.id) };
    },
    summary: (input, result) => `Updated ${input.ticket.toUpperCase()} (${(result as { changed: string[] }).changed.join(', ')})`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const patch = await buildPatch(ctx, t, input);
      const lines = await describePatch(ctx, patch);
      if (!lines.length) throw new ValidationError('Nothing to change: give at least one field');
      return { text: `Update ${short(t)}: ${lines.join('; ')}`, lines };
    },
  }),
  define({
    name: 'add_comment',
    toolset: 'tickets',
    tier: 'write',
    description: 'Add a comment visible to the customer (their requester is notified). For an internal note use add_work_note.',
    inputSchema: z.object({ ticket: ticketRef, body: z.string().min(1).max(20000), internal: z.boolean().optional().describe('true = internal work note (staff only)') }),
    requires: ['tickets:comment'],
    portal: ['portal:tickets'],
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const internal = !!input.internal && !isCustomerUser(ctx);
      const c = await addComment(ctx, t.id, { kind: internal ? 'work_note' : 'comment', body: input.body });
      return { added: true, ticket: t.number, commentId: c.id, kind: c.kind, visibleToCustomer: !c.isInternal, link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => `Added ${(result as { kind: string }).kind === 'work_note' ? 'work note' : 'comment'} to ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const internal = !!input.internal && !isCustomerUser(ctx);
      return `Add ${internal ? 'an internal work note' : 'a comment visible to the customer'} to ${short(t)}: "${input.body.length > 160 ? `${input.body.slice(0, 160)}…` : input.body}"`;
    },
  }),
  define({
    name: 'add_work_note',
    toolset: 'tickets',
    tier: 'write_low',
    description: 'Add an internal work note to a ticket (never shown to the customer).',
    inputSchema: z.object({ ticket: ticketRef, body: z.string().min(1).max(20000) }),
    requires: ['tickets:work_notes'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const c = await addComment(ctx, t.id, { kind: 'work_note', body: input.body });
      return { added: true, ticket: t.number, commentId: c.id, kind: 'work_note', link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `Added work note to ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => `Add an internal work note to ${short(await resolveTicket(ctx, input.ticket))}: "${trunc(input.body, 160)}"`,
  }),
  define({
    name: 'assign_ticket',
    toolset: 'tickets',
    tier: 'write',
    description: 'Assign a ticket to an engineer ("me", name or email) and/or a team (key or name).',
    inputSchema: z.object({ ticket: ticketRef, engineer: z.string().max(200).optional(), team: z.string().max(200).optional(), comment: z.string().max(2000).optional() }),
    requires: ['tickets:assign'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      if (!input.engineer && !input.team) throw new ValidationError('Provide an engineer and/or a team');
      const t = await resolveTicket(ctx, input.ticket);
      const eng = await resolveEngineer(ctx, input.engineer);
      const team = await resolveTeam(ctx, input.team);
      const updated = await assignTicket(ctx, t.id, { assigneeId: eng ? eng.id : undefined, teamId: team ? team.id : undefined, autoProgress: true, comment: input.comment ?? null });
      const d = await getTicket(ctx, updated.id);
      return { assigned: true, ticket: d.number, assignee: d.assignee?.name ?? null, team: d.team?.name ?? null, status: d.status?.label, link: ticketLink(ctx, d.id) };
    },
    summary: (input, result) => `Assigned ${input.ticket.toUpperCase()} to ${(result as { assignee: string | null }).assignee ?? (result as { team: string | null }).team ?? 'nobody'}`,
    preview: async (ctx, input) => {
      if (!input.engineer && !input.team) throw new ValidationError('Provide an engineer and/or a team');
      const t = await resolveTicket(ctx, input.ticket);
      const [eng, team] = await Promise.all([resolveEngineer(ctx, input.engineer), resolveTeam(ctx, input.team)]);
      return `Assign ${short(t)} to ${[eng?.name, team ? `the team ${team.name}` : null].filter(Boolean).join(' and ')}${input.comment ? ` with the comment "${input.comment}"` : ''}`;
    },
  }),
  define({
    name: 'set_status',
    toolset: 'tickets',
    tier: 'write',
    description: 'Move a ticket to another status (key or label, e.g. "in_progress", "pending_customer", "pending_vendor"). To resolve, close, reopen or cancel use the dedicated tools.',
    inputSchema: z.object({ ticket: ticketRef, status: z.string().max(60), resolutionNotes: z.string().max(20000).optional(), comment: z.string().max(20000).optional() }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const to = await resolveStatus(ctx, t, input.status);
      if (to.statusCategory === 'cancelled') throw new ValidationError('Use cancel_ticket to cancel a ticket');
      const updated = await changeStatus(ctx, t.id, { statusId: to.id, resolutionNotes: input.resolutionNotes ?? null, comment: input.comment ?? null });
      const d = await getTicket(ctx, updated.id);
      return { updated: true, ticket: d.number, status: d.status?.label, statusCategory: d.status?.category, link: ticketLink(ctx, d.id) };
    },
    summary: (input, result) => `Set ${input.ticket.toUpperCase()} to ${(result as { status: string }).status}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const to = await resolveStatus(ctx, t, input.status);
      if (to.statusCategory === 'cancelled') throw new ValidationError('Use cancel_ticket to cancel a ticket');
      return `Set ${short(t)} to ${to.label}${input.resolutionNotes ? ` with the resolution notes "${input.resolutionNotes.slice(0, 120)}"` : ''}${input.comment ? ` and the comment "${input.comment.slice(0, 120)}"` : ''}`;
    },
  }),
  define({
    name: 'resolve_ticket',
    toolset: 'tickets',
    tier: 'write',
    description: 'Resolve a ticket with resolution notes (the requester is told and can confirm or reopen). Only on an explicit instruction naming the ticket.',
    inputSchema: z.object({ ticket: ticketRef, resolutionNotes: z.string().min(3).max(20000), comment: z.string().max(20000).optional() }),
    requires: ['tickets:resolve'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const updated = await resolveTicketSvc(ctx, t.id, { resolutionNotes: input.resolutionNotes, comment: input.comment ?? null });
      const d = await getTicket(ctx, updated.id);
      return { resolved: true, ticket: d.number, status: d.status?.label, link: ticketLink(ctx, d.id) };
    },
    summary: (input) => `Resolved ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => `Resolve ${short(await resolveTicket(ctx, input.ticket))} with the notes "${trunc(input.resolutionNotes, 160)}"`,
  }),
  define({
    name: 'close_ticket',
    toolset: 'tickets',
    tier: 'write',
    description: 'Close a resolved ticket. Only on an explicit instruction naming the ticket.',
    inputSchema: z.object({ ticket: ticketRef, comment: z.string().max(20000).optional() }),
    requires: ['tickets:resolve'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const updated = await closeTicket(ctx, t.id, { comment: input.comment ?? null });
      const d = await getTicket(ctx, updated.id);
      return { closed: true, ticket: d.number, status: d.status?.label, link: ticketLink(ctx, d.id) };
    },
    summary: (input) => `Closed ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => `Close ${short(await resolveTicket(ctx, input.ticket))}${input.comment ? ` with the comment "${trunc(input.comment, 120)}"` : ''}`,
  }),
  define({
    name: 'reopen_ticket',
    toolset: 'tickets',
    tier: 'write',
    description: 'Reopen a resolved or closed ticket with a reason (customers may reopen within the reopen window).',
    inputSchema: z.object({ ticket: ticketRef, reason: z.string().min(1).max(2000) }),
    requires: ['tickets:update'],
    portal: ['portal:tickets'],
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const updated = isCustomerUser(ctx) ? await reopenPortalTicket(ctx, t.id, input.reason) : await reopenTicket(ctx, t.id, { comment: input.reason });
      const d = await getTicket(ctx, (updated as { id: string }).id ?? t.id);
      return { reopened: true, ticket: d.number, status: d.status?.label, link: ticketLink(ctx, d.id) };
    },
    summary: (input) => `Reopened ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => `Reopen ${short(await resolveTicket(ctx, input.ticket))} because "${trunc(input.reason, 120)}"`,
  }),
  define({
    name: 'confirm_resolution',
    toolset: 'tickets',
    tier: 'write',
    description: 'Customer confirms a resolved ticket is fixed, which closes it.',
    inputSchema: z.object({ ticket: ticketRef, comment: z.string().max(2000).optional() }),
    requires: [],
    portalOnly: true,
    portal: ['portal:tickets'],
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      await confirmResolution(ctx, t.id, input.comment ?? null);
      const d = await getTicket(ctx, t.id);
      return { confirmed: true, ticket: d.number, status: d.status?.label, link: ticketLink(ctx, d.id) };
    },
    summary: (input) => `Confirmed the resolution of ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => `Confirm ${short(await resolveTicket(ctx, input.ticket))} is resolved and close it`,
  }),
  define({
    name: 'cancel_ticket',
    toolset: 'tickets',
    tier: 'destructive',
    description: 'Cancel a ticket that should not be worked (raised by mistake, duplicate). Only on an explicit instruction naming the ticket.',
    inputSchema: z.object({ ticket: ticketRef, reason: z.string().min(1).max(2000) }),
    requires: ['tickets:resolve'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const updated = await cancelTicket(ctx, t.id, { comment: input.reason });
      const d = await getTicket(ctx, updated.id);
      return { cancelled: true, ticket: d.number, status: d.status?.label, link: ticketLink(ctx, d.id) };
    },
    summary: (input) => `Cancelled ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      return { text: `Cancel ${short(t)} because "${trunc(input.reason, 120)}" (1 ticket)`, count: 1, lines: [`${t.number}: ${t.title.slice(0, 80)}`] };
    },
  }),
  define({
    name: 'escalate_ticket',
    toolset: 'tickets',
    tier: 'write',
    description: 'Escalate a ticket (raises the escalation level and notifies the managers).',
    inputSchema: z.object({ ticket: ticketRef, reason: z.string().min(1).max(2000) }),
    requires: ['tickets:escalate'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const updated = await escalateTicket(ctx, t.id, { reason: input.reason });
      return { escalated: true, ticket: t.number, level: (updated as TicketRow).escalationLevel, link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => `Escalated ${input.ticket.toUpperCase()} to level ${(result as { level: number }).level}`,
    preview: async (ctx, input) => `Escalate ${short(await resolveTicket(ctx, input.ticket))}: "${trunc(input.reason, 120)}"`,
  }),
  define({
    name: 'set_scope',
    toolset: 'tickets',
    tier: 'write',
    description: 'Override the contract-scope classification of a ticket (in scope, out of scope or unknown) with a note.',
    inputSchema: z.object({ ticket: ticketRef, scopeStatus: z.enum(['in_scope', 'out_of_scope', 'unknown']), note: z.string().max(2000).optional() }),
    requires: ['tickets:scope'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      await setScope(ctx, t.id, { scopeStatus: input.scopeStatus, scopeNote: input.note ?? null });
      return { updated: true, ticket: t.number, scope: input.scopeStatus, link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `Marked ${input.ticket.toUpperCase()} as ${input.scopeStatus.replace(/_/g, ' ')}`,
    preview: async (ctx, input) => `Mark ${short(await resolveTicket(ctx, input.ticket))} as ${input.scopeStatus.replace(/_/g, ' ')}${input.note ? ` ("${trunc(input.note, 100)}")` : ''}`,
  }),
  define({
    name: 'link_tickets',
    toolset: 'tickets',
    tier: 'write_low',
    description: 'Link two tickets of the same customer (related, duplicate_of, caused_by, blocks, child_of, problem_of, change_for, resolved_by).',
    inputSchema: z.object({ ticket: ticketRef, target: ticketRef.describe('The other ticket number or id'), linkType: z.enum(['related', 'duplicate_of', 'caused_by', 'blocks', 'child_of', 'problem_of', 'change_for', 'resolved_by']).optional() }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const target = await resolveTicket(ctx, input.target);
      const link = await addLink(ctx, t.id, { targetTicketId: target.id, linkType: input.linkType ?? 'related' });
      return { linked: true, ticket: t.number, target: target.number, linkType: link.linkType };
    },
    summary: (input) => `Linked ${input.ticket.toUpperCase()} → ${input.target.toUpperCase()} (${input.linkType ?? 'related'})`,
    preview: async (ctx, input) => {
      const [t, target] = await Promise.all([resolveTicket(ctx, input.ticket), resolveTicket(ctx, input.target)]);
      return `Link ${t.number} to ${target.number} as ${(input.linkType ?? 'related').replace(/_/g, ' ')}`;
    },
  }),
  define({
    name: 'unlink_tickets',
    toolset: 'tickets',
    tier: 'destructive',
    description: 'Remove the link between two tickets.',
    inputSchema: z.object({ ticket: ticketRef, target: ticketRef }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const [t, target] = await Promise.all([resolveTicket(ctx, input.ticket), resolveTicket(ctx, input.target)]);
      const links = await ctx.tx.select({ id: schema.ticketLinks.id, linkType: schema.ticketLinks.linkType }).from(schema.ticketLinks).where(or(and(eq(schema.ticketLinks.sourceTicketId, t.id), eq(schema.ticketLinks.targetTicketId, target.id)), and(eq(schema.ticketLinks.sourceTicketId, target.id), eq(schema.ticketLinks.targetTicketId, t.id))));
      if (!links.length) throw new ValidationError(`${t.number} and ${target.number} are not linked`);
      for (const l of links) await removeLink(ctx, t.id, l.id);
      return { unlinked: true, ticket: t.number, target: target.number, removed: links.length };
    },
    summary: (input) => `Unlinked ${input.ticket.toUpperCase()} and ${input.target.toUpperCase()}`,
    preview: async (ctx, input) => {
      const [t, target] = await Promise.all([resolveTicket(ctx, input.ticket), resolveTicket(ctx, input.target)]);
      return { text: `Remove the link between ${t.number} and ${target.number} (1 link)`, count: 1 };
    },
  }),
  define({
    name: 'add_task',
    toolset: 'tickets',
    tier: 'write_low',
    description: 'Add a task to a ticket\'s checklist, optionally assigned and with a due date.',
    inputSchema: z.object({ ticket: ticketRef, title: z.string().min(1).max(300), description: z.string().max(4000).optional(), assignee: z.string().max(200).optional(), dueAt: z.string().max(40).optional().describe('ISO date or date-time') }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const assignee = await resolveEngineer(ctx, input.assignee);
      const task = (await createTask(ctx, t.id, { title: input.title, description: input.description ?? null, assigneeId: assignee?.id ?? null, dueAt: parseWhen(input.dueAt, 'due date') } as never)) as { id: string };
      return { added: true, ticket: t.number, taskId: task.id, title: input.title, link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `Added task "${trunc(input.title, 60)}" to ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const assignee = await resolveEngineer(ctx, input.assignee);
      return `Add the task "${input.title}" to ${t.number}${assignee ? ` for ${assignee.name}` : ''}${input.dueAt ? ` due ${input.dueAt}` : ''}`;
    },
  }),
  define({
    name: 'update_task',
    toolset: 'tickets',
    tier: 'write_low',
    description: 'Change a task of a ticket: status (open, in_progress, done, cancelled) and/or assignee. The task is named by its title or id.',
    inputSchema: z.object({ ticket: ticketRef, task: z.string().max(300), status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(), assignee: z.string().max(200).optional() }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const task = await findTask(ctx, t.id, input.task);
      const assignee = await resolveEngineer(ctx, input.assignee);
      await updateTask(ctx, t.id, task.id, { ...(input.status ? { status: input.status } : {}), ...(assignee ? { assigneeId: assignee.id } : {}) } as never);
      return { updated: true, ticket: t.number, task: task.title, status: input.status ?? task.status, link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => `Updated task "${trunc((result as { task: string }).task, 50)}" on ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const task = await findTask(ctx, t.id, input.task);
      const assignee = await resolveEngineer(ctx, input.assignee);
      return `On ${t.number}, ${[input.status ? `mark the task "${task.title}" as ${input.status.replace(/_/g, ' ')}` : null, assignee ? `assign the task "${task.title}" to ${assignee.name}` : null].filter(Boolean).join(' and ') || `touch the task "${task.title}"`}`;
    },
  }),
  define({
    name: 'delete_task',
    toolset: 'tickets',
    tier: 'destructive',
    description: 'Delete a task from a ticket\'s checklist.',
    inputSchema: z.object({ ticket: ticketRef, task: z.string().max(300) }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const task = await findTask(ctx, t.id, input.task);
      await deleteTask(ctx, t.id, task.id);
      return { deleted: true, ticket: t.number, task: task.title };
    },
    summary: (input, result) => `Deleted task "${trunc((result as { task: string }).task, 50)}" from ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const task = await findTask(ctx, t.id, input.task);
      return { text: `Delete the task "${task.title}" from ${t.number} (1 task)`, count: 1 };
    },
  }),
  define({
    name: 'log_time',
    toolset: 'tickets',
    tier: 'write_low',
    description: 'Log time spent on a ticket for the user (minutes, work type, optional note).',
    inputSchema: z.object({ ticket: ticketRef, minutes: z.number().int().min(1).max(10080), workType: z.enum(['remote', 'onsite', 'travel', 'other']).optional(), description: z.string().max(2000).optional(), billable: z.boolean().optional() }),
    requires: ['tickets:time'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const entry = (await addTimeEntry(ctx, t.id, { minutes: input.minutes, description: input.description ?? null, workType: input.workType ?? 'remote', billable: input.billable } as never)) as { id: string };
      return { logged: true, ticket: t.number, entryId: entry.id, minutes: input.minutes, link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `Logged ${input.minutes} minutes on ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => `Log ${input.minutes} minutes of ${input.workType ?? 'remote'} work on ${short(await resolveTicket(ctx, input.ticket))}${input.description ? ` ("${trunc(input.description, 80)}")` : ''}`,
  }),
  define({
    name: 'delete_time_entry',
    toolset: 'tickets',
    tier: 'destructive',
    description: 'Delete one time entry of a ticket (by its id from ticket_time).',
    inputSchema: z.object({ ticket: ticketRef, entryId: z.string().uuid() }),
    requires: ['tickets:time'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      await deleteTimeEntry(ctx, t.id, input.entryId);
      return { deleted: true, ticket: t.number };
    },
    summary: (input) => `Deleted a time entry from ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const e = (await listTimeEntries(ctx, t.id)).items.find((x) => x.id === input.entryId);
      if (!e) throw new ValidationError('No such time entry on this ticket');
      return { text: `Delete the ${e.minutes}-minute time entry from ${t.number} (1 entry)`, count: 1 };
    },
  }),
  define({
    name: 'watch_ticket',
    toolset: 'tickets',
    tier: 'write_low',
    description: 'Start or stop watching a ticket (the user receives its notifications).',
    inputSchema: z.object({ ticket: ticketRef, watch: z.boolean().optional().describe('false to stop watching; default true') }),
    requires: ['tickets:read'],
    portal: null,
    action: true,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      if (input.watch === false) await removeWatcher(ctx, t.id);
      else await addWatcher(ctx, t.id);
      return { watching: input.watch !== false, ticket: t.number, link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `${input.watch === false ? 'Stopped watching' : 'Now watching'} ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => `${input.watch === false ? 'Stop watching' : 'Watch'} ${short(await resolveTicket(ctx, input.ticket))}`,
  }),
  define({
    name: 'set_ticket_cis',
    toolset: 'tickets',
    tier: 'write',
    description: 'Set the affected configuration items of a ticket (names, hostnames or IPs; replaces the current list).',
    inputSchema: z.object({ ticket: ticketRef, cis: z.array(z.string().max(200)).min(1).max(20) }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets', 'cmdb'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const ids: string[] = [];
      for (const ref of input.cis) ids.push((await resolveCi(ctx, ref, t.customerId)).id);
      await setCis(ctx, t.id, ids);
      return { updated: true, ticket: t.number, cis: input.cis.length, link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `Set ${input.cis.length} affected CI(s) on ${input.ticket.toUpperCase()}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const names: string[] = [];
      for (const ref of input.cis) {
        const ci = await resolveCi(ctx, ref, t.customerId);
        names.push('name' in ci ? ci.name : ref);
      }
      return { text: `Set the affected CIs of ${t.number} to ${names.join(', ')}`, lines: names };
    },
  }),
  define({
    name: 'bulk_update_tickets',
    toolset: 'tickets',
    tier: 'destructive',
    description: 'Apply one change to several tickets at once (up to 25): assign to an engineer/team, set a status, or set a priority. List the ticket numbers explicitly.',
    inputSchema: z.object({ tickets: z.array(ticketRef).min(1).max(25), action: z.enum(['assign', 'status', 'priority']), engineer: z.string().max(200).optional(), team: z.string().max(200).optional(), status: z.string().max(60).optional(), priority: z.string().max(40).optional(), comment: z.string().max(2000).optional() }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const { rows, payload } = await bulkPlan(ctx, input);
      const res = await bulkAction(ctx, { ids: rows.map((r) => r.id), action: input.action, payload });
      return { action: input.action, tickets: rows.map((r) => r.number), result: res };
    },
    summary: (input, result) => `${input.action === 'assign' ? 'Assigned' : input.action === 'status' ? 'Changed the status of' : 'Set the priority of'} ${(result as { tickets: string[] }).tickets.length} tickets`,
    preview: async (ctx, input) => {
      const { rows, what } = await bulkPlan(ctx, input);
      return { text: `${what} on ${rows.length} tickets: ${rows.map((r) => r.number).join(', ')}`, count: rows.length, lines: rows.map((r) => `${r.number}: ${r.title.slice(0, 60)}`) };
    },
  }),
];

type BulkInput = { tickets: string[]; action: 'assign' | 'status' | 'priority'; engineer?: string; team?: string; status?: string; priority?: string; comment?: string };
async function bulkPlan(ctx: Ctx, input: BulkInput) {
  const rows: TicketRow[] = [];
  for (const ref of input.tickets) rows.push(await resolveTicket(ctx, ref));
  const payload: { teamId?: string | null; assigneeId?: string | null; statusId?: string; priorityId?: string; comment?: string | null } = { comment: input.comment ?? null };
  let what: string;
  if (input.action === 'assign') {
    const [eng, team] = await Promise.all([resolveEngineer(ctx, input.engineer), resolveTeam(ctx, input.team)]);
    if (!eng && !team) throw new ValidationError('Provide an engineer and/or a team');
    payload.assigneeId = eng?.id ?? null;
    payload.teamId = team?.id ?? null;
    what = `Assign to ${[eng?.name, team?.name].filter(Boolean).join(' / ')}`;
  } else if (input.action === 'status') {
    if (!input.status) throw new ValidationError('Provide the status');
    const to = await resolveStatus(ctx, rows[0]!, input.status);
    payload.statusId = to.id;
    what = `Set the status to ${to.label}`;
  } else {
    const prio = await resolveOption(ctx, 'ticket_priority', input.priority);
    if (!prio) throw new ValidationError('Provide the priority');
    payload.priorityId = prio.id;
    what = `Set the priority to ${prio.label}`;
  }
  return { rows, payload, what };
}

type UpdateInput = { title?: string; description?: string; category?: string; subcategory?: string; impact?: string; urgency?: string; priority?: string; service?: string; site?: string; tags?: string[] };
async function buildPatch(ctx: Ctx, t: TicketRow, input: UpdateInput) {
  const patch: Record<string, unknown> = {};
  if (input.title) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.category) patch.categoryId = (await resolveOption(ctx, 'ticket_category', input.category))!.id;
  if (input.subcategory) patch.subcategoryId = (await resolveOption(ctx, 'ticket_subcategory', input.subcategory))!.id;
  if (input.impact) patch.impactId = (await resolveOption(ctx, 'ticket_impact', input.impact))!.id;
  if (input.urgency) patch.urgencyId = (await resolveOption(ctx, 'ticket_urgency', input.urgency))!.id;
  if (input.priority) patch.priorityId = (await resolveOption(ctx, 'ticket_priority', input.priority))!.id;
  if (input.service) patch.serviceId = (await resolveService(ctx, input.service))!.id;
  if (input.site) patch.siteId = (await resolveSite(ctx, t.customerId, input.site))!.id;
  if (input.tags) patch.tags = input.tags;
  return patch;
}
async function describePatch(ctx: Ctx, patch: Record<string, unknown>) {
  const lines: string[] = [];
  const label = async (type: string, id: unknown) => (await resolveOption(ctx, type, String(id)))?.label ?? String(id);
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'title') lines.push(`title → "${String(v).slice(0, 80)}"`);
    else if (k === 'description') lines.push('description replaced');
    else if (k === 'categoryId') lines.push(`category → ${await label('ticket_category', v)}`);
    else if (k === 'subcategoryId') lines.push(`subcategory → ${await label('ticket_subcategory', v)}`);
    else if (k === 'impactId') lines.push(`impact → ${await label('ticket_impact', v)}`);
    else if (k === 'urgencyId') lines.push(`urgency → ${await label('ticket_urgency', v)}`);
    else if (k === 'priorityId') lines.push(`priority → ${await label('ticket_priority', v)}`);
    else if (k === 'serviceId') lines.push(`service → ${(await resolveService(ctx, String(v)))?.name ?? v}`);
    else if (k === 'siteId') lines.push('site changed');
    else if (k === 'tags') lines.push(`tags → ${(v as string[]).join(', ')}`);
  }
  return lines;
}

export const resolveUserRef = resolveUser;
export type { PreviewDetail };
