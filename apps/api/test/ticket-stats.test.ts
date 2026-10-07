/**
 * GET /tickets/stats: list filters, breakdowns and the opened/resolved series (DB-backed).
 * Run with the dev environment sourced (DATABASE_URL etc.):
 *   npx vitest run test/ticket-stats.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket, resolveTicket } from '../src/modules/tickets/service';
import { ticketStats, countTickets, groupTickets } from '../src/modules/tickets/list';
import { toDay, addDays } from '../src/modules/reports/dates';

const suffix = Math.random().toString(36).slice(2, 8);
const ids = { customerId: '', otherCustomerId: '', siteId: '', serviceId: '', p1: '', p4: '', serviceDesk: '', noc: '', portalUserId: '', t1: '', t2: '', t3: '' };
let admin: Principal;
let portal: Principal;
const createdTicketIds: string[] = [];

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}

async function teamId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.key, key)).limit(1);
  if (!row) throw new Error(`team ${key} missing (seed not applied?)`);
  return row.id;
}

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing (seed not applied?)`);
  return row.id;
}

const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `stats-test-${suffix}` }, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portal, { requestId: `stats-test-${suffix}` }, fn);

beforeAll(async () => {
  let adminId = '';
  await withSystem(async (tx) => {
    const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    if (!adminUser) throw new Error('admin user missing (seed not applied?)');
    adminId = adminUser.id;
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p4 = await optionId(tx, 'ticket_priority', 'p4');
    ids.serviceDesk = await teamId(tx, 'service_desk');
    ids.noc = await teamId(tx, 'noc');
    const [customer] = await tx.insert(schema.customers).values({ code: `STS${suffix.toUpperCase()}`, name: `Stats Customer ${suffix}` }).returning();
    ids.customerId = customer.id;
    const [other] = await tx.insert(schema.customers).values({ code: `STO${suffix.toUpperCase()}`, name: `Stats Other ${suffix}` }).returning();
    ids.otherCustomerId = other.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: customer.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.siteId = site.id;
    const [service] = await tx.insert(schema.services).values({ key: `stats_svc_${suffix}`, name: `Stats Service ${suffix}`, domain: 'noc' }).returning();
    ids.serviceId = service.id;
    // A portal user of the first customer (customer_user role scoped to it).
    const [user] = await tx.insert(schema.users).values({ email: `stats.portal.${suffix}@example.test`, name: 'Stats Portal', userType: 'customer', customerId: customer.id, status: 'active' }).returning();
    ids.portalUserId = user.id;
    await tx.insert(schema.userRoles).values({ userId: user.id, roleId: await roleId(tx, 'customer_user'), customerId: customer.id });
  });
  invalidatePrincipal();
  admin = (await loadPrincipal(adminId))!;
  portal = (await loadPrincipal(ids.portalUserId))!;
  expect(portal.userType).toBe('customer');

  await asAdmin(async (ctx) => {
    const t1 = await createTicket(ctx, { type: 'incident', customerId: ids.customerId, siteId: ids.siteId, serviceId: ids.serviceId, title: `Stats P1 ${suffix}`, priorityId: ids.p1, assignedTeamId: ids.serviceDesk });
    const t2 = await createTicket(ctx, { type: 'incident', customerId: ids.customerId, siteId: ids.siteId, serviceId: ids.serviceId, title: `Stats P4 ${suffix}`, priorityId: ids.p4, assignedTeamId: ids.noc });
    const t3 = await createTicket(ctx, { type: 'request', customerId: ids.customerId, title: `Stats request ${suffix}`, priorityId: ids.p4 });
    const foreign = await createTicket(ctx, { type: 'incident', customerId: ids.otherCustomerId, title: `Stats foreign ${suffix}`, priorityId: ids.p1 });
    createdTicketIds.push(t1.id, t2.id, t3.id, foreign.id);
    ids.t1 = t1.id;
    ids.t2 = t2.id;
    ids.t3 = t3.id;
  });
  // SLA vocabulary fixtures on the engine's own rows: t1 breached (the engine flag), t2 running and warned (at risk), t3 running past due but
  // not swept yet (neither: the sweep flags it within a minute, nobody re-derives it from due_at).
  await withSystem(async (tx) => {
    await tx.execute(sql`UPDATE ticket_slas SET state = 'breached', breached_at = now() WHERE ticket_id = ${ids.t1}::uuid AND metric = 'resolution'`);
    await tx.execute(sql`UPDATE ticket_slas SET warned_at = now() WHERE ticket_id = ${ids.t2}::uuid AND metric = 'resolution'`);
    await tx.execute(sql`UPDATE ticket_slas SET due_at = now() - interval '1 hour' WHERE ticket_id = ${ids.t3}::uuid AND metric = 'resolution'`);
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (createdTicketIds.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, createdTicketIds));
    if (ids.portalUserId) await tx.delete(schema.users).where(eq(schema.users.id, ids.portalUserId));
    const customerIds = [ids.customerId, ids.otherCustomerId].filter(Boolean);
    if (customerIds.length) await tx.delete(schema.customers).where(inArray(schema.customers.id, customerIds));
    if (ids.serviceId) await tx.delete(schema.services).where(eq(schema.services.id, ids.serviceId));
  });
  await closeDb();
});

describe('ticket stats', () => {
  it('returns totals, breakdowns and a 14-day series for the customer', async () => {
    const s = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId }));
    expect(s.total).toBe(3);
    expect(s.open).toBe(3);
    expect(s.byStatusCategory).toEqual({ new: 3 });
    expect(s.byType).toEqual({ incident: 2, request: 1 });

    expect(s.series).toHaveLength(14);
    expect(s.series.at(-1)?.day).toBe(toDay(new Date()));
    expect(s.series[0]?.day).toBe(addDays(toDay(new Date()), -13));
    expect(s.series.reduce((n, r) => n + r.opened, 0)).toBe(3);
    expect(s.series.reduce((n, r) => n + r.resolved, 0)).toBe(0);

    // Priorities ordered by level, with the per-priority open count.
    expect(s.byPriority.map((p) => [p.id, p.count])).toEqual([
      [ids.p1, 1],
      [ids.p4, 2],
    ]);
    expect(s.byPriority[0]?.label).toMatch(/P1/);
    expect(s.byPriority[0]?.level).toBeLessThan(s.byPriority[1]!.level!);

    expect(s.byStatus).toHaveLength(1);
    expect(s.byStatus[0]).toMatchObject({ category: 'new', count: 3 });
    expect(typeof s.byStatus[0]?.id).toBe('string');

    const teams = Object.fromEntries(s.byTeam.map((t) => [t.id ?? 'none', t]));
    expect(teams[ids.serviceDesk]?.count).toBe(1);
    expect(teams[ids.noc]?.count).toBe(1);
    expect(s.byTeam.reduce((n, t) => n + t.count, 0)).toBe(3);
    expect(s.byTeam.every((t) => typeof t.breached === 'number' && typeof t.label === 'string')).toBe(true);
    expect(typeof s.pendingApprovals).toBe('number');
  });

  it('priorityId narrows total/open while byStatusCategory keeps every bucket', async () => {
    const s = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, priorityId: ids.p1 }));
    expect(s.total).toBe(1);
    expect(s.open).toBe(1);
    expect(s.byPriority).toHaveLength(1);
    expect(s.byPriority[0]).toMatchObject({ id: ids.p1, count: 1 });
    expect(s.byType).toEqual({ incident: 1 });
    // Category chips drop only the status filters; the priority filter still applies (one P1 ticket, in "new").
    expect(s.byStatusCategory).toEqual({ new: 1 });
    const teams = Object.fromEntries(s.byTeam.map((t) => [t.id ?? 'none', t.count]));
    expect(teams[ids.serviceDesk]).toBe(1);
    expect(teams[ids.noc]).toBeUndefined();
  });

  it('statusCategory=resolved with nothing resolved gives an empty list but unchanged tiles and category counts', async () => {
    const all = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId }));
    const s = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, statusCategory: 'resolved' }));
    expect(s.total).toBe(0);
    // The Open tile is the baseline of the scope: the status chips never move it.
    expect(s.open).toBe(3);
    expect(s.byStatus).toEqual([]);
    expect(s.byPriority).toEqual([]);
    expect(s.byTeam).toEqual([]);
    expect(s.byStatusCategory).toEqual(all.byStatusCategory);
    expect(s.byStatusCategory.new).toBe(3);
    // the same holds for the open flag and an explicit statusId filter
    const open = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, open: true }));
    expect(open.byStatusCategory).toEqual(all.byStatusCategory);
  });

  it('createdFrom/createdTo spanning five days drive the series window', async () => {
    const to = toDay(new Date());
    const from = addDays(to, -4);
    const s = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, createdFrom: from, createdTo: to }));
    expect(s.series).toHaveLength(5);
    expect(s.series.map((r) => r.day)).toEqual([from, addDays(from, 1), addDays(from, 2), addDays(from, 3), to]);
    expect(s.series.reduce((n, r) => n + r.opened, 0)).toBe(3);
    expect(s.total).toBe(3);
    // a window wider than 90 days falls back to the default 14 days
    const wide = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, createdFrom: addDays(to, -200), createdTo: to }));
    expect(wide.series).toHaveLength(14);
  });

  it('tiles use the shared SLA vocabulary: breached is the engine flag, at risk is running and warned, past due unswept is neither', async () => {
    const s = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId }));
    expect(s.breached).toBe(1);
    expect(s.atRisk).toBe(1);
    expect(await asAdmin((ctx) => countTickets(ctx, { customerId: ids.customerId, slaState: 'breached' }))).toBe(1);
    expect(await asAdmin((ctx) => countTickets(ctx, { customerId: ids.customerId, slaState: 'at_risk' }))).toBe(1);
    expect(await asAdmin((ctx) => countTickets(ctx, { customerId: ids.customerId, slaState: 'ok' }))).toBe(1);
    const g = await asAdmin((ctx) => groupTickets(ctx, { customerId: ids.customerId }, 'slaState'));
    expect(g.groups).toEqual([{ label: 'Breached', count: 1 }, { label: 'At risk', count: 1 }, { label: 'On track', count: 1 }]);
    const teams = Object.fromEntries(s.byTeam.map((t) => [t.id ?? 'none', t.breached]));
    expect(teams[ids.serviceDesk]).toBe(1);
    expect(teams[ids.noc]).toBe(0);
  });

  it('quick filters never move each other: a tile or assignee condition narrows the list but leaves every tile and the chips where they were', async () => {
    const base = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId }));
    const tiles = (x: Awaited<ReturnType<typeof ticketStats>>) => ({ open: x.open, breached: x.breached, atRisk: x.atRisk, unassigned: x.unassigned, mine: x.mine, major: x.major, highRisk: x.highRisk, unhappy: x.unhappy, knownErrors: x.knownErrors, dueToday: x.dueToday, overdue: x.overdue });
    expect(base.unassigned).toBe(3);
    for (const q of [{ unassigned: true }, { slaState: 'breached' }, { slaState: 'at_risk,ok' }, { mine: true }, { breachRisk: 'high' as const }, { knownError: true }, { watching: true }, { open: true }, { statusCategory: 'pending' }]) {
      const s = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, ...q }));
      expect(tiles(s), JSON.stringify(q)).toEqual(tiles(base));
      expect(s.byStatusCategory, JSON.stringify(q)).toEqual(base.byStatusCategory);
      expect(s.byType, JSON.stringify(q)).toEqual(base.byType);
      expect(s.allTypes, JSON.stringify(q)).toBe(3);
    }
    // ...while the list itself (total, and the breakdowns that describe it) follows the condition.
    const breached = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, slaState: 'breached' }));
    expect(breached.total).toBe(1);
    expect(breached.byPriority).toEqual([expect.objectContaining({ id: ids.p1, count: 1 })]);
    const mine = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, mine: true }));
    expect(mine.total).toBe(0);
    expect(mine.open).toBe(3);
  });

  it('the type tab keeps the tiles on its own scope while All (allTypes) and the per-type counts ignore it', async () => {
    const s = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, type: 'incident' }));
    expect(s.total).toBe(2);
    expect(s.open).toBe(2);
    expect(s.breached).toBe(1);
    expect(s.byType).toEqual({ incident: 2, request: 1 });
    expect(s.allTypes).toBe(3);
    // The category chips describe the current tab.
    expect(s.byStatusCategory).toEqual({ new: 2 });
    const r = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, type: 'request' }));
    expect(r.open).toBe(1);
    expect(r.breached).toBe(0);
    expect(r.allTypes).toBe(3);
  });

  it('comma lists: priorityId, slaState, domain, teamId and securitySeverityId open the list with exactly a breakdown predicate', async () => {
    const c = (q: Parameters<typeof countTickets>[1]) => asAdmin((ctx) => countTickets(ctx, { customerId: ids.customerId, ...q }));
    expect(await c({ priorityId: `${ids.p1},${ids.p4}` })).toBe(3);
    expect(await c({ priorityId: ids.p1 })).toBe(1);
    expect(await c({ slaState: 'breached,at_risk' })).toBe(2);
    expect(await c({ domain: 'noc' })).toBe(2);
    expect(await c({ domain: 'noc,general' })).toBe(3);
    expect(await c({ domain: 'general,amc,service_desk' })).toBe(1);
    expect(await c({ teamId: `${ids.serviceDesk},${ids.noc}` })).toBe(2);
    expect(await c({ teamId: ids.noc })).toBe(1);
    expect(await c({ securitySeverityId: `${ids.p1},${ids.p4}` })).toBe(0);
  });

  it('a resolved range counts by resolution day whatever the current status; a date-only bound covers the whole day', async () => {
    const today = toDay(new Date());
    const yesterday = addDays(today, -1);
    await asAdmin((ctx) => resolveTicket(ctx, ids.t3, { resolutionNotes: 'Done during the stats test' }));
    const c = (q: Parameters<typeof countTickets>[1]) => asAdmin((ctx) => countTickets(ctx, { customerId: ids.customerId, ...q }));
    expect(await c({ resolvedFrom: today, resolvedTo: today })).toBe(1);
    expect(await c({ resolvedFrom: yesterday, resolvedTo: yesterday })).toBe(0);
    expect(await c({ resolvedFrom: yesterday })).toBe(1);
    expect(await c({ resolvedTo: yesterday })).toBe(0);
    expect(await c({ createdFrom: today, createdTo: today })).toBe(3);
    expect(await c({ createdFrom: addDays(today, -6), createdTo: yesterday })).toBe(0);
    // The resolved tile moves with the list's own scope, not with the status chips.
    const s = await asAdmin((ctx) => ticketStats(ctx, { customerId: ids.customerId, statusCategory: 'resolved' }));
    expect(s.total).toBe(1);
    expect(s.open).toBe(2);
    expect(s.byStatusCategory).toEqual({ new: 2, resolved: 1 });
  });

  it('a portal user only sees their own customer and cannot name another one', async () => {
    const s = await asPortal((ctx) => ticketStats(ctx, {}));
    expect(s.total).toBe(3);
    expect(s.open).toBe(2);
    expect(s.byStatusCategory).toEqual({ new: 2, resolved: 1 });
    expect(s.pendingApprovals).toBe(0);
    expect(s.series).toHaveLength(14);
    await expect(asPortal((ctx) => ticketStats(ctx, { customerId: ids.otherCustomerId }))).rejects.toThrow();
  });
});
