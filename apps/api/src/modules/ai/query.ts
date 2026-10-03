import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { TicketType } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { listTickets, countTickets, groupTickets, GROUP_DIMENSIONS, type GroupDimension } from '@/modules/tickets/list';
import { optionByKey } from '@/modules/tickets/common';
import type { ListQuery } from '@/modules/tickets/schemas';
import { isCustomerUser, listQuery, resolveCustomerId, resolveOption, resolveService, resolveSite, resolveEngineer, resolveTeam, compactTicket } from './helpers';

/**
 * The semantic query layer for tickets.
 *
 * The model never counts rows and never writes SQL. It fills a small, typed query
 * (what to count, which lifecycle bucket, which filters, how to group) and the
 * server runs the SAME predicates the ticket list uses, so an answer in the chat
 * can never disagree with the screen. Every result carries a plain-language
 * `definition` of what was counted and a `facts` line with the exact figure; the
 * chat loop makes sure the model's reply states that figure.
 */

export const STATUS_BUCKETS = ['open', 'all', 'new', 'in_progress', 'pending', 'awaiting_customer', 'awaiting_approval', 'resolved', 'closed', 'cancelled'] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

const BUCKET_TEXT: Record<StatusBucket, string> = {
  open: 'open tickets (new, in progress or pending)',
  all: 'tickets of any status',
  new: 'new tickets (not yet picked up)',
  in_progress: 'tickets in progress',
  pending: 'pending tickets (waiting on the customer, a vendor, a change or on hold)',
  awaiting_customer: 'tickets waiting on the customer',
  awaiting_approval: 'tickets awaiting approval',
  resolved: 'resolved tickets',
  closed: 'closed tickets',
  cancelled: 'cancelled tickets',
};

const DIMENSION_TEXT: Record<GroupDimension, string> = {
  status: 'status',
  statusCategory: 'lifecycle stage',
  type: 'ticket type',
  priority: 'priority',
  customer: 'customer',
  team: 'team',
  assignee: 'engineer',
  service: 'service',
  category: 'category',
  site: 'site',
  slaState: 'SLA state',
};

export const queryTicketsSchema = z.object({
  mode: z.enum(['count', 'list', 'breakdown']).default('count').describe("'count' answers how-many questions with one exact figure; 'breakdown' answers by-X questions (needs groupBy); 'list' returns the tickets themselves (at most 20)."),
  status: z.enum(STATUS_BUCKETS).optional().describe("Lifecycle bucket. Omit or 'open' = not yet resolved (new, in progress or pending). 'all' = every ticket ever, including resolved and closed."),
  type: z.enum(['incident', 'request', 'problem', 'change']).optional(),
  priority: z.string().max(40).optional().describe('Priority key or label, e.g. "p1" or "P1 - Critical"'),
  customer: z.string().max(200).optional().describe('Customer name, code or id (ignored for portal users: always their own organisation)'),
  assignee: z.string().max(200).optional().describe('"me", an engineer name or email'),
  unassigned: z.boolean().optional(),
  team: z.string().max(200).optional().describe('Team key or name'),
  service: z.string().max(200).optional().describe('Service name or key'),
  site: z.string().max(200).optional().describe('Site name or code (needs a customer)'),
  scope: z.enum(['in_scope', 'out_of_scope', 'unknown']).optional(),
  slaState: z.enum(['breached', 'at_risk', 'ok']).optional(),
  breachRisk: z.enum(['high', 'medium', 'low']).optional().describe('Forecast of an SLA breach (scored every few minutes from the clock, how long similar tickets take and who is working on it); staff only'),
  sentiment: z.enum(['unhappy', 'angry', 'negative', 'neutral', 'positive']).optional().describe("Mood of the customer's last comment; 'unhappy' = negative or angry; staff only"),
  isMajor: z.boolean().optional(),
  createdWithinDays: z.number().int().min(1).max(3650).optional().describe('Only tickets raised in the last N days'),
  createdFrom: z.string().max(30).optional().describe('ISO date (inclusive)'),
  createdTo: z.string().max(30).optional().describe('ISO date (inclusive)'),
  q: z.string().max(200).optional().describe('Words in the number, title or description'),
  groupBy: z.enum(GROUP_DIMENSIONS).optional().describe("Dimension for mode 'breakdown'"),
  limit: z.number().int().min(1).max(20).optional().describe("Rows for mode 'list' (default 10)"),
  sort: z.enum(['createdAt', 'updatedAt', 'dueAt', 'priority']).optional(),
});
export type TicketQueryInput = z.infer<typeof queryTicketsSchema>;

