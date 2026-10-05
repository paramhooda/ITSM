import { z } from 'zod';
import { ValidationError } from '@/core/errors';
import type { TicketRow } from '@/modules/tickets/common';
import { resolveRecipients } from '@/modules/tickets/notify';
import { csatSummary, listResponses, sendSurvey } from '@/modules/surveys/service';
import { answerPortalSurvey } from '@/modules/surveys/portal';
import { GROUP_BY } from '@/modules/surveys/schemas';
import { define } from './types';
import { ticketRef } from './core';
import { isCustomerUser, ticketLink, iso, trunc, resolveTicket, resolveCustomerId, forCustomer } from '../helpers';

/**
 * Customer satisfaction tools: the CSAT figures and the poorly rated tickets
 * (staff with surveys:read; portal users for their own organisation, never
 * naming an engineer), the customer's own rating of a ticket (portal only)
 * and the manual survey send (outbound, always confirmed). Nothing here calls
 * the model.
 */

const short = (t: Pick<TicketRow, 'number' | 'title'>) => `${t.number} ("${t.title.slice(0, 80)}")`;
const listLink = (ctx: Parameters<typeof isCustomerUser>[0]) => (isCustomerUser(ctx) ? '/portal/tickets?status=rate' : '/reports/csat');
const pctText = (v: number | null) => (v === null ? 'n/a' : `${v}%`);

