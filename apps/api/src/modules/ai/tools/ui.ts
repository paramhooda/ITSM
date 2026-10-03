import { z } from 'zod';
import { matchRoute, pageAllowed, pageByKey, buildPath, type AppPage } from '@itsm/shared';
import { ValidationError, ForbiddenError } from '@/core/errors';
import type { Ctx } from '@/core/context';
import { define } from './types';
import { isCustomerUser, ticketLink, resolveTicket, resolveCustomerId, resolveContract, resolveAsset, resolveCi, resolveVisit, resolveArticle, resolveOption, resolveService, resolveSite } from '../helpers';

/**
 * UI tools: they touch no data. Each returns a `uiAction` the web executes after
 * the reply (router navigation), validated against the application map and the
 * user's permissions so the assistant can only open pages the user may open.
 */

const can = (ctx: Ctx) => (...perms: Parameters<typeof ctx.can>[0][]) => perms.some((perm) => ctx.can(perm));

function allowedPage(ctx: Ctx, pathname: string): { page: AppPage; params: Record<string, string> } {
  const hit = matchRoute(pathname);
  if (!hit || hit.page.hidden) throw new ValidationError(`"${pathname}" is not a page of this application`);
  if (!pageAllowed(hit.page, can(ctx), isCustomerUser(ctx))) throw new ForbiddenError(`The user cannot open ${hit.page.label}`);
  return hit;
}

export const UI: ReturnType<typeof define>[] = [
  define({
    name: 'navigate',
    toolset: 'ui',
    description: 'Open a page of the application for the user (router navigation, no reload). Give the path from app_guide, optionally with query filters the page understands (e.g. /tickets?priority=p1&slaState=breached). Only pages the user may open; say in one sentence what you opened.',
    inputSchema: z.object({ to: z.string().min(1).max(500).describe('Path such as /tickets?assignee=me or /customers/accounts'), reason: z.string().max(200).optional() }),
    requires: [],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const raw = input.to.trim();
      if (!raw.startsWith('/') || raw.startsWith('//')) throw new ValidationError('Give a path inside the application, starting with /');
      const url = new URL(raw, 'http://local');
      const { page, params } = allowedPage(ctx, url.pathname);
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v.slice(0, 200);
      const to = buildPath(page, params, query);
      const dropped = Object.keys(query).filter((k) => !(page.filters ?? []).includes(k));
      return { uiAction: { type: 'navigate', to, label: page.label }, page: page.label, to, ...(dropped.length ? { ignoredFilters: dropped } : {}) };
    },
    summary: (_i, result) => `Opened ${(result as { page: string }).page}`,
  }),

  define({
    name: 'open_record',
    toolset: 'ui',
    description: 'Open one record for the user by reference: a ticket (number), customer (name or code), contract (number), asset (tag), CI (name or hostname), field visit (number) or knowledge article (number or title).',
    inputSchema: z.object({ kind: z.enum(['ticket', 'customer', 'contract', 'asset', 'ci', 'visit', 'article']), ref: z.string().min(1).max(200) }),
    requires: [],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const portal = isCustomerUser(ctx);
      let to: string;
      let label: string;
      switch (input.kind) {
        case 'ticket': {
          const t = await resolveTicket(ctx, input.ref);
          to = ticketLink(ctx, t.id);
          label = t.number;
          break;
        }
        case 'customer': {
          if (portal) throw new ForbiddenError('Customer pages are not part of the portal');
          const id = (await resolveCustomerId(ctx, input.ref, true))!;
          to = `/customers/${id}`;
          label = input.ref;
          break;
        }
        case 'contract': {
          const c = await resolveContract(ctx, input.ref);
          to = portal ? '/portal/services/contracts' : `/contracts/${c.id}`;
          label = c.number;
          break;
        }
        case 'asset': {
          const a = await resolveAsset(ctx, input.ref, portal ? ctx.user.customerId ?? undefined : undefined);
          to = portal ? '/portal/assets/inventory' : `/assets/${a.id}`;
          label = a.tag;
          break;
        }
        case 'ci': {
          if (portal) throw new ForbiddenError('CI pages are not part of the portal');
          const c = await resolveCi(ctx, input.ref);
          to = `/cmdb/cis/${c.id}`;
          label = 'name' in c ? c.name : input.ref;
          break;
        }
        case 'visit': {
          const v = await resolveVisit(ctx, input.ref);
          to = portal ? '/portal/maintenance' : `/field/${v.id}`;
          label = v.number;
          break;
        }
        case 'article': {
          const a = await resolveArticle(ctx, input.ref);
          to = `/knowledge/${a.id}`;
          label = a.number;
          break;
        }
      }
      allowedPage(ctx, to.split('?')[0]!);
      return { uiAction: { type: 'navigate', to, label }, to, label };
    },
    summary: (input, result) => `Opened ${input.kind} ${(result as { label: string }).label}`,
  }),

  define({
    name: 'prefill_form',
    toolset: 'ui',
    description: 'Open the new-ticket form with fields already filled in, so the user reviews and submits it themselves (use when they want to see the form, or when create_ticket is not available). Names are resolved to real values.',
    inputSchema: z.object({
      type: z.enum(['incident', 'request', 'problem', 'change']).optional(),
      customer: z.string().max(200).optional(),
      title: z.string().max(300).optional(),
      description: z.string().max(4000).optional(),
      priority: z.string().max(40).optional(),
      service: z.string().max(200).optional(),
      site: z.string().max(200).optional(),
      category: z.string().max(80).optional(),
    }),
    requires: ['tickets:create'],
    portal: ['portal:tickets'],
    action: false,
    run: async (ctx, input) => {
      const portal = isCustomerUser(ctx);
      const page = pageByKey(portal ? 'portal.newTicket' : 'tickets.new')!;
      const customerId = await resolveCustomerId(ctx, input.customer, false);
      const [priority, service, category] = await Promise.all([portal ? null : resolveOption(ctx, 'ticket_priority', input.priority), resolveService(ctx, input.service), portal ? null : resolveOption(ctx, 'ticket_category', input.category)]);
      const site = customerId && input.site ? await resolveSite(ctx, customerId, input.site) : null;
      const type = portal && input.type && !['incident', 'request'].includes(input.type) ? 'incident' : input.type;
      const to = buildPath(page, {}, { type, customerId, title: input.title, description: input.description, priorityId: priority?.id, serviceId: service?.id, siteId: site?.id, categoryId: category?.id });
      return { uiAction: { type: 'navigate', to, label: page.label }, to, filled: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k]) };
    },
    summary: (_i, result) => `Opened the new-ticket form with ${(result as { filled: string[] }).filled.join(', ') || 'no fields'} filled in`,
  }),
];