export interface TicketQueryResult {
  mode: 'count' | 'list' | 'breakdown';
  /** Plain language for what was counted: "open tickets (new, in progress or pending) for Sample Customer raised in the last 7 days". */
  definition: string;
  total: number;
  /** Exact, server-rendered sentences the model must quote: the one source of numbers. */
  facts: string[];
  groupBy?: GroupDimension;
  groups?: { label: string; count: number; pct: number }[];
  showing?: number;
  items?: ReturnType<typeof compactTicket>[];
}

const resolved = (q: TicketQueryInput, names: { customer?: string | null; assignee?: string | null; team?: string | null; service?: string | null; site?: string | null; priority?: string | null }) => {
  const parts: string[] = [BUCKET_TEXT[q.status ?? 'open']];
  if (q.type) parts[0] = parts[0]!.replace('tickets', `${q.type === 'request' ? 'service requests' : `${q.type}s`}`);
  if (q.isMajor) parts.push('flagged as major');
  if (names.priority) parts.push(`with priority ${names.priority}`);
  if (names.customer) parts.push(`for ${names.customer}`);
  if (names.site) parts.push(`at ${names.site}`);
  if (names.service) parts.push(`on the service ${names.service}`);
  if (q.unassigned) parts.push('with no engineer assigned');
  else if (names.assignee) parts.push(`assigned to ${names.assignee}`);
  if (names.team) parts.push(`with the team ${names.team}`);
  if (q.scope === 'out_of_scope') parts.push('classified out of scope');
  else if (q.scope === 'in_scope') parts.push('classified in scope');
  if (q.slaState === 'breached') parts.push('with a breached SLA');
  else if (q.slaState === 'at_risk') parts.push('with an SLA at risk');
  else if (q.slaState === 'ok') parts.push('with SLAs on track');
  if (q.breachRisk) parts.push(`at ${q.breachRisk} risk of an SLA breach`);
  if (q.sentiment === 'unhappy') parts.push('whose customer sounded unhappy in the last comment');
  else if (q.sentiment) parts.push(`whose customer sounded ${q.sentiment} in the last comment`);
  if (q.createdWithinDays) parts.push(`raised in the last ${q.createdWithinDays} day${q.createdWithinDays === 1 ? '' : 's'}`);
  else if (q.createdFrom && q.createdTo) parts.push(`raised between ${q.createdFrom} and ${q.createdTo}`);
  else if (q.createdFrom) parts.push(`raised since ${q.createdFrom}`);
  else if (q.createdTo) parts.push(`raised up to ${q.createdTo}`);
  if (q.q) parts.push(`matching "${q.q}"`);
  return parts.join(' ');
};

