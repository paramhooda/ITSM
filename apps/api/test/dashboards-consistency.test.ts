/**
 * Every dashboard number that links reproduces itself on the ticket list it
 * opens (DB-backed). Run with the dev environment sourced (DATABASE_URL etc.):
 *   npx vitest run test/dashboards-consistency.test.ts
 *
 * The table below pairs each linking number of the Overview, the four
 * dedicated dashboards, the management view and the customer dashboard with
 * the link the web builds for it through the
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
import { management, noc, soc, amc, engineer, customer, overview } from '@/modules/dashboards/service';
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
/** One REPEATABLE READ transaction: the dashboard and every list count it is compared with read the same snapshot, so other suites writing to the shared database cannot move an all-customers number between the two reads. */
const snapshot = <T>(p: Principal, fn: (ctx: Ctx) => Promise<T>) => runAs(p, meta, fn, { snapshot: true });

/** The number the list shows for a link: parse as the page does, validate as the route does, count with the list's predicates. */
const listCountIn = (ctx: Ctx, link: TicketListLink) => countTickets(ctx, statsQuerySchema.parse(statsParamsForLink(ticketListPath(link))));
const listCount = (p: Principal, link: TicketListLink) => as(p, (ctx) => listCountIn(ctx, link));

interface Row { label: string; value: number; link: TicketListLink }
const row = (label: string, value: number, link: TicketListLink): Row => ({ label, value, link });

/** Asserts every row of a table inside the given transaction; the failure message names the dashboard number and the link it built. */
async function reproducesIn(ctx: Ctx, rows: Row[]) {
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    const n = await listCountIn(ctx, r.link);
    expect(n, `${r.label} = ${r.value} → ${ticketListPath(r.link)}`).toBe(r.value);
  }
}
/** The same over one fresh transaction per count (the dashboards of commit 1, whose fixtures are their own). */
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

interface AgeRow { bucket: string; count: number; breached: number; createdFrom: string | null; createdTo: string | null }
interface HeatCell { day: string; row: string; col: string; value: number; createdFrom: string; createdTo: string }
interface LoadRow { id: string | null; label?: string; name?: string; open: number; breached: number; atRisk: number }

/** The five ageing bars: each carries the exact created window it was counted with (an open-status link plus the window); the stacked bar's two segments are the breached tickets and the rest (on track or at risk). */
const ageingRows = (prefix: string, ageing: AgeRow[], base: TicketListLink): Row[] =>
  ageing.flatMap((a) => [
    row(`${prefix}.ageing[${a.bucket}]`, a.count, { ...base, createdFrom: a.createdFrom, createdTo: a.createdTo }),
    row(`${prefix}.ageing[${a.bucket}].breached`, a.breached, { ...base, sla: 'breached', createdFrom: a.createdFrom, createdTo: a.createdTo }),
    row(`${prefix}.ageing[${a.bucket}].withinSla`, a.count - a.breached, { ...base, sla: ['ok', 'at_risk'], createdFrom: a.createdFrom, createdTo: a.createdTo }),
  ]);
