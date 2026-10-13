import { and, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { ticketListPath, portalTicketListPath, statsParamsForLink, portalParamsForLink, type TicketListLink } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { countRows } from '@/core/query';
import { countTickets, buildWhere } from '@/modules/tickets/list';
import { statsQuerySchema } from '@/modules/tickets/schemas';
import { countPortalTickets } from '@/modules/portal/service';
import { portalTicketStatsQuery } from '@/modules/portal/schemas';
import type { BriefingDoor } from '@/db/schema/briefings';

/**
 * A number in a briefing is a door only when it reproduces on the list it
 * opens. Every count here is taken the way the guard test takes a dashboard
 * door: the link is built by the shared builder, parsed the way the list page
 * parses it (defaults applied, URL keys mapped), validated by the list route's
 * own schema and counted with the list's own predicates. The sentence that
 * quotes the number is written from the value counted here, never from a page
 * of rows, so one briefing never prints two numbers for one word.
 */

const T = schema.tickets;

/** The list's own query for a staff link, exactly as the page would send it. */
export const linkQuery = (link: TicketListLink) => statsQuerySchema.parse(statsParamsForLink(ticketListPath(link)));

/** The number the staff ticket list shows for a link. */
export async function countForLink(ctx: Ctx, link: TicketListLink): Promise<number> {
  return countTickets(ctx, linkQuery(link));
}

/**
 * The number the customer portal's ticket list shows for a link (portal-safe
 * keys only, the portal defaults, the portal route's schema). The customer
 * definition takes its door values from the portal home (`dashboards.customer`,
 * whose numbers the guard test already holds against this list); this is the
 * recipe for a portal door built from a link, and the tests prove the two agree.
 */
export async function countForPortalLink(ctx: Ctx, link: TicketListLink): Promise<number> {
  return countPortalTickets(ctx, portalTicketStatsQuery.parse(portalParamsForLink(portalTicketListPath(link))));
}

/**
 * The same predicate grouped by customer: one statement for every customer of
 * an account manager instead of one count per customer. Each value equals
 * `countForLink(ctx, { ...link, customerId })` for that customer.
 */
export async function countForLinkByCustomer(ctx: Ctx, link: TicketListLink, customerIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!customerIds.length) return out;
  const where = buildWhere(ctx, linkQuery(link));
  const rows = await ctx.tx
    .select({ customerId: T.customerId, n: sql<number>`count(*)::int` })
    .from(T)
    .where(and(where, inArray(T.customerId, customerIds)))
    .groupBy(T.customerId);
  for (const r of rows) if (r.customerId) out.set(r.customerId, Number(r.n));
  return out;
}

/** How many tickets of a link's list fall due within the next `hours`, from now on (what is already overdue is the Breached door's business); the list has no due-window key, so this is a figure counted over every row, never a page. */
export async function countDueWithin(ctx: Ctx, link: TicketListLink, hours: number, now = new Date()): Promise<number> {
  const until = new Date(now.getTime() + hours * 3_600_000);
  return countRows(ctx.tx, sql`tickets`, and(buildWhere(ctx, linkQuery(link)), isNotNull(T.dueAt), gte(T.dueAt, now), lt(T.dueAt, until)));
}

export const door = (label: string, value: number, href: string): BriefingDoor => ({ label, value, href });
export const figure = (label: string, value: number): BriefingDoor => ({ label, value, href: null });