/** Resolves names to ids (within the caller's visibility) and turns the bucket into list predicates. */
async function toListQuery(ctx: Ctx, input: TicketQueryInput) {
  const customerId = await resolveCustomerId(ctx, input.customer);
  const priority = await resolveOption(ctx, 'ticket_priority', input.priority);
  const service = await resolveService(ctx, input.service);
  const assignee = isCustomerUser(ctx) ? null : await resolveEngineer(ctx, input.assignee);
  const team = isCustomerUser(ctx) ? null : await resolveTeam(ctx, input.team);
  const site = input.site ? (customerId ? await resolveSite(ctx, customerId, input.site) : null) : null;
  if (input.site && !customerId) throw new ValidationError('A site filter needs a customer');
  const bucket = input.status ?? 'open';
  const q: Partial<ListQuery> = {
    type: input.type as TicketType | undefined,
    customerId,
    priorityId: priority?.id,
    serviceId: service?.id ?? undefined,
    siteId: site?.id ?? undefined,
    assigneeId: assignee?.id,
    teamId: team?.id,
    unassigned: input.unassigned ? true : undefined,
    scopeStatus: input.scope,
    slaState: input.slaState,
    breachRisk: isCustomerUser(ctx) ? undefined : input.breachRisk,
    sentiment: isCustomerUser(ctx) ? undefined : input.sentiment,
    isMajor: input.isMajor,
    createdFrom: input.createdWithinDays ? new Date(Date.now() - input.createdWithinDays * 86_400_000).toISOString() : input.createdFrom,
    createdTo: input.createdWithinDays ? undefined : input.createdTo,
    q: input.q,
  };
  switch (bucket) {
    case 'open':
      q.open = true;
      break;
    case 'all':
      break;
    case 'new':
      q.statusCategory = 'new';
      break;
    case 'in_progress':
      q.statusCategory = 'open';
      break;
    case 'pending':
      q.statusCategory = 'pending';
      break;
    case 'awaiting_customer':
    case 'awaiting_approval': {
      const key = bucket === 'awaiting_customer' ? 'pending_customer' : 'awaiting_approval';
      const opt = await optionByKey(ctx.tx, 'ticket_status', key);
      q.statusId = opt?.id ?? '00000000-0000-0000-0000-000000000000';
      break;
    }
    default:
      q.statusCategory = bucket;
  }
  const names = { customer: null as string | null, assignee: assignee?.name ?? null, team: team?.name ?? null, service: service?.name ?? null, site: site?.name ?? null, priority: priority?.label ?? null };
  if (customerId) {
    const [c] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
    names.customer = c?.name ?? null;
  }
  return { q, definition: resolved(input, names) };
}

const n = (v: number) => v.toLocaleString('en-US');

export async function runTicketQuery(ctx: Ctx, input: TicketQueryInput): Promise<TicketQueryResult> {
  const mode = input.mode ?? 'count';
  const { q, definition } = await toListQuery(ctx, input);
  if (mode === 'breakdown') {
    const by = input.groupBy ?? 'priority';
    const r = await groupTickets(ctx, listQuery(q), by);
    const groups = r.groups.map((g) => ({ label: g.label, count: g.count, pct: r.total ? Math.round((g.count / r.total) * 100) : 0 }));
    const facts = [`${n(r.total)} ${definition}`, `By ${DIMENSION_TEXT[by]}: ${groups.map((g) => `${g.label} ${n(g.count)}`).join(', ') || 'nothing'}`];
    return { mode, definition, total: r.total, groupBy: by, groups, facts };
  }
  if (mode === 'list') {
    const res = await listTickets(ctx, listQuery({ ...q, page: 1, pageSize: input.limit ?? 10, sort: input.sort ?? 'createdAt', order: input.sort === 'dueAt' || input.sort === 'priority' ? 'asc' : 'desc' }));
    const items = res.items.map((t) => compactTicket(ctx, t));
    const facts = [`${n(res.total)} ${definition}${items.length < res.total ? ` (showing the first ${items.length})` : ''}`];
    return { mode, definition, total: res.total, showing: items.length, items, facts };
  }
  const total = await countTickets(ctx, listQuery(q));
  return { mode, definition, total, facts: [`${n(total)} ${definition}`] };
}

/** One line for the conversation's tool trace. */
export const describeTicketQuery = (input: TicketQueryInput, result: unknown): string => {
  const r = result as TicketQueryResult;
  const mode = input.mode ?? 'count';
  if (mode === 'breakdown') return `Counted ${r.total} ${r.definition} by ${DIMENSION_TEXT[r.groupBy ?? 'priority']}`;
  if (mode === 'list') return `Listed ${r.showing} of ${r.total} ${r.definition}`;
  return `Counted ${r.total} ${r.definition}`;
};