/** The bars of a daily flow chart: a day's "opened" count links with that day as the created range, "resolved" with it as the resolved range (every day with activity plus the first quiet one). */
const flowRows = (prefix: string, series: Record<string, unknown>[], base: Omit<TicketListLink, 'status'>, kinds: Record<string, 'created' | 'resolved'>): Row[] => {
  const keys = Object.keys(kinds);
  const active = series.filter((s) => keys.some((k) => Number(s[k]) > 0));
  const quiet = series.filter((s) => keys.every((k) => Number(s[k]) === 0)).slice(0, 1);
  return [...active, ...quiet].flatMap((s) =>
    keys.map((k) => {
      const day = String(s.day);
      return kinds[k] === 'created' ? row(`${prefix}.series[${day}].${k}`, Number(s[k]), { ...base, status: 'any', createdFrom: day, createdTo: day }) : row(`${prefix}.series[${day}].${k}`, Number(s[k]), { ...base, status: 'any', resolvedFrom: day, resolvedTo: day });
    }),
  );
};
/** The weekly bars of "Resolved by me": the daily series grouped by the Monday of each week, a bar linking with the first and the last day it sums as the resolved range (the web rolls the series up the same way, so a period starting mid-week links only the days it counted). */
const weeklyRows = (prefix: string, series: { day: string; resolved: number }[], base: Omit<TicketListLink, 'status'>): Row[] => {
  const weeks = new Map<string, { from: string; to: string; resolved: number }>();
  for (const s of series) {
    const monday = addDays(s.day, -((new Date(`${s.day}T00:00:00Z`).getUTCDay() + 6) % 7));
    const w = weeks.get(monday) ?? { from: s.day, to: s.day, resolved: 0 };
    w.resolved += s.resolved;
    w.to = s.day;
    weeks.set(monday, w);
  }
  return [...weeks.entries()].map(([monday, w]) => row(`${prefix}.weeks[${monday}]`, w.resolved, { ...base, status: 'any', resolvedFrom: w.from, resolvedTo: w.to }));
};
/** Every cell with arrivals plus the first empty one: the cell's window is the link's created range, whatever the status. */
const heatRows = (prefix: string, cells: HeatCell[], base: Omit<TicketListLink, 'status'>): Row[] => {
  const picked = [...cells.filter((c) => c.value > 0), ...cells.filter((c) => c.value === 0).slice(0, 1)];
  return picked.map((c) => row(`${prefix}.arrivals[${c.day} ${c.col}]`, c.value, { ...base, status: 'any', createdFrom: c.createdFrom, createdTo: c.createdTo }));
};
/** A "who carries the load" table: every row with a record id links by that id. */
const loadRows = (prefix: string, rows: LoadRow[], base: TicketListLink, key: (id: string) => Partial<TicketListLink>): Row[] =>
  rows.filter((r) => r.id).flatMap((r) => [
    row(`${prefix}[${r.label ?? r.name}].open`, r.open, { ...base, ...key(r.id!) }),
    row(`${prefix}[${r.label ?? r.name}].breached`, r.breached, { ...base, ...key(r.id!), sla: 'breached' }),
    row(`${prefix}[${r.label ?? r.name}].atRisk`, r.atRisk, { ...base, ...key(r.id!), sla: 'at_risk' }),
  ]);

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
        ...loadRows('byTeam', d.byTeam, base, (id) => ({ teamId: id })),
        ...loadRows('byService', d.byService, base, (id) => ({ serviceId: id })),
        ...ageingRows('noc', d.ageing, base),
        ...heatRows('noc', d.arrivals.week.cells, { customerId, domain: 'not_soc' }),
        // The incident flow: "incidents opened" bars carry the type, "resolved" bars the resolved range.
        ...flowRows('noc', d.series.map((s) => ({ day: s.day, incidents: s.incidents })), { customerId, domain: 'not_soc', type: 'incident' }, { incidents: 'created' }),
        ...flowRows('noc', d.series.map((s) => ({ day: s.day, resolved: s.resolved })), { customerId, domain: 'not_soc' }, { resolved: 'resolved' }),
      ];
      expectScoped(t.openIncidents, 4, customerId, 'openIncidents');
      expectScoped(t.atRisk, 2, customerId, 'atRisk');
      expectScoped(t.breached, 1, customerId, 'breached');
      // The unswept past-due clock (A3) is on track, not breached.
      expect(t.open - t.breached - t.atRisk).toBeGreaterThanOrEqual(2);
      expect(d.engineerWorkload.some((u) => u.id === ids.noah)).toBe(true);
      expect(d.byTeam.some((r) => r.id === ids.team)).toBe(true);
      expect(d.byService.some((r) => r.id === ids.nocSvc)).toBe(true);
      // The ageing bars add up to the open tile and every fixture ticket is younger than a day.
      expect(d.ageing.reduce((n, a) => n + a.count, 0)).toBe(t.open);
      expect(d.ageing[0]).toMatchObject({ bucket: '< 1 day', createdTo: null });
      expect(d.arrivals.week.cells).toHaveLength(7 * 24);
      // Customer A raised six tickets outside the security domain this week (A5 is security); B raised two more.
      expect(d.arrivals.week.cells.reduce((n, c) => n + c.value, 0)).toBeGreaterThanOrEqual(customerId ? 6 : 8);
      await reproduces(admin, rows);
    });

    it(`NOC with a team filter (${scope.name}, 7 days)`, async () => {
      const customerId = cust();
      const d = await as(admin, (ctx) => noc(ctx, { days: 7, customerId, teamId: ids.team }));
      // The team filter is part of every widget's scope and of every link.
      const base: TicketListLink = { customerId, domain: 'not_soc', status: 'open', teamId: ids.team };
      const t = d.totals;
      const rows = [
        row('totals.open', t.open, base),
        row('totals.openIncidents', t.openIncidents, { ...base, type: 'incident' }),
        row('totals.breached', t.breached, { ...base, sla: 'breached' }),
        row('totals.atRisk', t.atRisk, { ...base, sla: 'at_risk' }),
        row('totals.unassigned', t.unassigned, { ...base, assignee: 'unassigned' }),
        row('totals.major', t.major, { ...base, isMajor: true }),
        row('totals.highRisk', t.highRisk, { ...base, breachRisk: 'high' }),
        row('totals.openedToday', t.openedToday, { customerId, domain: 'not_soc', status: 'any', teamId: ids.team, createdFrom: toDay(new Date()) }),
        ...d.openIncidents.filter((p) => p.id).map((p) => row(`openIncidents[${p.label}]`, Number(p.count), { ...base, type: 'incident', priorityIds: [String(p.id)] })),
        ...d.byCategory.filter((c) => c.id).map((c) => row(`byCategory[${c.label}]`, Number(c.count), { ...base, categoryId: String(c.id) })),
        ...d.engineerWorkload.map((u) => row(`engineerWorkload[${u.name}].open`, Number(u.open), { ...base, assignee: String(u.id) })),
        ...loadRows('byTeam', d.byTeam, base, (id) => ({ teamId: id })),
        ...loadRows('byService', d.byService, base, (id) => ({ serviceId: id })),
        ...ageingRows('noc', d.ageing, base),
        ...heatRows('noc', d.arrivals.week.cells, { customerId, domain: 'not_soc', teamId: ids.team }),
      ];
      // A1, A2 and A6 are the team's tickets (A6 is AMC work carried by the NOC team; B1 has no team).
      expect(d.teamId).toBe(ids.team);
      expect(d.teams.some((x) => x.id === ids.team)).toBe(true);
      expect(t.open).toBe(3);
      expect(t.atRisk).toBe(2);
      expect(t.breached).toBe(1);
      expect(d.byTeam.map((r) => r.id)).toEqual([ids.team]);
      expect(d.ageing.reduce((n, a) => n + a.count, 0)).toBe(3);
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
          row(`byCustomer[${c.name}].criticalHigh`, Number(c.critical_high), { customerId: String(c.id), domain: 'soc', status: 'open', severityIds: d.criticalHighSeverityIds }),
        ]),
        // The "critical / high" tile links with the severity ids the payload names, not a guess.
        row('totals.criticalHigh (payload ids)', t.criticalHigh, { ...base, severityIds: d.criticalHighSeverityIds }),
        ...d.responsivenessBySeverity.filter((r) => r.id).flatMap((r) => [
          row(`responsivenessBySeverity[${r.label}].opened`, r.opened, { customerId, domain: 'soc', status: 'any', severityIds: [r.id!], ...period(d) }),
          row(`responsivenessBySeverity[${r.label}].resolved`, r.resolved, { customerId, domain: 'soc', status: 'any', severityIds: [r.id!], ...resolvedIn(d) }),
          row(`responsivenessBySeverity[${r.label}].breached`, r.breached, { customerId, domain: 'soc', status: 'any', severityIds: [r.id!], sla: 'breached', ...period(d) }),
        ]),
        ...ageingRows('soc', d.ageing, base),
        ...heatRows('soc', d.arrivals.week.cells, { customerId, domain: 'soc' }),
        ...flowRows('soc', d.series.map((s) => ({ day: s.day, opened: s.opened, resolved: s.resolved })), { customerId, domain: 'soc' }, { opened: 'created', resolved: 'resolved' }),
        // The stacked severity bars: a day's count for one severity links with that severity's id and the day.
        ...d.severities.flatMap((sev) => flowRows(`soc.bySeverity[${sev.key}]`, (d.seriesBySeverity as Record<string, unknown>[]).map((r) => ({ day: r.day, [sev.key]: r[sev.key] })), { customerId, domain: 'soc', severityIds: [sev.id] }, { [sev.key]: 'created' })),
      ];
      expectScoped(t.open, 1, customerId, 'open');
      expectScoped(t.breached, 1, customerId, 'breached');
      expect(d.criticalHighSeverityIds).toEqual(expect.arrayContaining([ids.critical, ids.high]));
      expect(d.severities.map((x) => x.key)).toContain('critical');
      // One stacked row per day keyed by severity; the keys add up to the flow's opened count.
      expect(d.seriesBySeverity).toHaveLength(d.series.length);
      for (const [i, day] of d.seriesBySeverity.entries()) expect(Object.entries(day).filter(([k]) => k !== 'day').reduce((n, [, v]) => n + Number(v), 0)).toBe(d.series[i]!.opened);
      expect(d.ageing.reduce((n, a) => n + a.count, 0)).toBe(t.open);
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
        ...d.byCustomer.flatMap((c) => [
          row(`byCustomer[${c.name}].open`, c.open, { customerId: c.id, domain: 'amc', status: 'open' }),
          row(`byCustomer[${c.name}].breached`, c.breached, { customerId: c.id, domain: 'amc', status: 'open', sla: 'breached' }),
          row(`byCustomer[${c.name}].atRisk`, c.atRisk, { customerId: c.id, domain: 'amc', status: 'open', sla: 'at_risk' }),
        ]),
        ...d.bySite.filter((s) => s.id).flatMap((s) => [
          row(`bySite[${s.name}].open`, s.open, { customerId: s.customerId, domain: 'amc', status: 'open', siteId: s.id }),
          row(`bySite[${s.name}].breached`, s.breached, { customerId: s.customerId, domain: 'amc', status: 'open', siteId: s.id, sla: 'breached' }),
        ]),
        ...ageingRows('amc', d.ageing, base),
      ];
      expectScoped(k.open, 1, customerId, 'open');
      expectScoped(k.atRisk, 1, customerId, 'atRisk');
      expectScoped(k.unassigned, 1, customerId, 'unassigned');
      expect(d.byCustomer.some((c) => c.id === ids.a)).toBe(true);
      // A6 sits at customer A's HQ site, so the site row exists and links with the site and the customer.
      expect(d.bySite.some((s) => s.id === ids.siteA && s.customerId === ids.a && s.open === 1)).toBe(true);
      expect(Array.isArray(d.visitsByEngineer)).toBe(true);
      await reproduces(admin, rows);
    });

    for (const who of ['admin', 'nocManager', 'noah'] as const) {
      it(`Overview as ${who} (${scope.name}, 7 days)`, () => snapshot(who === 'admin' ? admin : who === 'nocManager' ? nocManager : noah, async (ctx) => {
        const customerId = cust();
        const p = who === 'admin' ? admin : who === 'nocManager' ? nocManager : noah;
        const d = await overview(ctx, { days: 7, customerId });
        const mine: TicketListLink = { customerId, assignee: 'me', status: 'open' };
        const rows: Row[] = [
          row('me.assigned', d.me.assigned, mine),
          row('me.breached', d.me.breached, { ...mine, sla: 'breached' }),
          row('me.atRisk', d.me.atRisk, { ...mine, sla: 'at_risk' }),
          row('me.resolvedToday', d.me.resolvedToday, { customerId, assignee: 'me', status: 'any', resolvedFrom: toDay(new Date()) }),
          ...d.me.byType.map((t) => row(`me.byType[${t.type}]`, t.count, { ...mine, type: t.type as TicketListLink['type'] })),
        ];
        // Everyone here holds tickets:read, so the desk is present; its numbers are counted live under the caller's own fence.
        expect(d.desk).not.toBeNull();
        const desk = d.desk as NonNullable<typeof d.desk>;
        const k = desk.kpis as Record<string, number | null>;
        const base: TicketListLink = { customerId, status: 'open' };
        rows.push(
          row('desk.kpis.open', k.open!, base),
          row('desk.kpis.breached', k.breached!, { ...base, sla: 'breached' }),
          row('desk.kpis.atRisk', k.atRisk!, { ...base, sla: 'at_risk' }),
          row('desk.kpis.unassigned', k.unassigned!, { ...base, assignee: 'unassigned' }),
          row('desk.kpis.major', k.major!, { ...base, isMajor: true }),
          row('desk.kpis.openedInPeriod', k.openedInPeriod!, { customerId, status: 'any', ...period(d) }),
          row('desk.kpis.resolvedInPeriod', k.resolvedInPeriod!, { customerId, status: 'any', ...resolvedIn(d) }),
          row('desk.kpis.openedToday', k.openedToday!, { customerId, status: 'any', createdFrom: toDay(new Date()) }),
          ...(desk.byType as { type: string; count: number; breached: number }[]).flatMap((t) => [
            row(`desk.byType[${t.type}]`, t.count, { ...base, type: t.type as TicketListLink['type'] }),
            row(`desk.byType[${t.type}].breached`, t.breached, { ...base, type: t.type as TicketListLink['type'], sla: 'breached' }),
          ]),
          ...ageingRows('desk', desk.ageing as AgeRow[], base),
          ...heatRows('desk', (desk.arrivals as { week: { cells: HeatCell[] } }).week.cells, { customerId }),
          ...loadRows('desk.breakdowns.team', (desk.breakdowns as Record<string, LoadRow[]>).team!, base, (id) => ({ teamId: id })),
          ...loadRows('desk.breakdowns.engineer', (desk.breakdowns as Record<string, LoadRow[]>).engineer!, base, (id) => ({ assignee: id })),
          ...loadRows('desk.breakdowns.service', (desk.breakdowns as Record<string, LoadRow[]>).service!, base, (id) => ({ serviceId: id })),
          ...loadRows('desk.breakdowns.customer', (desk.breakdowns as Record<string, LoadRow[]>).customer!, { status: 'open' }, (id) => ({ customerId: id })),
          ...loadRows('desk.breakdowns.category', (desk.breakdowns as Record<string, LoadRow[]>).category!, base, (id) => ({ categoryId: id })),
          ...(desk.byPriority as { id: string | null; priority: string; opened: number; resolved: number }[]).filter((r) => r.id).flatMap((r) => [
            row(`desk.byPriority[${r.priority}].opened`, r.opened, { customerId, status: 'any', priorityIds: [r.id!], ...period(d) }),
            row(`desk.byPriority[${r.priority}].resolved`, r.resolved, { customerId, status: 'any', priorityIds: [r.id!], ...resolvedIn(d) }),
          ]),
          row('desk.changes.open', (desk.changes as { open: number }).open, { ...base, type: 'change' }),
          ...flowRows('desk', desk.series as Record<string, unknown>[], { customerId }, { opened: 'created', resolved: 'resolved' }),
        );
        // The fixture through each person's eyes: the security ticket A5 is behind the fence for the NOC manager and Noah.
        const socHidden = who !== 'admin';
        expectScoped(k.open!, socHidden ? 5 : 6, customerId, 'desk open');
        expectScoped(k.breached!, socHidden ? 1 : 2, customerId, 'desk breached');
        expectScoped(k.unassigned!, 3, customerId, 'desk unassigned');
        expectScoped(k.openedInPeriod!, socHidden ? 6 : 7, customerId, 'desk opened');
        expectScoped(k.resolvedInPeriod!, 1, customerId, 'desk resolved');
        expect((desk.ageing as AgeRow[]).reduce((n, a) => n + a.count, 0)).toBe(k.open);
        const arrivals = desk.arrivals as { week: { cells: HeatCell[]; from: string; to: string }; pattern: { cells: { value: number }[] }; timezone: string };
        expect(arrivals.week.cells).toHaveLength(7 * 24);
        expect(arrivals.pattern.cells).toHaveLength(7 * 24);
        // The week's cells add up to the tickets created inside the week's window, whatever the status.
        const first = arrivals.week.cells[0]!;
        const last = arrivals.week.cells[arrivals.week.cells.length - 1]!;
        expect(arrivals.week.cells.reduce((n, c) => n + c.value, 0)).toBe(await listCountIn(ctx, { customerId, status: 'any', createdFrom: first.createdFrom, createdTo: last.createdTo }));
        expect((desk.series as unknown[]).length).toBe(7);
        if (who === 'noah') expect(d.me.assigned).toBe(1);
        // Strips appear only with the dashboard permission and read exactly what the dedicated dashboard's tiles read.
        if (who === 'noah') {
          expect(d.strips.noc).toBeDefined();
          expect(d.strips.soc).toBeUndefined();
          expect(d.strips.amc).toBeUndefined();
          expect(d.management).toBeNull();
        } else if (who === 'nocManager') {
          expect(d.strips.noc).toBeDefined();
          expect(d.strips.soc).toBeUndefined();
          expect(d.strips.amc).toBeDefined();
          expect(d.management).not.toBeNull();
        } else {
          expect(d.strips.noc && d.strips.soc && d.strips.amc).toBeTruthy();
          expect(d.management).not.toBeNull();
        }
        if (d.strips.noc) {
          const n = await noc(ctx, { days: 7, customerId });
          expect(d.strips.noc).toEqual(n.totals);
          const nocOpen: TicketListLink = { customerId, domain: 'not_soc', status: 'open' };
          rows.push(
            row('strips.noc.openIncidents', d.strips.noc.openIncidents, { ...nocOpen, type: 'incident' }),
            row('strips.noc.breached', d.strips.noc.breached, { ...nocOpen, sla: 'breached' }),
            row('strips.noc.atRisk', d.strips.noc.atRisk, { ...nocOpen, sla: 'at_risk' }),
            row('strips.noc.unassigned', d.strips.noc.unassigned, { ...nocOpen, assignee: 'unassigned' }),
            row('strips.noc.major', d.strips.noc.major, { ...nocOpen, isMajor: true }),
          );
        }
        if (d.strips.soc) {
          const sd = await soc(ctx, { days: 7, customerId });
          expect(d.strips.soc).toEqual(sd.totals);
          const socOpen: TicketListLink = { customerId, domain: 'soc', status: 'open' };
          rows.push(
            row('strips.soc.open', d.strips.soc.open, socOpen),
            row('strips.soc.criticalHigh', d.strips.soc.criticalHigh, { ...socOpen, severityIds: d.strips.soc.criticalHighSeverityIds }),
            row('strips.soc.breached', d.strips.soc.breached, { ...socOpen, sla: 'breached' }),
            row('strips.soc.atRisk', d.strips.soc.atRisk, { ...socOpen, sla: 'at_risk' }),
            row('strips.soc.unassigned', d.strips.soc.unassigned, { ...socOpen, assignee: 'unassigned' }),
          );
        }
        if (d.strips.amc) {
          const ad = await amc(ctx, { days: 7, customerId });
          expect(d.strips.amc).toEqual(ad.kpis);
          const amcOpen: TicketListLink = { customerId, domain: 'amc', status: 'open' };
          rows.push(
            row('strips.amc.open', d.strips.amc.open, amcOpen),
            row('strips.amc.breached', d.strips.amc.breached, { ...amcOpen, sla: 'breached' }),
            row('strips.amc.atRisk', d.strips.amc.atRisk, { ...amcOpen, sla: 'at_risk' }),
            row('strips.amc.unassigned', d.strips.amc.unassigned, { ...amcOpen, assignee: 'unassigned' }),
          );
        }
        if (d.management) {
          // The "needs attention" rows are the management dashboard's own rows.
          const m = await management(ctx, { days: 7, customerId });
          const attention = (d.management as { needsAttention: { id: string; tickets: number; major: number; slaBreached: number }[] }).needsAttention;
          expect(attention.map((r) => r.id).sort()).toEqual(m.byCustomer.map((r) => r.id).sort());
          // A row's ticket and major counts are doors (the period as the created range); its breached count is a clock count and stays a figure.
          rows.push(...attention.flatMap((r) => [row(`management.needsAttention[${r.id}].tickets`, r.tickets, { customerId: r.id, status: 'any', ...period(d) }), row(`management.needsAttention[${r.id}].major`, r.major, { customerId: r.id, status: 'any', isMajor: true, ...period(d) })]));
        }
        expect(p.id).toBe(ctx.user.id);
        await reproducesIn(ctx, rows);
      }));
    }

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
          ...flowRows('engineer', d.series.map((r) => ({ day: r.day, resolved: r.resolved })), { customerId, assignee: 'me' }, { resolved: 'resolved' }),
          ...weeklyRows('engineer', d.series, { customerId, assignee: 'me' }),
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
      // The overview's desk reads the same numbers as the list tiles and the management dashboard (one snapshot, so other suites cannot move an all-customers number in between).
      await snapshot(admin, async (ctx) => {
        const o = await overview(ctx, { days: 7, customerId });
        const k = o.desk!.kpis as Record<string, number | null>;
        const st = await ticketStats(ctx, customerId ? { customerId } : {});
        const mg = await management(ctx, { days: 7, customerId });
        expect([k.open, k.breached, k.atRisk, k.unassigned], `overview desk (${customerId ? 'customer A' : 'all'})`).toEqual([st.open, st.breached, st.atRisk, st.unassigned]);
        expect(k.breached).toBe(mg.kpis.breachedOpen);
      });
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
    const o = await as(noah, (ctx) => overview(ctx, { days: 7 }));
    expect(o.me.assigned).toBe(stats.mine);
    expect(o.me.breached).toBe(0);
    expect((o.desk!.kpis as { open: number }).open).toBe(stats.open);
    // A5 (security, breached, assigned to Noah) stays behind the fence on the tiles, the activity panel and the list alike.
    expect(e.assigned.breached).toBe(0);
    expect(e.activity.breachedAssigned).toBe(0);
    expect(await listCount(noah, { assignee: 'me', status: 'open', sla: 'breached' })).toBe(0);
    expect(await listCount(admin, { assignee: ids.noah, status: 'open', sla: 'breached' })).toBe(1);
  });
});
