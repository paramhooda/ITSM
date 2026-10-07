/**
 * Every dashboard number that links reproduces itself on the ticket list it
 * opens (DB-backed). Run with the dev environment sourced (DATABASE_URL etc.):
 *   npx vitest run test/dashboards-consistency.test.ts
 *
 * The table below pairs each linking number of the five staff dashboards and
 * the customer dashboard with the link the web builds for it through the
 * shared builder (`ticketListPath`). The link is parsed the way the ticket
 * list page does (`listQuery.ts`: defaults applied, then the page's URL keys
 * mapped to API parameters), validated by the list route's own schema and
 * counted with the list's own predicates (`countTickets`), with and without a
 * customer scope at 7 days (management also at 30 days, where the charts read
 * the nightly rollups, and as a NOC manager, who has the management dashboard
 * but no `soc:read`). Three more things are pinned here: the SLA vocabulary is
 * the same on the list tiles and the dashboards, a clock past its due time that
 * the sweep has not flagged yet is "on track" everywhere, and an engineer
 * without `soc:read` sees the same numbers on the NOC dashboard, My work, the
 * customer dashboard and the list (the security fence applies to all of them).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { createTicket, resolveTicket } from '@/modules/tickets/service';
import { countTickets, ticketStats, groupTickets } from '@/modules/tickets/list';
import { statsQuerySchema } from '@/modules/tickets/schemas';
import { management, noc, soc, amc, engineer, customer } from '@/modules/dashboards/service';
import { toDay, addDays } from '@/modules/reports/dates';
import { computeRollups } from '@/jobs/processors/metrics';
import { ticketListPath, type TicketListLink } from '@itsm/shared';
import { statsParamsForLink } from '../../web/src/components/tickets/listQuery';

const S = Math.random().toString(36).slice(2, 8);
const ids = { adminId: '', noah: '', nocManager: '', a: '', b: '', siteA: '', nocSvc: '', socSvc: '', amcSvc: '', team: '', p1: '', p4: '', pendingCustomer: '', awaitingApproval: '', critical: '', high: '' };
let admin: Principal;
let noah: Principal;
/** Holds `dashboards:management` and `customers:read` but not `soc:read`: the security fence applies to every dashboard they open. */
let nocManager: Principal;
const created: string[] = [];
const meta = { requestId: `dash-consistency-${S}` };

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

const as = <T>(p: Principal, fn: (ctx: Ctx) => Promise<T>) => runAs(p, meta, fn);

/** The number the list shows for a link: parse as the page does, validate as the route does, count with the list's predicates. */
const listCount = (p: Principal, link: TicketListLink) => as(p, (ctx) => countTickets(ctx, statsQuerySchema.parse(statsParamsForLink(ticketListPath(link)))));

interface Row { label: string; value: number; link: TicketListLink }
const row = (label: string, value: number, link: TicketListLink): Row => ({ label, value, link });

/** Asserts every row of a table; the failure message names the dashboard number and the link it built. */
async function reproduces(p: Principal, rows: Row[]) {
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    const n = await listCount(p, r.link);
    expect(n, `${r.label} = ${r.value} → ${ticketListPath(r.link)}`).toBe(r.value);
  }
}

/**
 * The fixture owns customers A and B, so a customer-scoped number is exact; the
 * all-customers number also holds whatever other suites left in the database,
 * so it is at least the scoped one. The reproduction check itself (dashboard
 * number = list count) is exact in both scopes.
 */
const expectScoped = (actual: number, scoped: number, customerId: string | null, label: string) => {
  if (customerId) expect(actual, label).toBe(scoped);
  else expect(actual, label).toBeGreaterThanOrEqual(scoped);
};

