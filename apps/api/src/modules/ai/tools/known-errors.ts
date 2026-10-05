import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { KNOWN_ERROR_STATUSES, KNOWN_ERROR_STATUS_LABELS, type KnownErrorStatus } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { updateProblemDetails } from '@/modules/tickets/service';
import { listKnownErrors, knownErrorStats, getKnownError, matchForIncident, publishKnownError, listPortalKnownErrors, getPortalKnownError, loadKedbSettings, portalRecipients, type KnownErrorRow, type PortalKnownError } from '@/modules/known-errors/service';
import { define } from './types';
import { ticketRef } from './core';
import { isCustomerUser, ticketLink, iso, trunc, resolveTicket, resolveCustomerId, resolveService, forCustomer, customerName, knownErrorLink, resolveKnownError, articleLink } from '../helpers';

/**
 * Known error database tools: list and search known errors, read one, match an
 * incident against them, flag a problem as a known error and publish one to
 * the customer portal. Portal users get published entries of their own
 * organisation with the customer wording only; free text goes under keys the
 * untrusted-content wrapper fences (workaround, rootCause, summary,
 * description, details).
 */

const LIST_LINK = '/knowledge/known-errors';
const STATUS_FILTERS = ['active', 'open', 'fix_in_progress', 'resolved', 'retired', 'all'] as const;
const statusLabel = (s: KnownErrorStatus) => KNOWN_ERROR_STATUS_LABELS[s] ?? s;

const compactStaff = (ctx: Ctx, k: KnownErrorRow) => ({
  number: k.number,
  id: k.id,
  title: k.title,
  status: statusLabel(k.keStatus),
  customer: k.customerName,
  service: k.serviceName,
  workaround: trunc(k.workaround, 400),
  fixChange: k.fixChange ? `${k.fixChange.number} (${k.fixChange.status?.label ?? 'unknown status'})` : null,
  incidents: k.incidents,
  published: k.portalVisible,
  identifiedAt: iso(k.identifiedAt),
  updatedAt: iso(k.updatedAt),
  link: knownErrorLink(ctx, k.id),
});

const compactPortal = (ctx: Ctx, k: PortalKnownError) => ({
  number: k.number,
  id: k.id,
  title: k.title,
  status: statusLabel(k.keStatus),
  service: k.service?.name ?? null,
  summary: k.summary,
  workaround: trunc(k.workaround, 400),
  publishedAt: iso(k.publishedAt),
  updatedAt: iso(k.updatedAt),
  link: knownErrorLink(ctx, k.id),
});

const isPortalRow = (k: KnownErrorRow | PortalKnownError): k is PortalKnownError => 'summary' in k && !('customerId' in k);
const compactAny = (ctx: Ctx, k: KnownErrorRow | PortalKnownError) => (isPortalRow(k) ? compactPortal(ctx, k) : compactStaff(ctx, k));

/** The same recipient set the publication notifies: active portal users whose role grants portal:kedb. */
async function portalUserCount(ctx: Ctx, customerId: string): Promise<number> {
  return (await portalRecipients(ctx.tx, customerId)).length;
}

