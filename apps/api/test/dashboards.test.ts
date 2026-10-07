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
import { customer, soc, amc, engineer, noc, overview } from '@/modules/dashboards/service';
import { listVisits } from '@/modules/field/service';
import { visitListQuery } from '@/modules/field/schemas';
import { listOccurrences } from '@/modules/pm/service';
import { occurrenceListQuery } from '@/modules/pm/schemas';
import { toDay, addDays } from '@/modules/reports/dates';
import { AGE_ORDER } from '@/modules/reports/analytics';

const suffix = Math.random().toString(36).slice(2, 8);
const ids = { adminId: '', customerA: '', customerB: '', siteA: '', nocService: '', socService: '', amcService: '', p1: '', p4: '', portalUserId: '', bareUserId: '', nocEngineerId: '' };
let admin: Principal;
let portal: Principal;
/** An MSP user with no role at all: no tickets:read, no dashboard permission. */
let bare: Principal;
/** A NOC engineer: tickets:read and dashboards:noc, no soc:read, no dashboards:amc, no dashboards:management. */
let nocEngineer: Principal;
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
const as = <T>(p: Principal, fn: (ctx: Ctx) => Promise<T>) => runAs(p, { requestId: `dash-test-${suffix}` }, fn);

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
    const [bareUser] = await tx.insert(schema.users).values({ email: `dash.bare.${suffix}@example.test`, name: 'Dash Bare', userType: 'msp', status: 'active' }).returning();
    ids.bareUserId = bareUser.id;
    const [nocUser] = await tx.insert(schema.users).values({ email: `dash.noc.${suffix}@example.test`, name: 'Dash NOC Engineer', userType: 'msp', status: 'active' }).returning();
    ids.nocEngineerId = nocUser.id;
    await tx.insert(schema.userRoles).values({ userId: nocUser.id, roleId: await roleId(tx, 'noc_engineer'), customerId: null });
  });
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminId))!;
  portal = (await loadPrincipal(ids.portalUserId))!;
  bare = (await loadPrincipal(ids.bareUserId))!;
  nocEngineer = (await loadPrincipal(ids.nocEngineerId))!;
  expect(portal.userType).toBe('customer');
  expect(portal.customerScope).toEqual([ids.customerA]);
  expect(bare.globalPermissions.has('tickets:read')).toBe(false);
  expect(nocEngineer.globalPermissions.has('dashboards:noc') && !nocEngineer.globalPermissions.has('soc:read') && !nocEngineer.globalPermissions.has('dashboards:management') && !nocEngineer.globalPermissions.has('dashboards:amc')).toBe(true);

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
  // Field visits and maintenance of A for the AMC dashboard's visit cells and status donuts (counted with the lists' own predicates):
  // the admin leads an overdue and a coming scheduled visit and is the additional engineer on a third; one completed visit was scheduled
  // inside the week and one sixty days ago (outside the period and the donut window); a requested visit has no date, so no window holds it.
  await withSystem(async (tx) => {
    const at = (days: number) => new Date(Date.now() + days * 86_400_000);
    const visit = (n: number, v: Partial<typeof schema.fieldVisits.$inferInsert>) => ({ number: `FV-DASH-${suffix}-${n}`, customerId: ids.customerA, siteId: ids.siteA, title: `Dash visit ${n} ${suffix}`, ...v });
    await tx.insert(schema.fieldVisits).values([
      visit(1, { status: 'scheduled', engineerId: ids.adminId, scheduledStart: at(-3) }),
      visit(2, { status: 'scheduled', engineerId: ids.adminId, scheduledStart: at(3) }),
      visit(3, { status: 'scheduled', engineerId: ids.nocEngineerId, additionalEngineerIds: [ids.adminId], scheduledStart: at(5) }),
      visit(4, { status: 'completed', engineerId: ids.adminId, scheduledStart: at(-2), actualStart: at(-2), actualEnd: at(0) }),
      visit(5, { status: 'completed', engineerId: ids.adminId, scheduledStart: at(-60), actualStart: at(-60), actualEnd: at(0) }),
      visit(6, { status: 'requested', engineerId: ids.adminId, scheduledStart: null }),
    ]);
    const [program] = await tx.insert(schema.pmPrograms).values({ customerId: ids.customerA, siteId: ids.siteA, name: `Dash PM ${suffix}`, frequency: 'monthly', startDate: addDays(today, -60), assignedEngineerId: ids.adminId }).returning();
    await tx.insert(schema.pmOccurrences).values([
      { programId: program!.id, customerId: ids.customerA, plannedDate: today, status: 'planned' },
      { programId: program!.id, customerId: ids.customerA, plannedDate: addDays(today, 10), scheduledDate: addDays(today, 12), status: 'scheduled' },
      { programId: program!.id, customerId: ids.customerA, plannedDate: addDays(today, -60), status: 'completed' },
    ]);
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (createdTicketIds.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, createdTicketIds));
    const users = [ids.portalUserId, ids.bareUserId, ids.nocEngineerId].filter(Boolean);
    if (users.length) await tx.delete(schema.users).where(inArray(schema.users.id, users));
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
    const own = (rows: unknown[], id: string) => rows.every((r) => (r as { customer_id?: unknown }).customer_id === id);
    const socA = await asAdmin((ctx) => soc(ctx, { customerId: ids.customerA }));
    expect(socA.series.reduce((n, r) => n + r.opened, 0)).toBeGreaterThanOrEqual(1);
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

  it('overview(): the shape every section follows for an administrator, with the strips equal to the dedicated tiles', async () => {
    const d = await asAdmin((ctx) => overview(ctx, { days: 30 }));
    expect(d.period).toEqual({ days: 30, from: addDays(today, -29), to: today, previousFrom: addDays(today, -59), previousTo: addDays(today, -30) });
    expect(d.customerId).toBeNull();
    expect(typeof d.timezone).toBe('string');
    expect(d.generatedAt).toBeInstanceOf(Date);
    // me: own work, always present
    expect(d.me.name).toBe(admin.name);
    expect(typeof d.me.assigned).toBe('number');
    expect(typeof d.me.approvals).toBe('number');
    expect(typeof d.me.dueToday).toBe('number');
    expect(d.me.shift === null || typeof d.me.shift.teamId === 'string').toBe(true);
    expect(Array.isArray(d.me.byType)).toBe(true);
    expect(Array.isArray(d.announcements)).toBe(true);
    expect(Array.isArray(d.upcoming.items)).toBe(true);
    expect(Object.keys(d.upcoming.counts).sort()).toEqual(['cab', 'changes', 'maintenance', 'visits']);
    // desk: present with tickets:read; every panel the plan names
    const desk = d.desk as Record<string, unknown>;
    expect(desk).not.toBeNull();
    expect(Object.keys(desk.kpis as object).sort()).toEqual(['atRisk', 'breached', 'major', 'open', 'openedInPeriod', 'openedToday', 'resolutionBreached', 'resolutionMet', 'resolvedInPeriod', 'slaCompliancePct', 'unassigned']);
    expect(Object.keys(desk.deltas as object).sort()).toEqual(['breaches', 'open', 'openedInPeriod', 'resolvedInPeriod', 'slaCompliancePct']);
    const series = desk.series as { day: string; opened: number; resolved: number; breaches: number; compliancePct: number | null }[];
    expect(series).toHaveLength(30);
    expect(series.at(-1)?.day).toBe(today);
    expect(series.reduce((n, r) => n + r.opened, 0)).toBeGreaterThanOrEqual(5);
    expect((desk.ageing as { bucket: string }[]).map((a) => a.bucket)).toEqual([...AGE_ORDER]);
    const arrivals = desk.arrivals as { timezone: string; week: { from: string; to: string; cells: { day: string; row: string; col: string; value: number; createdFrom: string; createdTo: string }[] }; pattern: { cells: { row: string; col: string; value: number }[] } };
    expect(arrivals.week.cells).toHaveLength(168);
    expect(arrivals.week.from).toBe(addDays(today, -6));
    expect(arrivals.week.cells[0]).toMatchObject({ day: addDays(today, -6), col: '00' });
    expect(arrivals.week.cells.every((c) => Date.parse(c.createdTo) - Date.parse(c.createdFrom) === 3_600_000 - 1)).toBe(true);
    expect(arrivals.pattern.cells).toHaveLength(168);
    expect(Object.keys(desk.breakdowns as object).sort()).toEqual(['category', 'customer', 'engineer', 'service', 'team']);
    expect((desk.breakdowns as { customer: { id: string | null; label: string; open: number }[] }).customer.every((r) => typeof r.open === 'number' && typeof r.label === 'string')).toBe(true);
    expect((desk.byPriority as { id: string | null }[]).every((r) => r.id === null || typeof r.id === 'string')).toBe(true);
    expect(typeof (desk.changes as { open: number }).open).toBe('number');
    expect(typeof (desk.changes as { outcomes: { total: number } }).outcomes.total).toBe('number');
    // strips: the administrator holds every dashboard permission; each strip carries the dedicated dashboard's tile keys
    expect(Object.keys(d.strips).sort()).toEqual(['amc', 'noc', 'soc']);
    expect(Object.keys(d.strips.noc!).sort()).toEqual(['atRisk', 'breached', 'escalated', 'highRisk', 'knownErrorsOpen', 'major', 'mediumRisk', 'mttrTodayMinutes', 'open', 'openIncidents', 'openedToday', 'resolvedToday', 'unassigned', 'unhappy']);
    expect(Object.keys(d.strips.soc!).sort()).toEqual(['atRisk', 'breached', 'criticalHigh', 'criticalHighSeverityIds', 'escalated', 'open', 'openedToday', 'unassigned']);
    expect(Object.keys(d.strips.amc!).sort()).toEqual(['atRisk', 'awaitingCustomer', 'breached', 'dueToday', 'open', 'openedToday', 'resolvedThisWeek', 'resolvedToday', 'unassigned', 'visitsThisWeek']);
    // management extras
    const m = d.management as Record<string, unknown>;
    expect(m).not.toBeNull();
    expect(Object.keys(m).sort()).toEqual(['csat', 'entitlementAlerts', 'expiringContracts', 'kpis', 'needsAttention']);
    expect(typeof (m.kpis as { customersActive: number }).customersActive).toBe('number');
    expect(Array.isArray(m.needsAttention)).toBe(true);
  });

  it('overview(): a customer scope narrows every section, is echoed back, and the strips equal the dedicated dashboards\' tiles', async () => {
    // Customer B is this suite's own, so its numbers cannot move while other suites run.
    const d = await asAdmin((ctx) => overview(ctx, { days: 7, customerId: ids.customerB }));
    expect(d.customerId).toBe(ids.customerB);
    const desk = d.desk as { kpis: { open: number; openedInPeriod: number }; breakdowns: { customer: { id: string | null; open: number }[] } };
    expect(desk.kpis.open).toBe(1);
    expect(desk.kpis.openedInPeriod).toBe(1);
    expect(desk.breakdowns.customer.map((r) => [r.id, r.open])).toEqual([[ids.customerB, 1]]);
    expect(d.strips.noc?.open).toBe(1);
    expect(d.strips.soc?.open).toBe(0);
    expect(d.strips.amc?.open).toBe(0);
    const [n, s, a] = await Promise.all([asAdmin((ctx) => noc(ctx, { days: 7, customerId: ids.customerB })), asAdmin((ctx) => soc(ctx, { days: 7, customerId: ids.customerB })), asAdmin((ctx) => amc(ctx, { days: 7, customerId: ids.customerB }))]);
    expect(d.strips.noc).toEqual(n.totals);
    expect(d.strips.soc).toEqual(s.totals);
    expect(d.strips.amc).toEqual(a.kpis);
    // The management section's "needs attention" rows are the scoped customer's own.
    expect(((d.management as { needsAttention: { id: string; tickets: number }[] }).needsAttention).map((r) => [r.id, r.tickets])).toEqual([[ids.customerB, 1]]);
    const scopedA = await asAdmin((ctx) => overview(ctx, { days: 7, customerId: ids.customerA }));
    expect((scopedA.desk as { breakdowns: { customer: { id: string | null; open: number }[] } }).breakdowns.customer).toEqual([expect.objectContaining({ id: ids.customerA, open: 2 })]);
  });

  it('overview(): gating follows the permissions (no desk without tickets:read, no strip without its permission, no management section without dashboards:management)', async () => {
    const b = await as(bare, (ctx) => overview(ctx));
    expect(b.desk).toBeNull();
    expect(b.strips).toEqual({});
    expect(b.management).toBeNull();
    expect(b.me.assigned).toBe(0);
    expect(Array.isArray(b.announcements)).toBe(true);
    // Without field:read or pm:read the upcoming list shows the person's own work only (none here), never the desk's.
    expect(b.upcoming.counts).toEqual({ visits: 0, maintenance: 0, cab: 0, changes: 0 });

    const e = await as(nocEngineer, (ctx) => overview(ctx));
    expect(e.desk).not.toBeNull();
    expect(e.strips.noc).toBeDefined();
    expect(e.strips.soc).toBeUndefined();
    expect(e.strips.amc).toBeUndefined();
    expect(e.management).toBeNull();
    // The security fence applies to the desk: the NOC engineer does not count the security incident the administrator sees.
    const adminView = await asAdmin((ctx) => overview(ctx, { customerId: ids.customerA }));
    const engineerView = await as(nocEngineer, (ctx) => overview(ctx, { customerId: ids.customerA }));
    expect((adminView.desk as { kpis: { open: number } }).kpis.open).toBe(2);
    expect((engineerView.desk as { kpis: { open: number } }).kpis.open).toBe(1);
    expect((engineerView.desk as { byType: { type: string; count: number }[] }).byType).toEqual([{ type: 'incident', count: 1, breached: 0 }]);

    // Customer users have their own home: the overview refuses them.
    await expect(asPortal((ctx) => overview(ctx))).rejects.toThrow(/MSP users/);
  });

  it('noc(): the team filter narrows every panel, the team list drives the hero control and the new panels have the documented shape', async () => {
    const d = await asAdmin((ctx) => noc(ctx, { days: 7 }));
    expect(d.teamId).toBeNull();
    expect(Array.isArray(d.teams)).toBe(true);
    expect(d.series.every((r) => typeof r.incidents === 'number' && typeof r.opened === 'number')).toBe(true);
    expect(d.ageing.map((a) => a.bucket)).toEqual([...AGE_ORDER]);
    expect(d.arrivals.week.cells).toHaveLength(168);
    expect(d.monitoringEvents7d.byDay).toHaveLength(7);
    expect(d.byTeam.every((r) => typeof r.open === 'number')).toBe(true);
    expect(d.byService.some((r) => r.id === ids.nocService)).toBe(true);
    // A team nobody is assigned to: every panel reads empty, the tile objects still carry every key.
    const [team] = await withSystem((tx) => tx.insert(schema.teams).values({ key: `dash_empty_${suffix}`, name: `Dash empty team ${suffix}`, teamType: 'noc' }).returning());
    try {
      const t = await asAdmin((ctx) => noc(ctx, { days: 7, teamId: team!.id }));
      expect(t.teamId).toBe(team!.id);
      expect(t.totals.open).toBe(0);
      expect(t.byTeam).toEqual([]);
      expect(t.byService).toEqual([]);
      expect(t.ageing.every((a) => a.count === 0)).toBe(true);
      expect(t.arrivals.week.cells.every((c) => c.value === 0)).toBe(true);
      expect(t.teams.some((x) => x.id === team!.id)).toBe(true);
    } finally {
      await withSystem((tx) => tx.delete(schema.teams).where(eq(schema.teams.id, team!.id)));
    }
  });

  it('soc() and amc(): the severity series, the responsiveness rows, the customer and site rows and the visits by engineer', async () => {
    const s = await asAdmin((ctx) => soc(ctx, { days: 7, customerId: ids.customerA }));
    expect(s.severities.length).toBeGreaterThan(0);
    expect(s.seriesBySeverity).toHaveLength(7);
    expect(s.criticalHighSeverityIds.length).toBeGreaterThanOrEqual(2);
    expect(s.totals.criticalHighSeverityIds).toEqual(s.criticalHighSeverityIds);
    expect(s.responsivenessBySeverity.reduce((n, r) => n + r.opened, 0)).toBe(1);
    expect(s.siemEvents7d.byDay).toHaveLength(7);
    expect(s.arrivals.week.cells.reduce((n, c) => n + c.value, 0)).toBe(1);
    const a = await asAdmin((ctx) => amc(ctx, { days: 7, customerId: ids.customerA }));
    expect(a.customerId).toBe(ids.customerA);
    // The AMC ticket of A is resolved, so the open load is empty but the shapes hold.
    expect(a.byCustomer).toEqual([]);
    expect(a.bySite).toEqual([]);
    expect(a.ageing.map((x) => x.bucket)).toEqual([...AGE_ORDER]);
    // Visits by engineer: the admin leads two scheduled visits (one overdue) and is the additional engineer on a third; one completed visit was scheduled inside the period.
    const mine = a.visitsByEngineer.find((e) => e.id === ids.adminId);
    expect(mine).toMatchObject({ scheduled: 3, inProgress: 0, completedInPeriod: 1 });
    expect(a.visitsByEngineer.find((e) => e.id === ids.nocEngineerId)).toMatchObject({ scheduled: 1, inProgress: 0, completedInPeriod: 0 });
    // Every cell and every slice reproduces on the list it opens (the visits list filters `from`/`to` on the scheduled start, the maintenance list on the planned date).
    const visitsTotal = (q: Record<string, unknown>) => asAdmin(async (ctx) => (await listVisits(ctx, visitListQuery.parse({ customerId: ids.customerA, ...q }))).total);
    const occurrencesTotal = (q: Record<string, unknown>) => asAdmin(async (ctx) => (await listOccurrences(ctx, occurrenceListQuery.parse({ customerId: ids.customerA, ...q }))).total);
    for (const e of a.visitsByEngineer) {
      expect(await visitsTotal({ engineerId: e.id, status: 'scheduled' }), `${e.name} scheduled`).toBe(e.scheduled);
      expect(await visitsTotal({ engineerId: e.id, status: 'in_progress' }), `${e.name} in progress`).toBe(e.inProgress);
      expect(await visitsTotal({ engineerId: e.id, status: 'completed', from: a.period.from, to: a.period.to }), `${e.name} completed`).toBe(e.completedInPeriod);
    }
    expect(a.window).toEqual({ from: addDays(today, -30), to: addDays(today, 30) });
    expect(Object.fromEntries(a.visitsByStatus.map((r) => [r.status, r.count]))).toEqual({ requested: 0, scheduled: 3, in_progress: 0, completed: 1, cancelled: 0 });
    for (const r of a.visitsByStatus) expect(await visitsTotal({ status: r.status, from: a.window.from, to: a.window.to }), `visits ${r.status}`).toBe(r.count);
    expect(Object.fromEntries(a.pmByStatus.map((r) => [r.status, r.count]))).toEqual({ planned: 1, scheduled: 1, rescheduled: 0, completed: 0, missed: 0, cancelled: 0 });
    for (const r of a.pmByStatus) expect(await occurrencesTotal({ status: r.status, from: a.window.from, to: a.window.to }), `maintenance ${r.status}`).toBe(r.count);
    // The maintenance rows carry the program the schedule filters on.
    expect(a.maintenance.every((m) => typeof m.program_id === 'string')).toBe(true);
  });
});
