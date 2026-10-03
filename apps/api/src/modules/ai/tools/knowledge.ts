import { z } from 'zod';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { getArticle, createArticle, publishArticle, feedback, listCategories } from '@/modules/knowledge/service';
import { getTicket } from '@/modules/tickets/service';
import { define } from './types';
import { ticketRef } from './core';
import { isCustomerUser, ticketLink, trunc, iso, resolveArticle, resolveTicket, resolveCustomerId, resolveService, articleLink } from '../helpers';

/** Knowledge tools: read articles, draft one (optionally from a resolved ticket), publish, rate. */

const articleRef = z.string().max(200).describe('Article number (KB-…), exact title or id');

async function categoryByName(ctx: Ctx, ref?: string | null) {
  const r = ref?.trim().toLowerCase();
  if (!r) return null;
  const cats = (await listCategories(ctx)) as unknown as { id: string; key: string; name: string }[];
  const hit = cats.find((c) => c.key.toLowerCase() === r || c.name.toLowerCase() === r) ?? cats.find((c) => c.name.toLowerCase().includes(r));
  if (!hit) throw new ValidationError(`Unknown knowledge category "${ref}". Valid: ${cats.map((c) => c.name).join(', ')}`);
  return hit;
}

export const KNOWLEDGE: ReturnType<typeof define>[] = [
  define({
    name: 'get_article',
    toolset: 'knowledge',
    description: 'One knowledge article in full (body, type, category, visibility, feedback counts, related tickets).',
    inputSchema: z.object({ article: articleRef }),
    requires: ['kb:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const ref = await resolveArticle(ctx, input.article);
      const a = (await getArticle(ctx, ref.id, { noView: true })) as unknown as Record<string, unknown> & { id: string; number: string; title: string; body: string; relatedTickets: { id: string; number: string; title: string; status: string | null }[] };
      return {
        number: a.number,
        title: a.title,
        summary: a.summary ?? null,
        body: trunc(a.body, 4000),
        type: a.articleType ?? null,
        status: a.status ?? null,
        visibility: a.visibility ?? null,
        category: a.categoryName ?? null,
        customer: a.customerName ?? null,
        service: a.serviceName ?? null,
        tags: a.tags ?? [],
        author: a.authorName ?? null,
        version: a.version ?? null,
        publishedAt: iso(a.publishedAt as Date | null),
        updatedAt: iso(a.updatedAt as Date | null),
        helpful: a.helpfulCount ?? 0,
        notHelpful: a.notHelpfulCount ?? 0,
        views: a.viewCount ?? 0,
        ...(isCustomerUser(ctx) ? {} : { relatedTickets: a.relatedTickets.slice(0, 8).map((t) => ({ number: t.number, title: t.title, status: t.status, link: ticketLink(ctx, t.id) })) }),
        link: articleLink(ctx, a.id),
      };
    },
    summary: (input, result) => `Read article ${(result as { number: string }).number ?? input.article}`,
  }),

  define({
    name: 'draft_article',
    toolset: 'knowledge',
    description: 'Create a draft knowledge article (not published). Give the title and body, or a resolved ticket to draft from (its title, description and resolution notes become the draft and the ticket is linked).',
    inputSchema: z.object({ title: z.string().min(3).max(300).optional(), body: z.string().max(20000).optional(), summary: z.string().max(1000).optional(), type: z.string().max(40).optional().describe('e.g. sop, runbook, known_error, troubleshooting, faq'), category: z.string().max(120).optional(), customer: z.string().max(200).optional().describe('Customer-specific article; omit for a general one'), service: z.string().max(200).optional(), tags: z.array(z.string().max(50)).max(20).optional(), fromTicket: ticketRef.optional() }),
    requires: ['kb:manage'],
    portal: null,
    action: true,
    invalidates: ['knowledge'],
    run: async (ctx, input) => {
      const d = await articleDraft(ctx, input);
      const a = (await createArticle(ctx, d.input)) as unknown as { id: string; number: string; title: string; status: string };
      return { article: a.number, title: a.title, status: a.status, link: articleLink(ctx, a.id) };
    },
    summary: (_i, result) => `Created draft article ${(result as { article: string }).article}`,
    preview: async (ctx, input) => {
      const d = await articleDraft(ctx, input);
      return `Create a draft ${d.input.articleType ?? 'article'} "${d.input.title}"${d.category ? ` in ${d.category.name}` : ''}${d.customerLabel ? ` for ${d.customerLabel}` : ' (general)'}${d.ticket ? `, drafted from ${d.ticket.number}` : ''} (${d.input.body?.length ?? 0} characters; stays unpublished until you publish it)`;
    },
  }),

  define({
    name: 'publish_article',
    toolset: 'knowledge',
    description: 'Publish a draft knowledge article so it appears in search (and to customers when its visibility allows).',
    inputSchema: z.object({ article: articleRef }),
    requires: ['kb:manage'],
    portal: null,
    action: true,
    invalidates: ['knowledge'],
    run: async (ctx, input) => {
      const ref = await resolveArticle(ctx, input.article);
      const a = (await publishArticle(ctx, ref.id)) as unknown as { id: string; number: string; status: string };
      return { article: a.number, status: a.status, link: articleLink(ctx, a.id) };
    },
    summary: (input) => `Published article ${input.article}`,
    preview: async (ctx, input) => {
      const a = await resolveArticle(ctx, input.article);
      if (a.status === 'published') return `${a.number} "${a.title}" is already published`;
      return `Publish ${a.number} "${a.title.slice(0, 80)}" (currently ${a.status})`;
    },
  }),

  define({
    name: 'article_feedback',
    toolset: 'knowledge',
    description: 'Record whether a knowledge article was helpful.',
    inputSchema: z.object({ article: articleRef, helpful: z.boolean() }),
    requires: ['kb:read'],
    portal: ['portal:access'],
    action: true,
    tier: 'write_low',
    run: async (ctx, input) => {
      const a = await resolveArticle(ctx, input.article);
      const r = await feedback(ctx, a.id, input.helpful);
      return { article: a.number, helpful: r?.helpfulCount ?? null, notHelpful: r?.notHelpfulCount ?? null, link: articleLink(ctx, a.id) };
    },
    summary: (input) => `Marked article ${input.article} as ${input.helpful ? 'helpful' : 'not helpful'}`,
    preview: async (ctx, input) => `Mark ${(await resolveArticle(ctx, input.article)).number} as ${input.helpful ? 'helpful' : 'not helpful'}`,
  }),
];