const period = (d: { period: { from: string; to: string } }) => ({ createdFrom: d.period.from, createdTo: d.period.to });
const resolvedIn = (d: { period: { from: string; to: string } }) => ({ resolvedFrom: d.period.from, resolvedTo: d.period.to });

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    if (!adminUser) throw new Error('admin user missing (seed not applied?)');
    ids.adminId = adminUser.id;
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p4 = await optionId(tx, 'ticket_priority', 'p4');
    ids.pendingCustomer = await optionId(tx, 'ticket_status', 'pending_customer');
    ids.awaitingApproval = await optionId(tx, 'ticket_status', 'awaiting_approval');
    ids.critical = await optionId(tx, 'security_severity', 'critical');
    ids.high = await optionId(tx, 'security_severity', 'high');
    const [a] = await tx.insert(schema.customers).values({ code: `DCA${S.toUpperCase()}`, name: `Consistency Customer A ${S}` }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: `DCB${S.toUpperCase()}`, name: `Consistency Customer B ${S}` }).returning();
    ids.a = a!.id;
    ids.b = b!.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: a!.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.siteA = site!.id;
    // The service's domain decides the ticket's domain (no category set).
    const [nocSvc] = await tx.insert(schema.services).values({ key: `dc_noc_${S}`, name: `Consistency NOC ${S}`, domain: 'noc' }).returning();
    const [socSvc] = await tx.insert(schema.services).values({ key: `dc_soc_${S}`, name: `Consistency SOC ${S}`, domain: 'soc' }).returning();
    const [amcSvc] = await tx.insert(schema.services).values({ key: `dc_amc_${S}`, name: `Consistency AMC ${S}`, domain: 'amc' }).returning();
    ids.nocSvc = nocSvc!.id;
    ids.socSvc = socSvc!.id;
    ids.amcSvc = amcSvc!.id;
    const [team] = await tx.insert(schema.teams).values({ key: `dc_team_${S}`, name: `Consistency NOC team ${S}`, teamType: 'noc' }).returning();
    ids.team = team!.id;
    // An engineer without soc:read (noc_engineer), member of the NOC team.
    const [u] = await tx.insert(schema.users).values({ email: `dc-noah-${S}@example.test`, name: 'Noah Consistency', userType: 'msp', status: 'active' }).returning();
    ids.noah = u!.id;
    await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: await roleId(tx, 'noc_engineer'), customerId: null });
    await tx.insert(schema.teamMembers).values({ teamId: team!.id, userId: u!.id });
    const [nm] = await tx.insert(schema.users).values({ email: `dc-nm-${S}@example.test`, name: 'Nadia Consistency', userType: 'msp', status: 'active' }).returning();
    ids.nocManager = nm!.id;
    await tx.insert(schema.userRoles).values({ userId: nm!.id, roleId: await roleId(tx, 'noc_manager'), customerId: null });
  });
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminId))!;
  noah = (await loadPrincipal(ids.noah))!;
  nocManager = (await loadPrincipal(ids.nocManager))!;
  expect(noah.globalPermissions.has('soc:read')).toBe(false);
  expect(nocManager.globalPermissions.has('dashboards:management')).toBe(true);
  expect(nocManager.globalPermissions.has('soc:read')).toBe(false);
  expect(noah.teams.map((t) => t.id)).toContain(ids.team);

  const t: Record<string, string> = {};
  await as(admin, async (ctx) => {
    const mk = async (key: string, input: Parameters<typeof createTicket>[1]) => {
      const r = await createTicket(ctx, input);
      t[key] = r.id;
      created.push(r.id);
      return r;
    };
    await mk('a1', { type: 'incident', customerId: ids.a, siteId: ids.siteA, serviceId: ids.nocSvc, title: `DC A1 breached ${S}`, priorityId: ids.p1, assignedTeamId: ids.team, assigneeId: ids.adminId });
    await mk('a2', { type: 'incident', customerId: ids.a, siteId: ids.siteA, serviceId: ids.nocSvc, title: `DC A2 at risk ${S}`, priorityId: ids.p1, assignedTeamId: ids.team });
    await mk('a3', { type: 'incident', customerId: ids.a, serviceId: ids.nocSvc, title: `DC A3 past due unswept ${S}`, priorityId: ids.p4 });
    await mk('a4', { type: 'request', customerId: ids.a, title: `DC A4 request pending customer ${S}`, priorityId: ids.p4, assigneeId: ids.noah });
    // A5 is a security ticket assigned to Noah, who may not see the security domain: it must stay out of his numbers everywhere.
    const a5 = await mk('a5', { type: 'incident', customerId: ids.a, serviceId: ids.socSvc, title: `DC A5 security breached ${S}`, priorityId: ids.p1, assigneeId: ids.noah });
    expect(a5.domain).toBe('soc');
    const a6 = await mk('a6', { type: 'incident', customerId: ids.a, siteId: ids.siteA, serviceId: ids.amcSvc, title: `DC A6 amc at risk ${S}`, priorityId: ids.p4, assignedTeamId: ids.team });
    expect(a6.domain).toBe('amc');
    await mk('a7', { type: 'incident', customerId: ids.a, serviceId: ids.nocSvc, title: `DC A7 resolved ${S}`, priorityId: ids.p4, assigneeId: ids.noah });
    await mk('b1', { type: 'incident', customerId: ids.b, serviceId: ids.nocSvc, title: `DC B1 major breached ${S}`, priorityId: ids.p1, isMajor: true });
    await mk('b2', { type: 'incident', customerId: ids.b, serviceId: ids.amcSvc, title: `DC B2 resolved ${S}`, priorityId: ids.p4, assigneeId: ids.adminId });
    await resolveTicket(ctx, t.a7!, { resolutionNotes: 'Resolved during the consistency test' });
    await resolveTicket(ctx, t.b2!, { resolutionNotes: 'Resolved during the consistency test' });
  });
  // SLA states on the engine's own rows: breached is the engine flag, at risk is running and warned,
  // a clock past due that the sweep has not flagged yet (A3) is neither.
  await withSystem(async (tx) => {
    for (const id of [t.a1, t.a5, t.b1]) await tx.execute(sql`UPDATE ticket_slas SET state = 'breached', breached_at = now() WHERE ticket_id = ${id}::uuid AND metric = 'resolution'`);
    for (const id of [t.a2, t.a6]) await tx.execute(sql`UPDATE ticket_slas SET warned_at = now() WHERE ticket_id = ${id}::uuid AND metric = 'resolution'`);
    await tx.execute(sql`UPDATE ticket_slas SET due_at = now() - interval '1 hour' WHERE ticket_id = ${t.a3}::uuid AND metric = 'resolution'`);
    await tx.update(schema.tickets).set({ statusId: ids.pendingCustomer }).where(eq(schema.tickets.id, t.a4!));
    const [a5] = await tx.select({ assigneeId: schema.tickets.assigneeId }).from(schema.tickets).where(eq(schema.tickets.id, t.a5!));
    expect(a5?.assigneeId).toBe(ids.noah);
    // Yesterday's rollups exist, so a 30-day management view reads the snapshot for its charts; the tiles must still count live.
    await computeRollups(tx, addDays(toDay(new Date()), -1));
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (created.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, created));
    if (ids.noah) await tx.delete(schema.users).where(eq(schema.users.id, ids.noah));
    if (ids.team) await tx.delete(schema.teams).where(eq(schema.teams.id, ids.team));
    if (ids.nocManager) await tx.delete(schema.users).where(eq(schema.users.id, ids.nocManager));
    const customers = [ids.a, ids.b].filter(Boolean);
    if (customers.length) await tx.delete(schema.metricRollupsDaily).where(inArray(schema.metricRollupsDaily.customerId, customers));
    if (customers.length) await tx.delete(schema.customers).where(inArray(schema.customers.id, customers));
    const services = [ids.nocSvc, ids.socSvc, ids.amcSvc].filter(Boolean);
    if (services.length) await tx.delete(schema.services).where(inArray(schema.services.id, services));
  });
  await closeDb();
});

