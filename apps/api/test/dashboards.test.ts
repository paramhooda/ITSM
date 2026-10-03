/**
 * Dashboard services (DB-backed): the daily series and breakdowns the charts read.
 * Run with the dev environment sourced (DATABASE_URL etc.):
 *   npx vitest run test/dashboards.test.ts
 *
 * Two customers (A, B) and a portal user of A; tickets of A span the NOC, SOC and
 * AMC domains, two of them resolved, so every dashboard has something to count.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { createTicket, resolveTicket } from '@/modules/tickets/service';
import { customer, soc, amc, engineer, noc } from '@/modules/dashboards/service';
import { toDay, addDays } from '@/modules/reports/dates';

const suffix = Math.random().toString(36).slice(2, 8);
const ids = { adminId: '', customerA: '', customerB: '', siteA: '', nocService: '', socService: '', amcService: '', p1: '', p4: '', portalUserId: '' };
let admin: Principal;
let portal: Principal;
const createdTicketIds: string[] = [];

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing (seed not applied?)`);
  return row.id;
}

const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `dash-test-${suffix}` }, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portal, { requestId: `dash-test-${suffix}` }, fn);

const today = toDay(new Date());
const sum = (series: Record<string, unknown>[], key: string) => series.reduce((n, r) => n + Number(r[key] ?? 0), 0);

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    if (!adminUser) throw new Error('admin user missing (seed not applied?)');
    ids.adminId = adminUser.id;
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p4 = await optionId(tx, 'ticket_priority', 'p4');
    const [a] = await tx.insert(schema.customers).values({ code: `DSA${suffix.toUpperCase()}`, name: `Dashboard Customer A ${suffix}` }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: `DSB${suffix.toUpperCase()}`, name: `Dashboard Customer B ${suffix}` }).returning();
    ids.customerA = a.id;
    ids.customerB = b.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: a.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.siteA = site.id;
    // The service's domain decides the ticket's domain (no category set), so each dashboard sees one of A's tickets.
    const [nocSvc] = await tx.insert(schema.services).values({ key: `dash_noc_${suffix}`, name: `Dash NOC ${suffix}`, domain: 'noc' }).returning();
    const [socSvc] = await tx.insert(schema.services).values({ key: `dash_soc_${suffix}`, name: `Dash SOC ${suffix}`, domain: 'soc' }).returning();
    const [amcSvc] = await tx.insert(schema.services).values({ key: `dash_amc_${suffix}`, name: `Dash AMC ${suffix}`, domain: 'amc' }).returning();
    ids.nocService = nocSvc.id;
    ids.socService = socSvc.id;
    ids.amcService = amcSvc.id;
    // A portal user of customer A (customer_user role scoped to it).
    const [user] = await tx.insert(schema.users).values({ email: `dash.portal.${suffix}@example.test`, name: 'Dash Portal', userType: 'customer', customerId: a.id, status: 'active' }).returning();
    ids.portalUserId = user.id;
    await tx.insert(schema.userRoles).values({ userId: user.id, roleId: await roleId(tx, 'customer_user'), customerId: a.id });
  });
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminId))!;
  portal = (await loadPrincipal(ids.portalUserId))!;
  expect(portal.userType).toBe('customer');
  expect(portal.customerScope).toEqual([ids.customerA]);

  await asAdmin(async (ctx) => {
    const t1 = await createTicket(ctx, { type: 'incident', customerId: ids.customerA, siteId: ids.siteA, serviceId: ids.nocService, title: `Dash P1 ${suffix}`, priorityId: ids.p1 });
    const t2 = await createTicket(ctx, { type: 'request', customerId: ids.customerA, title: `Dash request ${suffix}`, priorityId: ids.p4 });
    const t3 = await createTicket(ctx, { type: 'incident', customerId: ids.customerA, serviceId: ids.socService, title: `Dash security ${suffix}`, priorityId: ids.p1 });
    const t4 = await createTicket(ctx, { type: 'incident', customerId: ids.customerA, siteId: ids.siteA, serviceId: ids.amcService, title: `Dash AMC ${suffix}`, priorityId: ids.p4, assigneeId: ids.adminId });
    const foreign = await createTicket(ctx, { type: 'incident', customerId: ids.customerB, title: `Dash foreign ${suffix}`, priorityId: ids.p1 });
    createdTicketIds.push(t1.id, t2.id, t3.id, t4.id, foreign.id);
    expect(t3.domain).toBe('soc');
    expect(t4.domain).toBe('amc');
    expect(t4.assigneeId).toBe(ids.adminId);
    await resolveTicket(ctx, t2.id, { resolutionNotes: 'Fulfilled during the dashboard test' });
    await resolveTicket(ctx, t4.id, { resolutionNotes: 'Fixed during the dashboard test' });
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (createdTicketIds.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, createdTicketIds));
    if (ids.portalUserId) await tx.delete(schema.users).where(eq(schema.users.id, ids.portalUserId));
    const customerIds = [ids.customerA, ids.customerB].filter(Boolean);
    if (customerIds.length) await tx.delete(schema.customers).where(inArray(schema.customers.id, customerIds));
    const serviceIds = [ids.nocService, ids.socService, ids.amcService].filter(Boolean);
    if (serviceIds.length) await tx.delete(schema.services).where(inArray(schema.services.id, serviceIds));
  });
  await closeDb();
});

describe('dashboards', () => {
  it('customer(): a 30-day series whose opened/resolved sums match the customer\'s tickets, with the breakdowns the charts read', async () => {
    const d = await asAdmin((ctx) => customer(ctx, { customerId: ids.customerA }));
    expect(d.period).toEqual({ days: 30, from: addDays(today, -29), to: today });
    expect(d.series).toHaveLength(30);
    expect(d.series[0]?.day).toBe(addDays(today, -29));
    expect(d.series.at(-1)?.day).toBe(today);
    expect(sum(d.series, 'opened')).toBe(4);
    expect(sum(d.series, 'resolved')).toBe(2);
    expect(d.tickets.opened30d).toBe(4);
    expect(d.tickets.resolved30d).toBe(2);
    expect(d.tickets.open).toBe(2);
    // Open tickets by priority carry the option key the portal links on, ordered by level.
    expect(d.tickets.byPriority.map((p) => [p.key, p.count])).toEqual([['p1', 2]]);
    expect(Object.values(d.tickets.byStatusCategory).reduce((n, c) => n + c, 0)).toBe(2);
    expect(Array.isArray(d.sla.days30.groups)).toBe(true);
    expect(Array.isArray(d.sla.days90.groups)).toBe(true);
    expect(typeof d.sla.days30.totals.met).toBe('number');
  });

  it('customer(): a portal user is pinned to their own customer, so the series never counts customer B', async () => {
    const d = await asPortal((ctx) => customer(ctx, { customerId: ids.customerB }));
    expect(d.customer.id).toBe(ids.customerA);
    expect(d.series).toHaveLength(30);
    expect(sum(d.series, 'opened')).toBe(4);
    expect(sum(d.series, 'resolved')).toBe(2);
    expect(d.tickets.byPriority.map((p) => [p.key, p.count])).toEqual([['p1', 2]]);
    // B's own view (as the MSP) sees exactly its one ticket.
    const b = await asAdmin((ctx) => customer(ctx, { customerId: ids.customerB }));
    expect(sum(b.series, 'opened')).toBe(1);
    expect(sum(b.series, 'resolved')).toBe(0);
  });

  it('soc(): a 30-day security-domain flow series (opened, resolved, breaches per day)', async () => {
    const d = await asAdmin((ctx) => soc(ctx));
    expect(d.period).toEqual({ days: 30, from: addDays(today, -29), to: today });
    expect(d.series).toHaveLength(30);
    expect(d.series.at(-1)?.day).toBe(today);
    expect(d.series.every((r) => typeof r.opened === 'number' && typeof r.resolved === 'number' && typeof r.breaches === 'number')).toBe(true);
    // The security incident raised today is counted; the NOC/AMC tickets are not (they would need their own domain).
    expect(d.series.at(-1)!.opened).toBeGreaterThanOrEqual(1);
  });

  it('amc(): completed-work series, status breakdowns in lifecycle order and the 30-day resolution SLA', async () => {
    const d = await asAdmin((ctx) => amc(ctx));
    expect(d.series).toHaveLength(30);
    expect(d.series.at(-1)?.day).toBe(today);
    expect(d.series.every((r) => typeof r.visitsCompleted === 'number' && typeof r.pmCompleted === 'number')).toBe(true);
    expect(d.visitsByStatus.map((r) => r.status)).toEqual(['requested', 'scheduled', 'in_progress', 'completed', 'cancelled']);
    expect(d.pmByStatus.map((r) => r.status)).toEqual(['planned', 'scheduled', 'rescheduled', 'completed', 'missed', 'cancelled']);
    expect(d.visitsByStatus.every((r) => typeof r.count === 'number')).toBe(true);
    expect(typeof d.sla30d.met).toBe('number');
    expect(typeof d.sla30d.breached).toBe('number');
    expect(d.sla30d.compliancePct === null || typeof d.sla30d.compliancePct === 'number').toBe(true);
  });

  it('staff views honour the customer scope: every row belongs to the chosen customer', async () => {
    const own = (rows: { customer_id?: unknown }[], id: string) => rows.every((r) => r.customer_id === id);
    const socA = await asAdmin((ctx) => soc(ctx, { customerId: ids.customerA }));
    expect(sum(socA.series, 'opened')).toBeGreaterThanOrEqual(1);
    expect(own(socA.recent, ids.customerA) && own(socA.slaStatus.items, ids.customerA) && own(socA.escalations.items, ids.customerA)).toBe(true);
    expect(socA.byCustomer.every((c) => c.id === ids.customerA)).toBe(true);
    const socB = await asAdmin((ctx) => soc(ctx, { customerId: ids.customerB }));
    expect(own(socB.recent, ids.customerB)).toBe(true);
    expect(socB.totals.open).toBe(socB.recent.filter((r) => r.status_category && !['resolved', 'closed', 'cancelled'].includes(String(r.status_category))).length);
    const amcB = await asAdmin((ctx) => amc(ctx, { customerId: ids.customerB }));
    expect(own(amcB.queue.items, ids.customerB)).toBe(true);
    expect(amcB.kpis.open).toBe(amcB.queue.items.length);
    const nocB = await asAdmin((ctx) => noc(ctx, { customerId: ids.customerB }));
    expect(own(nocB.criticalOpen, ids.customerB) && own(nocB.unassigned.items, ids.customerB) && own(nocB.slaAtRisk.items, ids.customerB) && own(nocB.recentlyResolved, ids.customerB)).toBe(true);
    const nocAll = await asAdmin((ctx) => noc(ctx));
    expect(nocAll.totals.open).toBeGreaterThanOrEqual(nocB.totals.open);
    const engB = await asAdmin((ctx) => engineer(ctx, { customerId: ids.customerB }));
    expect(own(engB.assigned.items, ids.customerB) && own(engB.watched, ids.customerB)).toBe(true);
    // A portal user cannot widen the scope to another customer.
    await expect(asPortal((ctx) => customer(ctx, { customerId: ids.customerB }))).resolves.toMatchObject({ customer: { id: ids.customerA } });
  });

  it('engineer(): my resolved-per-day series over the default 30 days and the queue by priority', async () => {
    const d = await asAdmin((ctx) => engineer(ctx));
    expect(d.period).toEqual({ days: 30, from: addDays(today, -29), to: today });
    expect(d.series).toHaveLength(30);
    expect(d.series[0]?.day).toBe(addDays(today, -29));
    expect(d.series.at(-1)?.day).toBe(today);
    // The AMC ticket assigned to the admin was resolved today.
    expect(d.series.at(-1)!.resolved).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(d.assigned.byPriority)).toBe(true);
    expect(d.assigned.byPriority.every((p) => typeof p.count === 'number' && typeof p.level === 'number')).toBe(true);
  });
});