export const KNOWN_ERRORS: ReturnType<typeof define>[] = [
  define({
    name: 'known_errors',
    toolset: 'knowledge',
    description: 'The known error database: problems with a documented workaround, their status (open, fix in progress, resolved, retired), permanent-fix change, linked incidents and whether they are published to the customer portal. Search by words in the title, symptoms or workaround. Use for "is this a known issue", "what is the workaround for the backup timeouts", "which known errors are waiting on a change", "known errors published for ABC". Customer users get their organisation\'s published entries with the customer wording only.',
    inputSchema: z.object({
      q: z.string().min(2).max(300).optional().describe('Words from the title, symptoms or workaround'),
      customer: z.string().max(200).optional().describe('Customer name, code or id (staff only; ignored for customer users)'),
      service: z.string().max(200).optional().describe('Service name or key'),
      status: z.enum(STATUS_FILTERS).optional().describe('active (default: open and fix in progress), open, fix_in_progress, resolved, retired or all'),
      published: z.boolean().optional().describe('Only entries published to the portal (true) or not (false); staff only'),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    requires: ['kedb:read'],
    portal: ['portal:kedb'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const service = await resolveService(ctx, input.service);
      const limit = input.limit ?? 20;
      if (isCustomerUser(ctx)) {
        const status = input.status === 'resolved' ? 'resolved' : input.status === 'all' ? 'all' : 'active';
        const res = await listPortalKnownErrors(ctx, { page: 1, pageSize: limit, q: input.q, serviceId: service?.id, status });
        return {
          items: res.items.map((k) => compactPortal(ctx, k)),
          total: res.total,
          facts: [`${res.total} published known error(s) for your organisation (${status === 'active' ? 'open or fix in progress' : status})`],
          link: LIST_LINK,
        };
      }
      const status = input.status ?? 'active';
      const res = await listKnownErrors(ctx, { page: 1, pageSize: limit, q: input.q, customerId, serviceId: service?.id, status, portalVisible: input.published, hasFixChange: undefined, ciId: undefined });
      const stats = await knownErrorStats(ctx, customerId);
      return {
        items: res.items.map((k) => compactStaff(ctx, k)),
        total: res.total,
        stats: { total: stats.total, open: stats.open, fixInProgress: stats.fixInProgress, resolved: stats.resolved, retired: stats.retired, published: stats.published, incidentsLinked30d: stats.incidentsLinked30d },
        facts: [
          `${stats.total} known error(s)${await forCustomer(ctx, customerId)}: ${stats.open} open, ${stats.fixInProgress} with a fix in progress, ${stats.resolved} resolved, ${stats.published} published to the portal`,
          `${res.total} match the filter (status ${status}${input.q ? ', with a search' : ''}${service ? `, service ${service.name}` : ''}${input.published === undefined ? '' : input.published ? ', published only' : ', unpublished only'})`,
        ],
        link: LIST_LINK,
      };
    },
    summary: (_input, result) => `Listed ${(result as { items: unknown[] }).items.length} known error(s)`,
  }),

  define({
    name: 'get_known_error',
    toolset: 'knowledge',
    description: 'One known error by problem number (PRB-…) or id: symptoms, workaround, root cause, permanent fix and its change, linked incidents, affected configuration items, the related article and the customer-facing wording with its publication state. Customer users get the published entry with the customer wording only.',
    inputSchema: z.object({ knownError: z.string().max(40).describe('Problem number (PRB-…) or id') }),
    requires: ['kedb:read'],
    portal: ['portal:kedb'],
    action: false,
    run: async (ctx, input) => {
      const t = await resolveKnownError(ctx, input.knownError);
      if (isCustomerUser(ctx)) {
        const k = await getPortalKnownError(ctx, t.id);
        return { ...compactPortal(ctx, k), facts: [`${k.number} is a known error (${statusLabel(k.keStatus)}) published for your organisation`] };
      }
      const d = await getKnownError(ctx, t.id);
      return {
        number: d.number,
        id: d.id,
        title: d.title,
        status: statusLabel(d.keStatus),
        ticketStatus: d.ticketStatus?.label ?? null,
        customer: d.customerName,
        service: d.serviceName,
        owner: d.assigneeName,
        team: d.teamName,
        description: trunc(d.symptoms, 1500),
        impact: trunc(d.impactSummary, 600),
        rootCause: trunc(d.rootCause, 1500),
        workaround: trunc(d.workaround, 1500),
        details: trunc(d.permanentFix, 1500),
        fixChange: d.fixChange ? { number: d.fixChange.number, title: d.fixChange.title, status: d.fixChange.status?.label ?? null, link: ticketLink(ctx, d.fixChange.id) } : null,
        incidents: d.linkedIncidents.slice(0, 8).map((i) => ({ number: i.number, title: i.title, status: i.status?.label ?? null, createdAt: iso(i.createdAt), link: ticketLink(ctx, i.id) })),
        incidentCount: d.incidents,
        cis: d.cis.map((c) => ({ name: c.name, hostname: c.hostname, role: c.role })),
        article: d.article ? { number: d.article.number, title: d.article.title, status: d.article.status, link: articleLink(ctx, d.article.id) } : null,
        portal: { published: d.portalVisible, publishedAt: iso(d.publishedAt), publishedBy: d.publishedByName, summary: d.customerSummary, workaround: d.customerWorkaround },
        identifiedAt: iso(d.identifiedAt),
        statusSince: iso(d.keStatusAt),
        updatedAt: iso(d.updatedAt),
        link: knownErrorLink(ctx, d.id),
        problemLink: ticketLink(ctx, d.id),
        facts: [`${d.number} is a known error (${statusLabel(d.keStatus)}) linked to ${d.incidents} incident(s)${d.fixChange ? `; permanent fix ${d.fixChange.number}` : ''}${d.portalVisible ? '; published to the portal' : '; not published to the portal'}`],
      };
    },
    summary: (input, result) => `Read known error ${(result as { number?: string }).number ?? input.knownError}`,
  }),

  define({
    name: 'match_known_errors',
    toolset: 'knowledge',
    description: 'The known error a ticket is linked to (problem_of link), or the best known errors matching its title, service and configuration item, each with its workaround. Use for "is INC-000123 a known issue", "is there a workaround for this ticket". Customer users get published entries of their organisation only.',
    inputSchema: z.object({ ticket: ticketRef }),
    requires: ['tickets:read', 'kedb:read'],
    portal: ['portal:tickets', 'portal:kedb'],
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const m = await matchForIncident(ctx, t);
      if (!m) return { ticket: t.number, linked: null, suggestions: [], facts: [`The known error database is not available to you for ${t.number}`], link: ticketLink(ctx, t.id) };
      const suggestions = m.suggestions.slice(0, 5).map((k) => ({ ...compactAny(ctx, k), score: 'score' in k ? Math.round(Number((k as { score: number }).score) * 100) / 100 : undefined }));
      return {
        ticket: t.number,
        linked: m.linked ? compactAny(ctx, m.linked) : null,
        suggestions,
        facts: [m.linked ? `${t.number} is linked to known error ${m.linked.number} (${statusLabel(m.linked.keStatus)})` : `${suggestions.length} known error(s) match ${t.number}; none is linked`],
        link: ticketLink(ctx, t.id),
      };
    },
    summary: (input, result) => {
      const r = result as { linked: { number: string } | null; suggestions: unknown[] };
      return r.linked ? `${input.ticket.toUpperCase()} is linked to known error ${r.linked.number}` : `Found ${r.suggestions.length} known error(s) matching ${input.ticket.toUpperCase()}`;
    },
  }),

  define({
    name: 'mark_known_error',
    toolset: 'knowledge',
    description: 'Flag a problem as a known error (or update one): sets the workaround, the root cause, the known-error status (open, fix_in_progress, resolved, retired) and the change that delivers the permanent fix. Use for "mark PRB-000104 as a known error with this workaround", "PRB-000104 is fixed by CHG-000120".',
    inputSchema: z.object({
      problem: ticketRef.describe('Problem number (PRB-…) or id'),
      status: z.enum(KNOWN_ERROR_STATUSES).optional().describe('Known-error status (default open when flagging for the first time)'),
      workaround: z.string().max(4000).optional().describe('The workaround engineers apply (internal)'),
      rootCause: z.string().max(4000).optional(),
      fixChange: ticketRef.optional().describe('Change number or id that delivers the permanent fix (same customer)'),
    }),
    requires: ['problems:manage'],
    portal: null,
    action: true,
    tier: 'write',
    invalidates: ['kedb'],
    preview: async (ctx, input) => {
      const { t, fix, first } = await resolveMark(ctx, input);
      const status = input.status ?? 'open';
      const lines: string[] = [];
      if (input.workaround) lines.push(`Workaround: ${trunc(input.workaround, 160)}`);
      if (input.rootCause) lines.push(`Root cause: ${trunc(input.rootCause, 160)}`);
      if (fix) lines.push(`Permanent fix: ${fix.number} (${trunc(fix.title, 80)})`);
      return { text: first ? `Mark ${t.number} "${trunc(t.title, 80)}" as a known error (${statusLabel(status)})` : `Update known error ${t.number} "${trunc(t.title, 80)}"${input.status ? ` to ${statusLabel(input.status)}` : ''}`, lines };
    },
    run: async (ctx, input) => {
      const { t, fix } = await resolveMark(ctx, input);
      await updateProblemDetails(ctx, t.id, { isKnownError: true, workaround: input.workaround, rootCause: input.rootCause, keStatus: input.status, fixChangeId: fix ? fix.id : undefined });
      const d = await getKnownError(ctx, t.id);
      return { knownError: d.number, status: statusLabel(d.keStatus), fixChange: d.fixChange?.number ?? null, link: knownErrorLink(ctx, d.id), facts: [`${d.number} is a known error (${statusLabel(d.keStatus)})${d.fixChange ? ` with permanent fix ${d.fixChange.number}` : ''}`] };
    },
    summary: (input, result) => `Marked ${(result as { knownError?: string }).knownError ?? input.problem.toUpperCase()} as a known error (${(result as { status?: string }).status ?? 'open'})`,
  }),

  define({
    name: 'publish_known_error',
    toolset: 'knowledge',
    description: 'Publish a known error to the customer portal with customer-facing wording: what the customer may notice and what to do in the meantime (no hostnames, internal notes or vendor cases). The organisation\'s portal users are notified the first time; updating the wording of a published entry notifies nobody. Use for "publish PRB-000104 to the ABC portal".',
    inputSchema: z.object({
      problem: ticketRef.describe('Problem number (PRB-…) or id of a known error'),
      customerSummary: z.string().min(10).max(2000).describe('What the customer may notice'),
      customerWorkaround: z.string().min(10).max(4000).describe('What the customer can do in the meantime'),
      notify: z.boolean().optional().describe('Notify the portal users (default yes)'),
    }),
    requires: ['kedb:publish'],
    portal: null,
    action: true,
    tier: 'outbound',
    invalidates: ['kedb'],
    preview: async (ctx, input) => {
      const t = await resolveKnownError(ctx, input.problem);
      const d = await getKnownError(ctx, t.id);
      const name = await customerName(ctx, t.customerId);
      const settings = await loadKedbSettings(ctx.tx);
      const users = await portalUserCount(ctx, t.customerId);
      const willNotify = !d.portalVisible && input.notify !== false && settings.notifyCustomers;
      const notified = willNotify ? users : 0;
      const lines = [`Customers will see: ${trunc(input.customerSummary, 200)}`, `Workaround shown: ${trunc(input.customerWorkaround, 200)}`];
      if (d.portalVisible) lines.push('Already published: the wording is updated and nobody is notified again');
      else if (!settings.notifyCustomers) lines.push('No notification: switched off in the known error settings');
      else if (input.notify === false) lines.push('No notification: as requested');
      else lines.push(`${notified} portal user(s) of ${name} will be notified`);
      return { text: `${d.portalVisible ? 'Update the portal wording of' : 'Publish'} ${t.number} "${trunc(t.title, 80)}" ${d.portalVisible ? 'in' : 'to'} the ${name} portal`, lines, count: notified };
    },
    run: async (ctx, input) => {
      const t = await resolveKnownError(ctx, input.problem);
      const d = await publishKnownError(ctx, t.id, { customerSummary: input.customerSummary, customerWorkaround: input.customerWorkaround, notify: input.notify });
      return { knownError: d.number, published: true, first: d.first, notified: d.notified, link: knownErrorLink(ctx, d.id), facts: [`${d.number} is published to the portal; ${d.notified} portal user(s) notified`] };
    },
    summary: (input, result) => `Published ${(result as { knownError?: string }).knownError ?? input.problem.toUpperCase()} to the customer portal (${(result as { notified?: number }).notified ?? 0} notified)`,
  }),
];

async function resolveMark(ctx: Ctx, input: { problem: string; fixChange?: string }) {
  const t = await resolveTicket(ctx, input.problem);
  if (t.type !== 'problem') throw new ValidationError(`${t.number} is not a problem record`);
  const [pd] = await ctx.tx.select({ isKnownError: schema.problemDetails.isKnownError, keIdentifiedAt: schema.problemDetails.keIdentifiedAt }).from(schema.problemDetails).where(eq(schema.problemDetails.ticketId, t.id)).limit(1);
  const fix = input.fixChange ? await resolveTicket(ctx, input.fixChange) : null;
  if (fix && fix.type !== 'change') throw new ValidationError(`${fix.number} is not a change`);
  if (fix && fix.customerId !== t.customerId) throw new ValidationError('The permanent fix must be a change of the same customer');
  ctx.require('problems:manage', t.customerId);
  return { t, fix, first: !pd?.isKnownError };
}
