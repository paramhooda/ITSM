import { z } from 'zod';
import { APPLICATIONS, pagesFor, type AppPage } from '@itsm/shared';
import { getTicket } from '@/modules/tickets/service';
import { listTickets } from '@/modules/tickets/list';
import { timeline } from '@/modules/tickets/activity';
import { suggest as kbSuggest, getArticle } from '@/modules/knowledge/service';
import { postgresSearchProvider } from '@/modules/search/postgres';
import type { SearchType } from '@/modules/search/provider';
import { define, TOOLSET_KEYS } from './types';
import { isCustomerUser, trunc, listQuery, resolveTicket, resolveCustomerId, compactTicket, compactDetail, compactTimeline } from '../helpers';
import { queryTicketsSchema, runTicketQuery, describeTicketQuery } from '../query';

/**
 * Core tools: always offered, whatever the page. Search, the ticket semantic
 * layer, one ticket, knowledge, the user's own work, the application guide and
 * the meta-tool that enables another toolset.
 */

export const ticketRef = z.string().max(80).describe('Ticket number (e.g. INC-000123) or id');

const WORDS = /[a-z0-9]+/g;
const tokens = (s: string) => new Set((s.toLowerCase().match(WORDS) ?? []).filter((w) => w.length > 2));
function scorePage(page: AppPage, q: Set<string>): number {
  if (!q.size) return 0;
  const hay = `${page.label} ${page.purpose} ${(page.howTo ?? []).join(' ')} ${page.app} ${page.key.replace(/\./g, ' ')}`.toLowerCase();
  const title = page.label.toLowerCase();
  let score = 0;
  for (const w of q) {
    if (title.includes(w)) score += 3;
    else if (hay.includes(w)) score += 1;
  }
  return score;
}

export const CORE: ReturnType<typeof define>[] = [
  define({
    name: 'query_tickets',
    toolset: 'core',
    description: "The one way to answer questions about tickets: how many (mode 'count'), by priority/status/customer/team/engineer/service (mode 'breakdown' + groupBy), or which ones (mode 'list'). Staff can also ask which tickets are likely to breach (breachRisk) or where the customer sounded unhappy (sentiment). The result's `facts` lines carry the exact figures and say what was counted; quote them. Unless the user says otherwise, tickets means open tickets (new, in progress or pending).",
    inputSchema: queryTicketsSchema,
    requires: ['tickets:read'],
    portal: ['portal:tickets'],
    action: false,
    run: (ctx, input) => runTicketQuery(ctx, input),
    summary: describeTicketQuery,
  }),

  define({
    name: 'search',
    toolset: 'core',
    description: 'Global search across tickets, customers, assets, CIs, contracts, services, knowledge articles, known errors and visits. Use when you do not know which kind of record the user means.',
    inputSchema: z.object({ q: z.string().min(2).max(200), types: z.array(z.enum(['ticket', 'customer', 'asset', 'ci', 'contract', 'service', 'kb', 'visit', 'known_error'])).optional(), limit: z.number().int().min(1).max(20).optional() }),
    requires: [],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const types = (input.types ?? ['ticket', 'customer', 'asset', 'ci', 'contract', 'service', 'kb', 'visit', 'known_error']) as SearchType[];
      const hits = await postgresSearchProvider.search(ctx, input.q, types, input.limit ?? 10);
      return { hits: hits.slice(0, 40).map((h) => ({ type: h.type, id: h.id, title: h.title, subtitle: h.subtitle ?? null, badge: h.badge ?? null, link: h.link })) };
    },
    summary: (input, result) => `Searched "${input.q}" (${(result as { hits: unknown[] }).hits.length} hits)`,
  }),

  define({
    name: 'get_ticket',
    toolset: 'core',
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
    name: 'knowledge_search',
    toolset: 'core',
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
    name: 'my_workload',
    toolset: 'core',
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
    name: 'app_guide',
    toolset: 'core',
    description: 'Where things are and how they are done in Progression: pages the user may open, what each is for, the steps for common tasks. Use for "where do I…", "how do I…", "what can you do", "what is this page". Returns pages with their route (use navigate to open one).',
    inputSchema: z.object({ question: z.string().max(300).optional().describe('What the user wants to find or do'), page: z.string().max(80).optional().describe('A page key or route to describe') }),
    requires: [],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const portal = isCustomerUser(ctx);
      const can = (...perms: Parameters<typeof ctx.can>[0][]) => perms.some((perm) => ctx.can(perm));
      const pages = pagesFor(can, portal);
      const apps = APPLICATIONS.filter((a) => (portal ? a.portal : a.key !== 'portal') && (!a.perm || can(...a.perm)));
      const describe = (pg: AppPage) => ({ key: pg.key, page: pg.label, application: apps.find((a) => a.key === pg.app)?.label ?? pg.app, route: pg.route.includes(':') ? null : pg.route, purpose: pg.purpose, howTo: pg.howTo ?? [], filters: pg.filters ?? [] });
      if (input.page) {
        const needle = input.page.trim().toLowerCase();
        const hit = pages.find((pg) => pg.key === needle || pg.route === needle || pg.label.toLowerCase() === needle);
        if (hit) return { pages: [describe(hit)] };
      }
      const q = tokens(input.question ?? input.page ?? '');
      const ranked = pages.map((pg) => ({ pg, score: scorePage(pg, q) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
      return {
        applications: apps.map((a) => ({ key: a.key, label: a.label, description: a.description })),
        pages: (ranked.length ? ranked.map((x) => x.pg) : pages.filter((pg) => !pg.route.includes(':')).slice(0, 12)).map(describe),
      };
    },
    summary: (input, result) => `Looked up the application guide${input.question ? ` for "${input.question}"` : ''} (${(result as { pages: unknown[] }).pages.length} pages)`,
  }),

  define({
    name: 'enable_toolset',
    toolset: 'core',
    description: 'Make another group of tools available for this conversation when none of the current tools fits: tickets (ticket actions, tasks, time, links, bulk, task boards), triage, incident (major incidents), approvals, customers, contracts (contracts, entitlements, SLA, service levels), cmdb (CIs, impact, discovery, monitoring events), assets (assets, software, licences), field (visits, maintenance), knowledge, reports (reports, dashboards, trends), config (option lists, teams, services, rules, settings), admin (change configuration), iam (users, roles, keys, audit), profile (the person\'s own notification preferences and WhatsApp number).',
    inputSchema: z.object({ toolset: z.enum(TOOLSET_KEYS) }),
    requires: [],
    portal: ['portal:access'],
    action: false,
    // The loop handles this tool itself (it changes the tools offered on the next iteration); this body only runs in tests.
    run: async (_ctx, input) => ({ enabled: input.toolset }),
    summary: (input) => `Enabled the ${input.toolset} tools`,
  }),
];
