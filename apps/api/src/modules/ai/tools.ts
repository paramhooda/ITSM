import { z } from 'zod';
import { eq, and, or, ilike, inArray, sql, asc, gte, lte } from 'drizzle-orm';
import type { Permission, TicketType } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError } from '@/core/errors';
import type { ToolDefinition } from '@/lib/ai';
import { createTicket, getTicket, assignTicket, changeStatus } from '@/modules/tickets/service';
import { listTickets, ticketStats, similarTickets, problemCandidates } from '@/modules/tickets/list';
import { addComment, timeline, addLink } from '@/modules/tickets/activity';
import { loadTicket, loadTicketByNumber, optionsOfType, optionByKey, type TicketRow } from '@/modules/tickets/common';
import { applicableStatuses } from '@/modules/tickets/status';
import { listMajor } from '@/modules/tickets/major';
import { listCustomers, customerOverview } from '@/modules/customers/service';
import { listContracts } from '@/modules/contracts/service';
import { customerEntitlements } from '@/modules/contracts/entitlements';
import { slaCompliance, type ComplianceGroupBy } from '@/modules/sla/policies';
import { listCisMin, getCi, history as ciHistory, impact as ciImpact } from '@/modules/cmdb/service';
import { listAssetsMin, expiringAssets } from '@/modules/assets/service';
import { suggest as kbSuggest, getArticle } from '@/modules/knowledge/service';
import { postgresSearchProvider } from '@/modules/search/postgres';
import type { SearchType } from '@/modules/search/provider';
import type { ListQuery } from '@/modules/tickets/schemas';
import { engineerDirectory } from '@/modules/iam/service';

/**
 * AI tool registry. Each tool wraps a service function and runs with the
 * caller's `Ctx`, so authorization and tenant isolation apply exactly as they
 * do for the UI. Availability is filtered by the principal's permissions;
 * action tools additionally require `ai:act`.
 */
/**
 * How much a tool can change, and therefore when it may run:
 * read: freely · write_low: internal, low-risk (auto-applied only under autonomy auto_low) ·
 * write: needs confirmation · outbound: reaches people outside the platform, always confirmed ·
 * admin: configuration, always confirmed · destructive: removes or cancels, always confirmed and the preview states the count.
 */
export type ToolTier = 'read' | 'write_low' | 'write' | 'outbound' | 'admin' | 'destructive';

export interface AiTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  /** Defaults to 'write' for action tools and 'read' otherwise. */
  tier?: ToolTier;
  /** MSP users: every listed permission is required. */
  requires: Permission[];
  /** Customer (portal) users: permissions required, or `null` when the tool is not offered in the portal. */
  portal: Permission[] | null;
  /** Mutates data: requires `ai:act`; never runs until the user has confirmed the preview (propose-then-commit). */
  action: boolean;
  /** Kept for compatibility but no longer offered to the model (superseded by a better tool). */
  hidden?: boolean;
  run(ctx: Ctx, input: z.infer<S>): Promise<unknown>;
  /** One-line description shown in the conversation ("Listed 5 open tickets for Sample Customer"). */
  summary(input: z.infer<S>, result: unknown): string;
  /** Action tools: what exactly will happen, resolved against real records, shown to the user before they confirm. */
  preview?(ctx: Ctx, input: z.infer<S>): Promise<string>;
}

const define = <S extends z.ZodTypeAny>(t: AiTool<S>): AiTool => t as unknown as AiTool;
export const tierOf = (t: AiTool): ToolTier => t.tier ?? (t.action ? 'write' : 'read');

import { isCustomerUser, UUID_RE, ticketLink, trunc, iso, period, listQuery, resolveTicket, resolveCustomerId, resolveOption, resolveService, resolveSite, resolveCi, resolveEngineer, resolveTeam, compactTicket, compactDetail, compactTimeline } from './helpers';
import { queryTicketsSchema, runTicketQuery, describeTicketQuery } from './query';
export * from './helpers';


// ---------------------------------------------------------------- read tools