type DraftInput = { title?: string; body?: string; summary?: string; type?: string; category?: string; customer?: string; service?: string; tags?: string[]; fromTicket?: string };
async function articleDraft(ctx: Ctx, input: DraftInput) {
  const ticket = input.fromTicket ? await resolveTicket(ctx, input.fromTicket) : null;
  let title = input.title;
  let body = input.body;
  let customerId = await resolveCustomerId(ctx, input.customer);
  let customerLabel: string | null = null;
  if (ticket) {
    const d = await getTicket(ctx, ticket.id);
    title ??= d.title;
    body ??= [`## Problem`, d.description ?? '', '', '## Resolution', d.resolutionNotes ?? '(add the resolution steps)'].join('\n');
    customerId ??= ticket.customerId;
    customerLabel = d.customer?.name ?? null;
  }
  if (!title) throw new ValidationError('A title is required (or a ticket to draft from)');
  const category = await categoryByName(ctx, input.category);
  const service = await resolveService(ctx, input.service);
  if (customerId && !customerLabel) {
    const { customerName } = await import('../helpers');
    customerLabel = await customerName(ctx, customerId);
  }
  return {
    ticket,
    category,
    customerLabel,
    input: { title, body: body ?? '', summary: input.summary ?? null, articleType: input.type, categoryId: category?.id ?? null, customerId: customerId ?? null, serviceId: service?.id ?? null, tags: input.tags ?? [], relatedTicketIds: ticket ? [ticket.id] : [] },
  };
}