export const SURVEYS: ReturnType<typeof define>[] = [
  define({
    name: 'csat_summary',
    toolset: 'reports',
    description: 'Customer satisfaction (CSAT) figures for a period: average rating out of 5, share satisfied, response rate, low ratings, a breakdown by customer, engineer, team, service, priority or month, and the lowest-rated tickets. Answers "what is our CSAT this month", "how satisfied is ABC", "which engineer has the best ratings". Customer users get their own organisation only, broken down by service, priority or month.',
    inputSchema: z.object({
      customer: z.string().max(200).optional().describe('Customer name, code or id (staff only; ignored for customer users)'),
      days: z.number().int().min(1).max(365).optional().describe('Look-back window (default 30)'),
      groupBy: z.enum(GROUP_BY).optional().describe('Breakdown: customer (default), engineer, team, service, priority, channel or month'),
    }),
    requires: ['surveys:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const days = input.days ?? 30;
      const s = await csatSummary(ctx, { customerId, days, groupBy: input.groupBy });
      const f = s.figures;
      return {
        days,
        groupBy: s.groupBy,
        figures: { sent: f.sent, responses: f.responses, responseRate: f.responseRate, avg: f.avg, satisfiedPct: f.satisfiedPct, low: f.low, distribution: f.distribution },
        groups: s.groups.slice(0, 20).map((g) => ({ label: g.label, sent: g.sent, responses: g.responses, avg: g.avg, satisfiedPct: g.satisfiedPct, low: g.low })),
        lowest: s.lowest.slice(0, 5).map((l) => ({ ticket: l.number, rating: l.rating, comment: trunc(l.comment, 200), answeredAt: iso(l.answeredAt), link: ticketLink(ctx, l.ticketId) })),
        facts: [
          `Average CSAT ${f.avg ?? 'n/a'}/5 from ${f.responses} response(s) over ${days} days (${pctText(f.responseRate)} response rate, ${pctText(f.satisfiedPct)} satisfied, ${f.low} low rating(s))${await forCustomer(ctx, customerId)}`,
          `${f.sent} survey(s) sent in the period; breakdown by ${s.groupBy} with ${s.groups.length} group(s)`,
        ],
        link: listLink(ctx),
      };
    },
    summary: (input, result) => `Computed CSAT (${(result as { days: number }).days} days, by ${(result as { groupBy: string }).groupBy ?? input.groupBy ?? 'customer'})`,
  }),

  define({
    name: 'csat_low_ratings',
    toolset: 'reports',
    description: 'The tickets whose customer rating was poor (at or below the threshold, default 2 out of 5) with the customer\'s comment, so the reason can be followed up. Answers "which tickets got a bad rating", "why was ABC unhappy last month". Customer users get their own organisation only, without engineer names.',
    inputSchema: z.object({
      customer: z.string().max(200).optional().describe('Customer name, code or id (staff only; ignored for customer users)'),
      days: z.number().int().min(1).max(365).optional().describe('Look-back window (default 30)'),
      threshold: z.number().int().min(1).max(4).optional().describe('Ratings at or below this count as low (default: the low-rating setting)'),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    requires: ['surveys:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const days = input.days ?? 30;
      const res = await listResponses(ctx, { page: 1, pageSize: input.limit ?? 10, customerId, days, low: true, lowThreshold: input.threshold, sort: 'rating', order: 'asc' });
      const staff = !isCustomerUser(ctx);
      const threshold = input.threshold ?? 'the low-rating threshold';
      return {
        days,
        threshold,
        total: res.total,
        items: res.items.map((r) => ({ ticket: r.number, title: trunc(r.title, 80), customer: r.customerName, rating: r.rating, comment: trunc(r.comment, 300), answeredAt: iso(r.answeredAt), ...(staff ? { assignee: r.assigneeName ?? null } : {}), link: ticketLink(ctx, r.ticketId) })),
        facts: [`${res.total} rating(s) at or below ${typeof threshold === 'number' ? `${threshold}/5` : threshold} over ${days} days${await forCustomer(ctx, customerId)}`],
        link: listLink(ctx),
      };
    },
    summary: (_input, result) => `Listed ${(result as { items: unknown[] }).items.length} low rating(s)`,
  }),

  define({
    name: 'rate_ticket',
    toolset: 'tickets',
    description: 'Customer rates a resolved or closed ticket from 1 (very dissatisfied) to 5 (very satisfied) with an optional comment; one rating per ticket. Answers "rate INC-001234 four stars", "give my last ticket a 5 and say the engineer was quick".',
    inputSchema: z.object({ ticket: ticketRef, rating: z.number().int().min(1).max(5), comment: z.string().max(4000).optional() }),
    requires: [],
    portalOnly: true,
    portal: ['portal:tickets'],
    action: true,
    tier: 'write',
    invalidates: ['tickets', 'surveys'],
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      return `Rate ${short(t)} ${input.rating}/5${input.comment ? ` with the comment "${trunc(input.comment.replace(/\s+/g, ' '), 120)}"` : ''}`;
    },
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const view = await answerPortalSurvey(ctx, t.id, { rating: input.rating, comment: input.comment ?? null }, 'assistant');
      return { rated: true, ticket: t.number, rating: view.rating, link: ticketLink(ctx, t.id), facts: [`${t.number} rated ${view.rating}/5`] };
    },
    summary: (input) => `Rated ${input.ticket.toUpperCase()} ${input.rating}/5`,
  }),

  define({
    name: 'send_survey',
    toolset: 'tickets',
    description: 'Sends (or re-sends) the customer satisfaction survey for a resolved or closed ticket to its requester, bypassing sampling and the fatigue rule. Reaches the customer, so it is always confirmed. Answers "send the survey for INC-001234 again", "ask the customer to rate this ticket".',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['surveys:manage'],
    portal: null,
    action: true,
    tier: 'outbound',
    invalidates: ['tickets', 'surveys'],
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const { portal } = await resolveRecipients(ctx.tx, t, { requester: true });
      const r = portal[0];
      if (!r) throw new ValidationError('No customer requester to survey');
      return `Send the satisfaction survey for ${short(t)} to ${r.name ?? 'the requester'}${r.email ? ` (${r.email})` : ''}`;
    },
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const view = await sendSurvey(ctx, t.id);
      return { sent: true, ticket: t.number, recipient: view.recipientName ?? view.recipientEmail ?? null, link: ticketLink(ctx, t.id), facts: [`Survey sent for ${t.number} (send ${view.sendCount})`] };
    },
    summary: (input, result) => `Sent the satisfaction survey for ${(result as { ticket?: string }).ticket ?? input.ticket.toUpperCase()}`,
  }),
];