const scopes: { name: string; customerId: string | null }[] = [{ name: 'all customers', customerId: null }, { name: 'customer A', customerId: '' }];

describe('dashboard numbers reproduce on the list they open', () => {
  for (const scope of scopes) {
    const cust = () => (scope.customerId === null ? null : ids.a);

    /** The management dashboard's linking numbers and the links the web builds for them. */
    const managementRows = (d: Awaited<ReturnType<typeof management>>, customerId: string | null) => {
      const base: TicketListLink = { customerId, status: 'open' };
      return [
        row('kpis.openNow', d.kpis.openNow, base),
        row('kpis.breachedOpen', d.kpis.breachedOpen, { ...base, sla: 'breached' }),
        row('kpis.unassignedOpen', d.kpis.unassignedOpen, { ...base, assignee: 'unassigned' }),
        row('kpis.majorOpen', d.kpis.majorOpen, { ...base, isMajor: true }),
        row('kpis.ticketsOpened', d.kpis.ticketsOpened, { customerId, status: 'any', ...period(d) }),
        row('kpis.ticketsResolved', d.kpis.ticketsResolved, { customerId, status: 'any', ...resolvedIn(d) }),
        row('kpis.openedToday', d.kpis.openedToday, { customerId, status: 'any', createdFrom: toDay(new Date()) }),
        ...d.byService.filter((s) => s.id).flatMap((s) => [
          row(`byService[${s.name}].tickets`, Number(s.tickets), { customerId, serviceId: String(s.id), status: 'any', ...period(d) }),
          row(`byService[${s.name}].breaches`, Number(s.breaches), { customerId, serviceId: String(s.id), status: 'any', sla: 'breached', ...period(d) }),
        ]),
      ];
    };

    for (const days of [7, 30]) {
      it(`management (${scope.name}, ${days} days)`, async () => {
        const customerId = cust();
        const d = await as(admin, (ctx) => management(ctx, { days, customerId }));
        expectScoped(d.kpis.openNow, 6, customerId, 'openNow');
        expectScoped(d.kpis.breachedOpen, 2, customerId, 'breachedOpen');
        expectScoped(d.kpis.ticketsResolved, 1, customerId, 'ticketsResolved');
        expectScoped(d.kpis.ticketsOpened, 7, customerId, 'ticketsOpened');
        await reproduces(admin, managementRows(d, customerId));
      });

      it(`management as a NOC manager without soc:read (${scope.name}, ${days} days)`, async () => {
        const customerId = cust();
        const d = await as(nocManager, (ctx) => management(ctx, { days, customerId }));
        const a = await as(admin, (ctx) => management(ctx, { days, customerId }));
        // The security ticket (A5) is behind the fence on every tile, the period ones included.
        expectScoped(d.kpis.openNow, 5, customerId, 'openNow');
        expectScoped(d.kpis.breachedOpen, 1, customerId, 'breachedOpen');
        expectScoped(d.kpis.ticketsOpened, 6, customerId, 'ticketsOpened');
        expectScoped(d.kpis.ticketsResolved, 1, customerId, 'ticketsResolved');
        expect(d.kpis.openNow).toBeLessThan(a.kpis.openNow);
        expect(d.kpis.ticketsOpened).toBeLessThan(a.kpis.ticketsOpened);
        await reproduces(nocManager, managementRows(d, customerId));
      });
    }

    it(`NOC (${scope.name}, 7 days)`, async () => {
      const customerId = cust();
      const d = await as(admin, (ctx) => noc(ctx, { days: 7, customerId }));
      const base: TicketListLink = { customerId, domain: 'not_soc', status: 'open' };
      const t = d.totals;
      const rows = [
        row('totals.openIncidents', t.openIncidents, { ...base, type: 'incident' }),
        row('totals.open', t.open, base),
        row('totals.atRisk', t.atRisk, { ...base, sla: 'at_risk' }),
        row('totals.breached', t.breached, { ...base, sla: 'breached' }),
        row('slaAtRisk (at risk or breached)', d.slaAtRisk.atRisk + d.slaAtRisk.breached, { ...base, sla: ['breached', 'at_risk'] }),
        row('totals.highRisk', t.highRisk, { ...base, breachRisk: 'high' }),
        row('totals.unassigned', t.unassigned, { ...base, assignee: 'unassigned' }),
        row('totals.major', t.major, { ...base, isMajor: true }),
        row('totals.openedToday', t.openedToday, { customerId, domain: 'not_soc', status: 'any', createdFrom: toDay(new Date()) }),
        ...d.openIncidents.filter((p) => p.id).flatMap((p) => [
          row(`openIncidents[${p.label}].count`, Number(p.count), { ...base, type: 'incident', priorityIds: [String(p.id)] }),
          row(`openIncidents[${p.label}].breached`, Number(p.breached), { ...base, type: 'incident', priorityIds: [String(p.id)], sla: 'breached' }),
        ]),
        ...d.byCategory.filter((c) => c.id).map((c) => row(`byCategory[${c.label}]`, Number(c.count), { ...base, categoryId: String(c.id) })),
        ...d.engineerWorkload.flatMap((u) => [
          row(`engineerWorkload[${u.name}].open`, Number(u.open), { ...base, assignee: String(u.id) }),
          row(`engineerWorkload[${u.name}].breached`, Number(u.breached), { ...base, assignee: String(u.id), sla: 'breached' }),
        ]),
      ];
      expectScoped(t.openIncidents, 4, customerId, 'openIncidents');
      expectScoped(t.atRisk, 2, customerId, 'atRisk');
      expectScoped(t.breached, 1, customerId, 'breached');
      // The unswept past-due clock (A3) is on track, not breached.
      expect(t.open - t.breached - t.atRisk).toBeGreaterThanOrEqual(2);
      expect(d.engineerWorkload.some((u) => u.id === ids.noah)).toBe(true);
      await reproduces(admin, rows);
    });

    it(`SOC (${scope.name}, 7 days)`, async () => {
      const customerId = cust();
      const d = await as(admin, (ctx) => soc(ctx, { days: 7, customerId }));
      const base: TicketListLink = { customerId, domain: 'soc', status: 'open' };
      const t = d.totals;
      const rows = [
        row('totals.open', t.open, base),
        row('totals.breached', t.breached, { ...base, sla: 'breached' }),
        row('totals.atRisk', t.atRisk, { ...base, sla: 'at_risk' }),
        row('SLA at risk tile (atRisk + breached)', t.atRisk + t.breached, { ...base, sla: ['at_risk', 'breached'] }),
        row('totals.unassigned', t.unassigned, { ...base, assignee: 'unassigned' }),
        row('totals.criticalHigh', t.criticalHigh, { ...base, severityIds: [ids.critical, ids.high] }),
        row('totals.openedToday', t.openedToday, { customerId, domain: 'soc', status: 'any', createdFrom: toDay(new Date()) }),
        ...d.bySeverity.filter((s) => s.id).flatMap((s) => [
          row(`bySeverity[${s.label}].count`, Number(s.count), { ...base, severityIds: [String(s.id)] }),
          row(`bySeverity[${s.label}].breached`, Number(s.breached), { ...base, severityIds: [String(s.id)], sla: 'breached' }),
        ]),
        ...d.byCustomer.flatMap((c) => [
          row(`byCustomer[${c.name}].open`, Number(c.open), { customerId: String(c.id), domain: 'soc', status: 'open' }),
          row(`byCustomer[${c.name}].breached`, Number(c.breached), { customerId: String(c.id), domain: 'soc', status: 'open', sla: 'breached' }),
        ]),
      ];
      expectScoped(t.open, 1, customerId, 'open');
      expectScoped(t.breached, 1, customerId, 'breached');
      await reproduces(admin, rows);
    });

    it(`AMC (${scope.name}, 7 days)`, async () => {
      const customerId = cust();
      const d = await as(admin, (ctx) => amc(ctx, { days: 7, customerId }));
      const base: TicketListLink = { customerId, domain: 'amc', status: 'open' };
      const k = d.kpis;
      const rows = [
        row('kpis.open', k.open, base),
        row('kpis.unassigned', k.unassigned, { ...base, assignee: 'unassigned' }),
        row('kpis.breached', k.breached, { ...base, sla: 'breached' }),
        row('kpis.atRisk', k.atRisk, { ...base, sla: 'at_risk' }),
        row('SLA at risk tile (atRisk + breached)', k.atRisk + k.breached, { ...base, sla: ['at_risk', 'breached'] }),
        row('kpis.awaitingCustomer', k.awaitingCustomer, { ...base, statusIds: [ids.pendingCustomer] }),
        row('kpis.openedToday', k.openedToday, { customerId, domain: 'amc', status: 'any', createdFrom: toDay(new Date()) }),
      ];
      expectScoped(k.open, 1, customerId, 'open');
      expectScoped(k.atRisk, 1, customerId, 'atRisk');
      expectScoped(k.unassigned, 1, customerId, 'unassigned');
      await reproduces(admin, rows);
    });

    for (const who of ['admin', 'noah'] as const) {
      it(`My work as ${who} (${scope.name}, 7 days)`, async () => {
        const customerId = cust();
        const p = who === 'admin' ? admin : noah;
        const d = await as(p, (ctx) => engineer(ctx, { days: 7, customerId }));
        const mine: TicketListLink = { customerId, assignee: 'me', status: 'open' };
        const rows = [
          row('assigned.total', d.assigned.total, mine),
          row('assigned.breached', d.assigned.breached, { ...mine, sla: 'breached' }),
          row('activity.breachedAssigned', d.activity.breachedAssigned, { ...mine, sla: 'breached' }),
          ...d.assigned.byPriority.filter((x) => x.id).map((x) => row(`assigned.byPriority[${x.label}]`, x.count, { ...mine, priorityIds: [x.id!] })),
          ...d.teamQueues.flatMap((q) => [
            row(`teamQueues[${q.name}].unassigned`, Number(q.unassigned), { customerId, teamId: String(q.id), assignee: 'unassigned', status: 'open' }),
            row(`teamQueues[${q.name}].open`, Number(q.open), { customerId, teamId: String(q.id), status: 'open' }),
            row(`teamQueues[${q.name}].breached`, Number(q.breached), { customerId, teamId: String(q.id), status: 'open', sla: 'breached' }),
          ]),
          row('resolved by me (series sum)', d.series.reduce((n, r) => n + r.resolved, 0), { customerId, assignee: 'me', status: 'any', ...resolvedIn(d) }),
        ];
        if (d.teamQueues.length) rows.push(row('unassigned in your teams', d.teamQueues.reduce((n, q) => n + Number(q.unassigned), 0), { customerId, teamId: d.teamQueues.map((q) => String(q.id)), assignee: 'unassigned', status: 'open' }));
        if (who === 'noah') {
          expect(d.assigned.total).toBe(1);
          expect(d.teamQueues.map((q) => q.id)).toEqual([ids.team]);
          expect(d.teamQueues[0]!.unassigned).toBe(2);
          expect(d.series.reduce((n, r) => n + r.resolved, 0)).toBe(1);
        } else {
          expectScoped(d.assigned.total, 1, customerId, 'assigned.total');
          expectScoped(d.assigned.breached, 1, customerId, 'assigned.breached');
        }
        await reproduces(p, rows);
      });
    }
  }

  for (const [which, who] of [['A', 'admin'], ['B', 'admin'], ['A', 'nocManager']] as const) {
    it(`customer dashboard for customer ${which} as ${who} (7 days)`, async () => {
      const customerId = which === 'A' ? ids.a : ids.b;
      const p = who === 'admin' ? admin : nocManager;
      const d = await as(p, (ctx) => customer(ctx, { days: 7, customerId }));
      const base: TicketListLink = { customerId, status: 'open' };
      const t = d.tickets;
      const rows = [
        row('tickets.open', t.open, base),
        row('tickets.awaitingReply', t.awaitingReply, { ...base, statusIds: [ids.pendingCustomer] }),
        row('tickets.awaitingApproval', t.awaitingApproval, { ...base, statusIds: [ids.awaitingApproval] }),
        row('tickets.majorOpen', t.majorOpen, { ...base, isMajor: true }),
        row('tickets.resolved30d', t.resolved30d, { customerId, status: 'any', ...resolvedIn(d) }),
        row('tickets.opened30d', t.opened30d, { customerId, status: 'any', ...period(d) }),
        ...t.byPriority.filter((p) => p.id).map((p) => row(`byPriority[${p.label}]`, Number(p.count), { ...base, priorityIds: [String(p.id)] })),
        ...Object.entries(t.byType).map(([type, n]) => row(`byType[${type}]`, n, { ...base, type: type as TicketListLink['type'] })),
      ];
      // The staff view is fenced like the list it opens: the NOC manager does not see A5 (security).
      expect(t.open).toBe(which === 'B' ? 1 : who === 'admin' ? 6 : 5);
      expect(t.awaitingReply).toBe(which === 'A' ? 1 : 0);
      expect(t.resolved30d).toBe(1);
      expect(t.opened30d).toBe(which === 'B' ? 2 : who === 'admin' ? 7 : 6);
      await reproduces(p, rows);
    });
  }
});