const listTicketsSchema = z.object({
  type: z.enum(['incident', 'request', 'problem', 'change']).optional().describe('Ticket type'),
  statusCategory: z.enum(['new', 'open', 'pending', 'resolved', 'closed', 'cancelled']).optional().describe('Lifecycle category; omit with openOnly=true for all open work'),
  openOnly: z.boolean().optional().describe('Only tickets that are new/open/pending (default true unless statusCategory given)'),
  priority: z.string().max(40).optional().describe('Priority key or label, e.g. "p1"'),
  customer: z.string().max(200).optional().describe('Customer name, code or id'),
  assignee: z.string().max(200).optional().describe('"me", an engineer name or email'),
  unassigned: z.boolean().optional(),
  service: z.string().max(200).optional().describe('Service name or key'),
  scope: z.enum(['in_scope', 'out_of_scope', 'unknown']).optional(),
  slaState: z.enum(['breached', 'at_risk', 'ok']).optional(),
  isMajor: z.boolean().optional(),
  createdFrom: z.string().max(30).optional().describe('ISO date (inclusive)'),
  createdTo: z.string().max(30).optional().describe('ISO date (inclusive)'),
  q: z.string().max(200).optional().describe('Free-text search over number/title/description'),
  sort: z.enum(['createdAt', 'updatedAt', 'dueAt', 'priority']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const ticketRef = z.string().max(80).describe('Ticket number (e.g. INC-000123) or id');

export const READ_TOOLS: AiTool[] = [
  define({
    name: 'query_tickets',
    description: "The one way to answer questions about tickets: how many (mode 'count'), by priority/status/customer/team/engineer/service (mode 'breakdown' + groupBy), or which ones (mode 'list'). The result's `facts` lines carry the exact figures and say what was counted; quote them. Unless the user says otherwise, tickets means open tickets (new, in progress or pending).",
    inputSchema: queryTicketsSchema,
    requires: ['tickets:read'],
    portal: ['portal:tickets'],
    action: false,
    run: (ctx, input) => runTicketQuery(ctx, input),
    summary: describeTicketQuery,
  }),

  define({
    name: 'search',
    description: 'Global search across tickets, customers, assets, CIs, contracts, services and knowledge articles. Use when you do not know which entity type the user means.',
    inputSchema: z.object({ q: z.string().min(2).max(200), types: z.array(z.enum(['ticket', 'customer', 'asset', 'ci', 'contract', 'service', 'kb', 'visit'])).optional(), limit: z.number().int().min(1).max(20).optional() }),
    requires: [],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const types = (input.types ?? ['ticket', 'customer', 'asset', 'ci', 'contract', 'service', 'kb']) as SearchType[];
      const hits = await postgresSearchProvider.search(ctx, input.q, types, input.limit ?? 10);
      return { hits: hits.slice(0, 40).map((h) => ({ type: h.type, id: h.id, title: h.title, subtitle: h.subtitle ?? null, badge: h.badge ?? null, link: h.link })) };
    },
    summary: (input, result) => `Searched "${input.q}" (${(result as { hits: unknown[] }).hits.length} hits)`,
  }),

  define({
    name: 'list_tickets',
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
      const res = await listTickets(ctx, listQuery({
        page: 1,
        pageSize: input.limit ?? 20,
        sort: input.sort ?? 'createdAt',
        order: input.sort === 'dueAt' || input.sort === 'priority' ? 'asc' : 'desc',
        type: input.type,
        customerId,
        statusCategory: input.statusCategory,
        open: openOnly && !input.statusCategory ? true : undefined,
        priorityId: priority?.id,
        serviceId: service?.id ?? undefined,
        assigneeId: assignee?.id,
        unassigned: input.unassigned ? true : undefined,
        scopeStatus: input.scope,
        slaState: input.slaState,
        isMajor: input.isMajor,
        createdFrom: input.createdFrom,
        createdTo: input.createdTo,
        q: input.q,
      }));
      return { total: res.total, showing: res.items.length, items: res.items.map((t) => compactTicket(ctx, t)) };
    },
    summary: (input, result) => `Listed ${(result as { showing: number; total: number }).showing} of ${(result as { total: number }).total} tickets${input.customer ? ` for ${input.customer}` : ''}${input.assignee ? ` assigned to ${input.assignee}` : ''}`,
  }),

  define({
    name: 'get_ticket',
    description: 'Full summary of one ticket by number or id: fields, customer/site/service, assignment, SLA clocks, linked tickets, CIs and the last 5 timeline entries.',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['tickets:read'],
    portal: ['portal:tickets'],
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const d = await getTicket(ctx, t.id);
      const tl = await timeline(ctx, t.id);
      return { ...compactDetail(ctx, d), recentTimeline: compactTimeline(tl.items, 5) };
    },
    summary: (input, result) => `Read ticket ${(result as { number: string }).number ?? input.ticket}`,
  }),

  define({
    name: 'ticket_timeline',
    description: 'Comments, work notes and activity entries of a ticket (newest last).',
    inputSchema: z.object({ ticket: ticketRef, limit: z.number().int().min(1).max(40).optional() }),
    requires: ['tickets:read'],
    portal: ['portal:tickets'],
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const tl = await timeline(ctx, t.id);
      return { ticket: t.number, total: tl.items.length, items: compactTimeline(tl.items, input.limit ?? 20) };
    },
    summary: (input) => `Read timeline of ${input.ticket.toUpperCase()}`,
  }),

  define({
    name: 'similar_tickets',
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
    name: 'ticket_stats',
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
    name: 'list_customers',
    description: 'Customers visible to the user with open ticket and active contract counts. Supports a name/code search.',
    inputSchema: z.object({ q: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).optional() }),
    requires: ['customers:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const res = await listCustomers(ctx, { page: 1, pageSize: input.limit ?? 20, q: input.q, sort: 'name', order: 'asc' });
      return { total: res.total, items: res.items.map((c) => ({ id: c.id, code: c.code, name: c.name, status: 'statusLabel' in c ? c.statusLabel : null, openTickets: 'openTickets' in c ? c.openTickets : null, activeContracts: 'activeContracts' in c ? c.activeContracts : null, accountManager: 'accountManagerName' in c ? c.accountManagerName : null, link: `/customers/${c.id}` })) };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} customers`,
  }),

  define({
    name: 'get_customer',
    description: 'Customer overview: open tickets by priority, recent tickets, contracts with expiry, entitlement usage, 30-day SLA compliance and upcoming visits / maintenance.',
    inputSchema: z.object({ customer: z.string().max(200).describe('Customer name, code or id') }),
    requires: ['customers:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const id = (await resolveCustomerId(ctx, input.customer, true))!;
      const o = await customerOverview(ctx, id);
      return {
        customer: { ...o.customer, link: `/customers/${id}` },
        counts: o.counts,
        ticketsByStatusCategory: o.ticketsByStatusCategory,
        openByPriority: o.ticketsByPriority.map((p) => ({ priority: p.label, count: p.count })),
        recentTickets: (o.recentTickets as { id: string; number: string; title: string; statusLabel: string; priorityLabel: string | null; createdAt: string }[]).slice(0, 8).map((t) => ({ number: t.number, title: t.title, status: t.statusLabel, priority: t.priorityLabel, createdAt: iso(t.createdAt), link: ticketLink(ctx, t.id) })),
        contracts: o.contracts.map((c) => ({ number: c.number, name: c.name, status: c.status, type: c.typeLabel, startDate: c.startDate, endDate: c.endDate, daysToExpiry: c.daysToExpiry, link: `/contracts/${c.id}` })),
        entitlements: o.entitlements.map((e) => ({ name: e.name, unit: e.unit, contract: e.contractNumber, period: e.utilization.period, quantity: e.utilization.quantity, used: e.utilization.used, remaining: e.utilization.remaining, pct: e.utilization.pct, overThreshold: e.utilization.overThreshold, exhausted: e.utilization.exhausted })),
        sla30d: o.sla30d,
        upcomingVisits: o.upcomingVisits.map((v) => ({ number: v.number, title: v.title, status: v.status, scheduledStart: iso(v.scheduledStart), engineer: v.engineerName, site: v.siteName })),
        upcomingPm: o.upcomingPm.map((p) => ({ program: p.programName, plannedDate: p.plannedDate, scheduledDate: p.scheduledDate, status: p.status, site: p.siteName })),
      };
    },
    summary: (input) => `Read customer overview for ${input.customer}`,
  }),

  define({
    name: 'list_contracts',
    description: 'Contracts with status, dates and days to expiry. Filter by customer, status, or contracts expiring within N days.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), status: z.enum(['draft', 'active', 'expiring', 'expired', 'terminated', 'renewed', 'suspended']).optional(), expiringWithinDays: z.number().int().min(0).max(3650).optional(), q: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() }),
    requires: ['contracts:read'],
    portal: ['portal:contracts'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      if (isCustomerUser(ctx)) {
        ctx.requireCustomer(customerId);
        const today = new Date().toISOString().slice(0, 10);
        const conds = [eq(schema.contracts.customerId, customerId!)];
        if (input.status) conds.push(eq(schema.contracts.status, input.status));
        if (input.expiringWithinDays !== undefined) conds.push(gte(schema.contracts.endDate, today), lte(schema.contracts.endDate, new Date(Date.now() + input.expiringWithinDays * 86_400_000).toISOString().slice(0, 10)));
        const rows = await ctx.tx.select({ id: schema.contracts.id, number: schema.contracts.number, name: schema.contracts.name, status: schema.contracts.status, startDate: schema.contracts.startDate, endDate: schema.contracts.endDate, renewalDate: schema.contracts.renewalDate, responseCommitment: schema.contracts.responseCommitment, resolutionCommitment: schema.contracts.resolutionCommitment }).from(schema.contracts).where(and(...conds)).orderBy(asc(schema.contracts.endDate)).limit(input.limit ?? 20);
        return { total: rows.length, items: rows.map((c) => ({ ...c, daysToExpiry: Math.round((new Date(c.endDate).getTime() - Date.now()) / 86_400_000) })) };
      }
      const res = await listContracts(ctx, { page: 1, pageSize: input.limit ?? 20, sort: 'endDate', order: 'asc', customerId, status: input.status ? [input.status] : undefined, expiringWithinDays: input.expiringWithinDays, q: input.q });
      return {
        total: res.total,
        items: res.items.map((c) => ({ id: c.id, number: c.number, name: c.name, customer: c.customerName, status: c.status, type: c.typeLabel, startDate: c.startDate, endDate: c.endDate, renewalDate: c.renewalDate, daysToExpiry: c.daysToExpiry, autoRenew: c.autoRenew, services: c.serviceNames, entitlements: c.entitlements, link: `/contracts/${c.id}` })),
      };
    },
    summary: (input, result) => `Listed ${(result as { items: unknown[] }).items.length} contracts${input.expiringWithinDays !== undefined ? ` expiring within ${input.expiringWithinDays} days` : ''}`,
  }),

  define({
    name: 'entitlement_usage',
    description: 'Entitlement consumption for a customer (AMC visits, support hours, incident quotas): quantity, used, remaining, percentage and the current period.',
    inputSchema: z.object({ customer: z.string().max(200).optional().describe('Customer name, code or id (ignored for portal users)') }),
    requires: ['contracts:read'],
    portal: ['portal:contracts'],
    action: false,
    run: async (ctx, input) => {
      const id = (await resolveCustomerId(ctx, input.customer, true))!;
      const ents = await customerEntitlements(ctx, id);
      return { customerId: id, items: ents.map((e) => ({ name: e.name, type: e.typeLabel, service: e.serviceName, unit: e.unit, contract: e.contractNumber, period: e.utilization.period, periodStart: e.utilization.periodStart, periodEnd: e.utilization.periodEnd, quantity: e.utilization.quantity, used: e.utilization.used, remaining: e.utilization.remaining, pct: e.utilization.pct, overThreshold: e.utilization.overThreshold, exhausted: e.utilization.exhausted })) };
    },
    summary: (input, result) => `Read ${(result as { items: unknown[] }).items.length} entitlements${input.customer ? ` for ${input.customer}` : ''}`,
  }),

  define({
    name: 'sla_compliance',
    description: 'SLA compliance figures (met/breached/running, compliance %) for a period, grouped by metric, priority, customer, service, policy or ticket type.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), days: z.number().int().min(1).max(365).optional().describe('Look-back window in days (default 30)'), groupBy: z.enum(['metric', 'priority', 'customer', 'service', 'policy', 'ticketType']).optional(), ticketType: z.enum(['incident', 'request', 'problem', 'change']).optional() }),
    requires: ['tickets:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const days = input.days ?? 30;
      const res = await slaCompliance(ctx, { customerId, from: period(days).toISOString(), groupBy: (input.groupBy ?? 'metric') as ComplianceGroupBy, ticketType: input.ticketType as TicketType | undefined });
      return { days, groupBy: res.groupBy, totals: res.totals, groups: res.groups.slice(0, 40).map((g) => ({ label: g.label, met: g.met, breached: g.breached, running: g.running, compliancePct: g.compliancePct, avgElapsedMinutes: g.avgElapsedMinutes })) };
    },
    summary: (input) => `Computed SLA compliance (${input.days ?? 30} days, by ${input.groupBy ?? 'metric'})`,
  }),

  define({
    name: 'get_ci',
    description: 'Configuration item by name, hostname or IP: details, relationships, open tickets and recent changes.',
    inputSchema: z.object({ ci: z.string().max(200).describe('CI name, hostname, IP address or id'), customer: z.string().max(200).optional() }),
    requires: ['cmdb:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const hit = await resolveCi(ctx, input.ci, await resolveCustomerId(ctx, input.customer));
      const ci = await getCi(ctx, hit.id);
      return {
        id: ci.id,
        name: ci.name,
        type: ci.type.name,
        hostname: ci.hostname,
        fqdn: ci.fqdn,
        ipAddress: ci.ipAddress,
        status: ci.status,
        environment: ci.environment,
        criticality: ci.criticality,
        customer: ci.customerName,
        site: ci.siteName,
        ownerTeam: ci.ownerTeamName,
        manufacturer: ci.manufacturer,
        model: ci.model,
        os: [ci.osName, ci.osVersion].filter(Boolean).join(' ') || null,
        serialNumber: ci.serialNumber,
        lastSeenAt: iso(ci.lastSeenAt),
        services: ci.services.map((s) => s.name),
        asset: ci.asset ? { tag: ci.asset.tag, warrantyEnd: ci.asset.warrantyEnd, amcEnd: ci.asset.amcEnd, lifecycleStage: ci.asset.lifecycleStage } : null,
        relationships: [...ci.relationships.outbound.map((r) => ({ relation: r.typeName, ci: r.ci.name, type: r.ci.typeName })), ...ci.relationships.inbound.map((r) => ({ relation: r.inverseName, ci: r.ci.name, type: r.ci.typeName }))].slice(0, 40),
        openTickets: ci.openTickets.slice(0, 15).map((t) => ({ number: t.number, title: t.title, status: t.status, link: ticketLink(ctx, t.id) })),
        recentChanges: ci.recentChanges.slice(0, 10).map((t) => ({ number: t.number, title: t.title, status: t.status, createdAt: iso(t.createdAt), link: ticketLink(ctx, t.id) })),
        link: `/cmdb/${ci.id}`,
      };
    },
    summary: (input, result) => `Read CI ${(result as { name: string }).name ?? input.ci}`,
  }),

  define({
    name: 'ci_history',
    description: 'Audit history of a configuration item (attribute changes, relationship changes, discovery updates).',
    inputSchema: z.object({ ci: z.string().max(200), customer: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() }),
    requires: ['cmdb:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const hit = await resolveCi(ctx, input.ci, await resolveCustomerId(ctx, input.customer));
      const res = await ciHistory(ctx, hit.id, input.limit ?? 25);
      return { ci: 'name' in hit ? hit.name : hit.id, items: res.items.map((r) => ({ at: iso(r.occurredAt), by: r.userName, action: r.action, source: r.source, entity: r.entityLabel, changes: Object.fromEntries(Object.entries(r.changes ?? {}).slice(0, 12).map(([k, v]) => [k, { old: trunc(String((v as { old: unknown }).old ?? ''), 80), new: trunc(String((v as { new: unknown }).new ?? ''), 80) }])) })) };
    },
    summary: (input, result) => `Read ${(result as { items: unknown[] }).items.length} history entries of ${input.ci}`,
  }),

  define({
    name: 'impact_analysis',
    description: 'Downstream impact of a configuration item: dependent CIs, affected business services and their open tickets.',
    inputSchema: z.object({ ci: z.string().max(200), customer: z.string().max(200).optional() }),
    requires: ['cmdb:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const hit = await resolveCi(ctx, input.ci, await resolveCustomerId(ctx, input.customer));
      const res = await ciImpact(ctx, hit.id);
      return { root: res.root.name, dependents: res.dependents.slice(0, 40).map((d) => ({ name: d.name, type: d.typeName, criticality: d.criticality, depth: d.depth, via: d.via, path: d.path.join(' → ') })), businessServices: res.businessServices.map((b) => b.name), openTickets: res.openTickets.slice(0, 15).map((t) => ({ number: t.number, title: t.title, status: t.status, link: ticketLink(ctx, t.id) })), truncated: res.truncated };
    },
    summary: (input, result) => `Analysed impact of ${input.ci} (${(result as { dependents: unknown[] }).dependents.length} dependents)`,
  }),

  define({
    name: 'list_assets',
    description: 'Assets by customer / search text, or assets whose warranty or AMC expires within N days.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), q: z.string().max(200).optional(), expiring: z.enum(['warranty', 'amc']).optional(), expiringWithinDays: z.number().int().min(0).max(3650).optional(), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['assets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      if (input.expiring) {
        const res = await expiringAssets(ctx, { days: input.expiringWithinDays ?? 90, kind: input.expiring, customerId, limit: input.limit ?? 20 });
        return { kind: res.kind, days: res.days, items: res.items.map((a) => ({ tag: a.tag, name: a.name, customer: a.customerName, site: a.siteName, model: a.model, serialNumber: a.serialNumber, warrantyEnd: a.warrantyEnd, amcEnd: a.amcEnd, lifecycle: a.lifecycleStage, coverage: a.coverage.status, link: `/assets/${a.id}` })) };
      }
      const res = await listAssetsMin(ctx, { page: 1, pageSize: input.limit ?? 20, q: input.q, customerId });
      return { total: res.total, items: res.items.map((a) => ({ tag: a.tag, name: a.name, serialNumber: a.serialNumber, link: `/assets/${a.id}` })) };
    },
    summary: (input, result) => `Listed ${(result as { items: unknown[] }).items.length} assets${input.expiring ? ` with ${input.expiring} expiring` : ''}`,
  }),

  define({
    name: 'knowledge_search',
    description: 'Search published knowledge articles (SOPs, runbooks, known errors, troubleshooting). Set includeBody to read the top articles.',
    inputSchema: z.object({ q: z.string().min(2).max(300), customer: z.string().max(200).optional(), includeBody: z.boolean().optional(), limit: z.number().int().min(1).max(10).optional() }),
    requires: ['kb:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const res = await kbSuggest(ctx, { q: input.q, customerId, limit: input.limit ?? 5 });
      const items: Record<string, unknown>[] = [];
      for (const a of res.items) {
        const row: Record<string, unknown> = { id: a.id, number: a.number, title: a.title, summary: a.summary, type: a.articleType, link: `/knowledge/${a.id}` };
        if (input.includeBody && items.length < 3) {
          const full = await getArticle(ctx, a.id, { noView: true });
          row.body = trunc(full.body, 2000);
        }
        items.push(row);
      }
      return { items };
    },
    summary: (input, result) => `Searched knowledge for "${input.q}" (${(result as { items: unknown[] }).items.length} articles)`,
  }),

  define({
    name: 'problem_candidates',
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
    name: 'my_workload',
    description: "The user's own open tickets ordered by due date, with counts of breached and due-soon items.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).optional() }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const res = await listTickets(ctx, listQuery({ page: 1, pageSize: input.limit ?? 20, sort: 'dueAt', order: 'asc', mine: true, open: true }));
      const soon = Date.now() + 4 * 3_600_000;
      const items = res.items.map((t) => compactTicket(ctx, t));
      const breached = items.filter((t) => t.sla?.breached).length;
      return { total: res.total, breached, dueWithin4h: res.items.filter((t) => t.dueAt && t.dueAt.getTime() <= soon && t.dueAt.getTime() >= Date.now()).length, overdue: res.items.filter((t) => t.dueAt && t.dueAt.getTime() < Date.now()).length, items, facts: [`${res.total} open tickets assigned to ${ctx.user.name}${breached ? `, ${breached} with a breached SLA` : ''}`] };
    },
    summary: (_i, result) => `Read workload (${(result as { total: number }).total} open tickets)`,
  }),

  define({
    name: 'out_of_scope_work',
    description: 'Tickets classified as out of scope in a period, grouped by customer or service, with counts and sample ticket numbers.',
    inputSchema: z.object({ days: z.number().int().min(1).max(365).optional(), groupBy: z.enum(['customer', 'service']).optional(), customer: z.string().max(200).optional() }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      ctx.require('tickets:read');
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
      return { days, groupBy: by, total: rows.reduce((s, r) => s + r.count, 0), groups: rows };
    },
    summary: (input, result) => `Found ${(result as { total: number }).total} out-of-scope tickets in ${input.days ?? 30} days`,
  }),

  define({
    name: 'top_services_by_incidents',
    description: 'Services ranked by number of incidents in a period (optionally one customer).',
    inputSchema: z.object({ days: z.number().int().min(1).max(365).optional(), customer: z.string().max(200).optional(), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      ctx.require('tickets:read');
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

  define({
    name: 'major_incidents',
    description: 'Major incidents in progress (or recently resolved): bridge, commander, last and next stakeholder update, child incidents. Use for "any major incidents?", "what is on the bridge", "is the MI update overdue".',
    inputSchema: z.object({ status: z.enum(['active', 'resolved', 'review_done', 'all']).optional().describe('Defaults to active'), customer: z.string().max(200).optional() }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = input.customer ? await resolveCustomerId(ctx, input.customer, false) : null;
      const res = await listMajor(ctx, { status: input.status ?? 'active', customerId: customerId ?? undefined, pageSize: 20 });
      return {
        summary: res.summary,
        items: res.items.map((m) => ({ number: m.number, title: m.title, customer: m.customerName, status: m.status, ticketStatus: m.ticketStatus?.label ?? null, priority: m.priority?.label ?? null, declaredAt: iso(m.declaredAt), commander: m.commanderName, commsLead: m.commsLeadName, lastUpdateAt: iso(m.lastUpdateAt), nextUpdateDueAt: iso(m.nextUpdateDueAt), updateOverdue: m.overdue, stakeholderUpdates: m.updatesCount, childIncidents: m.childrenCount, bridge: m.bridgeUrl, link: ticketLink(ctx, m.ticketId) })),
      };
    },
    summary: (input, result) => `Listed ${(result as { items: unknown[] }).items.length} ${input.status ?? 'active'} major incident(s)`,
  }),
  define({
    name: 'upcoming_maintenance',
    description: 'Planned preventive-maintenance occurrences and scheduled field visits for a customer in the next N days (default 60).',
    inputSchema: z.object({ customer: z.string().max(200).optional(), days: z.number().int().min(1).max(365).optional() }),
    requires: ['pm:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer, true)!;
      ctx.requireCustomer(customerId);
      const days = input.days ?? 60;
      const today = new Date().toISOString().slice(0, 10);
      const until = new Date(Date.now() + days * 86_400_000);
      const pm = await ctx.tx
        .select({ id: schema.pmOccurrences.id, program: schema.pmPrograms.name, plannedDate: schema.pmOccurrences.plannedDate, scheduledDate: schema.pmOccurrences.scheduledDate, status: schema.pmOccurrences.status, site: schema.sites.name, engineer: schema.users.name })
        .from(schema.pmOccurrences)
        .innerJoin(schema.pmPrograms, eq(schema.pmPrograms.id, schema.pmOccurrences.programId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.pmPrograms.siteId))
        .leftJoin(schema.users, eq(schema.users.id, schema.pmOccurrences.engineerId))
        .where(and(eq(schema.pmOccurrences.customerId, customerId!), inArray(schema.pmOccurrences.status, ['planned', 'scheduled', 'rescheduled']), gte(schema.pmOccurrences.plannedDate, today), lte(schema.pmOccurrences.plannedDate, until.toISOString().slice(0, 10))))
        .orderBy(asc(schema.pmOccurrences.plannedDate))
        .limit(20);
      const visits = await ctx.tx
        .select({ id: schema.fieldVisits.id, number: schema.fieldVisits.number, title: schema.fieldVisits.title, status: schema.fieldVisits.status, scheduledStart: schema.fieldVisits.scheduledStart, scheduledEnd: schema.fieldVisits.scheduledEnd, site: schema.sites.name, engineer: schema.users.name })
        .from(schema.fieldVisits)
        .leftJoin(schema.sites, eq(schema.sites.id, schema.fieldVisits.siteId))
        .leftJoin(schema.users, eq(schema.users.id, schema.fieldVisits.engineerId))
        .where(and(eq(schema.fieldVisits.customerId, customerId!), inArray(schema.fieldVisits.status, ['requested', 'scheduled', 'in_progress']), gte(schema.fieldVisits.scheduledStart, new Date(Date.now() - 86_400_000)), lte(schema.fieldVisits.scheduledStart, until)))
        .orderBy(asc(schema.fieldVisits.scheduledStart))
        .limit(20);
      return { days, maintenance: pm, visits: visits.map((v) => ({ ...v, scheduledStart: iso(v.scheduledStart), scheduledEnd: iso(v.scheduledEnd) })) };
    },
    summary: (input, result) => `Read upcoming maintenance (${(result as { maintenance: unknown[] }).maintenance.length} PM, ${(result as { visits: unknown[] }).visits.length} visits) for the next ${input.days ?? 60} days`,
  }),
];

// ---------------------------------------------------------------- action tools (require ai:act + the underlying permission)

export const ACTION_TOOLS: AiTool[] = [
  define({
    name: 'create_ticket',
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
    run: async (ctx, input) => {
      const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
      const [priority, impact, urgency, category, service, site, source] = await Promise.all([
        resolveOption(ctx, 'ticket_priority', input.priority),
        resolveOption(ctx, 'ticket_impact', input.impact),
        resolveOption(ctx, 'ticket_urgency', input.urgency),
        resolveOption(ctx, 'ticket_category', input.category),
        resolveService(ctx, input.service),
        resolveSite(ctx, customerId, input.site),
        optionByKey(ctx.tx, 'ticket_source', 'ai'),
      ]);
      const ci = input.ci ? await resolveCi(ctx, input.ci, customerId) : null;
      const t = await createTicket(ctx, {
        type: input.type,
        customerId,
        title: input.title,
        description: input.description ?? null,
        priorityId: isCustomerUser(ctx) ? null : (priority?.id ?? null),
        impactId: impact?.id ?? null,
        urgencyId: urgency?.id ?? null,
        categoryId: category?.id ?? null,
        serviceId: service?.id ?? null,
        siteId: site?.id ?? null,
        primaryCiId: ci?.id ?? null,
        ciIds: ci ? [ci.id] : undefined,
        sourceId: source?.id ?? null,
        requesterUserId: isCustomerUser(ctx) ? ctx.user.id : null,
      });
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
    name: 'add_comment',
    description: 'Add a comment to a ticket. internal=true adds an internal work note (MSP engineers only); otherwise the comment is visible to the customer.',
    inputSchema: z.object({ ticket: ticketRef, body: z.string().min(1).max(20000), internal: z.boolean().optional() }),
    requires: ['tickets:comment'],
    portal: ['portal:tickets'],
    action: true,
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
      return `Add ${internal ? 'an internal work note' : 'a comment visible to the customer'} to ${t.number} ("${t.title.slice(0, 80)}"): "${input.body.length > 160 ? `${input.body.slice(0, 160)}…` : input.body}"`;
    },
  }),

  define({
    name: 'assign_ticket',
    description: 'Assign a ticket to an engineer ("me", name or email) and/or a team (key or name).',
    inputSchema: z.object({ ticket: ticketRef, engineer: z.string().max(200).optional(), team: z.string().max(200).optional(), comment: z.string().max(2000).optional() }),
    requires: ['tickets:assign'],
    portal: null,
    action: true,
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
      return `Assign ${t.number} ("${t.title.slice(0, 80)}") to ${[eng?.name, team ? `the team ${team.name}` : null].filter(Boolean).join(' and ')}${input.comment ? ` with the comment "${input.comment}"` : ''}`;
    },
  }),

  define({
    name: 'set_status',
    description: 'Change the status of a ticket (status key or label, e.g. "in_progress", "pending_customer", "resolved"). Resolving requires resolution notes.',
    inputSchema: z.object({ ticket: ticketRef, status: z.string().max(60), resolutionNotes: z.string().max(20000).optional(), comment: z.string().max(20000).optional() }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const statuses = await applicableStatuses(ctx, t.type);
      const r = input.status.trim().toLowerCase();
      const to = statuses.find((s) => s.key === r) ?? statuses.find((s) => s.label.toLowerCase() === r) ?? statuses.find((s) => s.label.toLowerCase().startsWith(r));
      if (!to) throw new ValidationError(`Unknown status "${input.status}" for ${t.type}. Valid: ${statuses.map((s) => s.key).join(', ')}`);
      const updated = await changeStatus(ctx, t.id, { statusId: to.id, resolutionNotes: input.resolutionNotes ?? null, comment: input.comment ?? null });
      const d = await getTicket(ctx, updated.id);
      return { updated: true, ticket: d.number, status: d.status?.label, statusCategory: d.status?.category, link: ticketLink(ctx, d.id) };
    },
    summary: (input, result) => `Set ${input.ticket.toUpperCase()} to ${(result as { status: string }).status}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const statuses = await applicableStatuses(ctx, t.type);
      const r = input.status.trim().toLowerCase();
      const to = statuses.find((s) => s.key === r) ?? statuses.find((s) => s.label.toLowerCase() === r) ?? statuses.find((s) => s.label.toLowerCase().startsWith(r));
      if (!to) throw new ValidationError(`Unknown status "${input.status}" for ${t.type}. Valid: ${statuses.map((s) => s.key).join(', ')}`);
      return `Set ${t.number} ("${t.title.slice(0, 80)}") to ${to.label}${input.resolutionNotes ? ` with the resolution notes "${input.resolutionNotes.slice(0, 120)}"` : ''}${input.comment ? ` and the comment "${input.comment.slice(0, 120)}"` : ''}`;
    },
  }),

  define({
    name: 'link_tickets',
    tier: 'write_low',
    description: 'Link two tickets of the same customer (related, duplicate_of, caused_by, blocks, child_of, problem_of, change_for, resolved_by).',
    inputSchema: z.object({ ticket: ticketRef, target: ticketRef.describe('The other ticket number or id'), linkType: z.enum(['related', 'duplicate_of', 'caused_by', 'blocks', 'child_of', 'problem_of', 'change_for', 'resolved_by']).optional() }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
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
];

export const ALL_TOOLS: AiTool[] = [...READ_TOOLS, ...ACTION_TOOLS];
export const toolByName = (name: string) => ALL_TOOLS.find((t) => t.name === name) ?? null;

/** A tool is offered when the principal holds every required permission (portal variants for customer users) and `ai:act` for actions. */
export function toolAvailable(ctx: Ctx, tool: AiTool): boolean {
  if (!ctx.can('ai:use')) return false;
  if (tool.action && !ctx.can('ai:act')) return false;
  const perms = isCustomerUser(ctx) ? tool.portal : tool.requires;
  if (!perms) return false;
  return perms.every((p) => ctx.can(p));
}

export const availableTools = (ctx: Ctx): AiTool[] => ALL_TOOLS.filter((t) => !t.hidden && toolAvailable(ctx, t));

/** zod → JSON schema for the provider (draft 2020-12 with the `$schema` marker removed). */
export function toolJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  if (!js.type) js.type = 'object';
  if (!js.properties) js.properties = {};
  return js;
}

export const toolDefinitions = (tools: AiTool[]): ToolDefinition[] => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: toolJsonSchema(t.inputSchema) }));

/** Removes secret-looking keys before persisting tool inputs (kept for compatibility; see redact.ts). */
export { compactForTrace as stripSecrets } from './redact';