describe('one SLA vocabulary', () => {
  it('the list tiles and the dashboards count breached and at risk the same way, and an unswept past-due clock is on track everywhere', async () => {
    for (const customerId of [null, ids.a]) {
      const stats = await as(admin, (ctx) => ticketStats(ctx, customerId ? { customerId } : {}));
      const m = await as(admin, (ctx) => management(ctx, { days: 7, customerId }));
      expect(stats.breached, `breached (${customerId ? 'customer A' : 'all'})`).toBe(m.kpis.breachedOpen);
      const n = await as(admin, (ctx) => noc(ctx, { days: 7, customerId }));
      const s = await as(admin, (ctx) => soc(ctx, { days: 7, customerId }));
      expect(n.totals.atRisk + s.totals.atRisk, 'at risk: NOC (every domain but security) + SOC = list').toBe(stats.atRisk);
      expect(n.totals.breached + s.totals.breached, 'breached: NOC + SOC = list').toBe(stats.breached);
    }
    // Customer A: A1 and A5 breached, A2 and A6 at risk, A3 (past due, not swept) and A4 on track.
    const g = await as(admin, (ctx) => groupTickets(ctx, { customerId: ids.a, open: true }, 'slaState'));
    expect(g.groups).toEqual([{ label: 'Breached', count: 2 }, { label: 'At risk', count: 2 }, { label: 'On track', count: 2 }]);
    const a = await as(admin, (ctx) => amc(ctx, { days: 7, customerId: ids.a }));
    expect([a.kpis.breached, a.kpis.atRisk]).toEqual([0, 1]);
    const onTrackP4 = await as(admin, (ctx) => countTickets(ctx, { customerId: ids.a, open: true, slaState: 'ok', type: 'incident', priorityId: ids.p4 }));
    expect(onTrackP4, 'A3: running, past due, not yet swept → on track').toBe(1);
  });

  it('an engineer without soc:read sees the same numbers on the NOC dashboard, My work and the list', async () => {
    const n = await as(noah, (ctx) => noc(ctx, { days: 7 }));
    const stats = await as(noah, (ctx) => ticketStats(ctx, {}));
    expect(n.totals.open).toBe(stats.open);
    expect(n.totals.breached).toBe(stats.breached);
    expect(n.totals.atRisk).toBe(stats.atRisk);
    expect(n.totals.unassigned).toBe(stats.unassigned);
    // The fence hides security tickets on the list whether or not the link carries the domain:
    // what the administrator sees minus the security domain is exactly what Noah sees.
    expect(await listCount(noah, { status: 'open' })).toBe(n.totals.open);
    expect(await listCount(noah, { domain: 'not_soc', status: 'open' })).toBe(n.totals.open);
    expect(await listCount(admin, { domain: 'not_soc', status: 'open' })).toBe(n.totals.open);
    const adminSoc = await listCount(admin, { domain: 'soc', status: 'open' });
    expect(adminSoc).toBeGreaterThanOrEqual(1);
    expect(await listCount(admin, { status: 'open' })).toBe(n.totals.open + adminSoc);
    const e = await as(noah, (ctx) => engineer(ctx, { days: 7 }));
    expect(e.assigned.total).toBe(stats.mine);
    expect(await listCount(noah, { assignee: 'me', status: 'open' })).toBe(e.assigned.total);
    // A5 (security, breached, assigned to Noah) stays behind the fence on the tiles, the activity panel and the list alike.
    expect(e.assigned.breached).toBe(0);
    expect(e.activity.breachedAssigned).toBe(0);
    expect(await listCount(noah, { assignee: 'me', status: 'open', sla: 'breached' })).toBe(0);
    expect(await listCount(admin, { assignee: ids.noah, status: 'open', sla: 'breached' })).toBe(1);
  });
});
