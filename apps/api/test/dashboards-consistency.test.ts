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
import { countPortalTickets, portalMaintenance, portalPlannedChanges, listPortalApprovals, portalSla, me } from '@/modules/portal/service';
import { customersOverview } from '@/modules/customers/overview';
import { customerOverview } from '@/modules/customers/service';
import { attentionByCustomer, socCond } from '@/modules/dashboards/common';
import { resolutionCompliance } from '@/modules/sla/compliance';
import { complianceOverview } from '@/modules/sla/policies';
import { briefingDefinition, type BriefingDefinition } from '@/modules/briefings/definitions';
import type { BriefingDoor, BriefingKpi } from '@/db/schema/briefings';
import { portalTicketStatsQuery } from '@/modules/portal/schemas';
import { toDay, addDays } from '@/modules/reports/dates';
import { computeRollups } from '@/jobs/processors/metrics';
import { ticketListPath, ticketListQuery, portalTicketListPath, portalTicketListQuery, PORTAL_TICKET_LINK_KEYS, type TicketListLink } from '@itsm/shared';
import { statsParamsForLink, portalParamsForLink } from '../../web/src/components/tickets/listQuery';

const S = Math.random().toString(36).slice(2, 8);
const ids = { adminId: '', noah: '', nocManager: '', portalA: '', portalAdminA: '', a: '', b: '', siteA: '', nocSvc: '', socSvc: '', amcSvc: '', team: '', p1: '', p4: '', pendingCustomer: '', awaitingApproval: '', critical: '', high: '', visit1: '', foldedOccurrence: '' };
let admin: Principal;
let noah: Principal;
/** Holds `dashboards:management` and `customers:read` but not `soc:read`: the security fence applies to every dashboard they open. */
let nocManager: Principal;
/** A customer user of A: the portal home's doors are counted through the portal list as this principal. */
let portalA: Principal;
/** A customer administrator of A (portal:approve): the Upcoming line's approvals count is held against the approvals page as this principal. */
let portalAdminA: Principal;
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
/** The same through the customer portal: the portal link builder (portal-safe keys only), the portal page's defaults, the portal route's schema and the portal list's own count. */
const portalListCountIn = (ctx: Ctx, link: TicketListLink) => countPortalTickets(ctx, portalTicketStatsQuery.parse(portalParamsForLink(portalTicketListPath(link))));

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
/** Every row through the portal list as the portal principal of the transaction. */
async function reproducesInPortal(ctx: Ctx, rows: Row[]) {
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    const n = await portalListCountIn(ctx, r.link);
    expect(n, `${r.label} = ${r.value} → ${portalTicketListPath(r.link)}`).toBe(r.value);
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
/** The two outcome keys of an SLA compliance door: the resolution clocks that ended in the window. */
const ended = (outcome: 'met' | 'breached', w: { from: string; to: string }): Partial<TicketListLink> => ({ status: 'any', slaOutcome: outcome, slaEndedFrom: w.from, slaEndedTo: w.to });

interface SlaBlock { met: number; breached: number; compliancePct: number | null; open: { atRisk: number; breached: number } }
/**
 * The SLA compliance donut of a dashboard: the met and breached segments open the list with the outcome and the period as the window
 * (`status: 'any'`, since the tickets behind an ended clock may be resolved), the "open now" figures under it with the shared SLA states.
 */
const slaRows = (prefix: string, sla: SlaBlock, scope: Omit<TicketListLink, 'status'>, w: { from: string; to: string }): Row[] => [
  row(`${prefix}.met`, sla.met, { ...scope, ...ended('met', w) }),
  row(`${prefix}.breached`, sla.breached, { ...scope, ...ended('breached', w) }),
  row(`${prefix}.open.atRisk`, sla.open.atRisk, { ...scope, status: 'open', sla: 'at_risk' }),
  row(`${prefix}.open.breached`, sla.open.breached, { ...scope, status: 'open', sla: 'breached' }),
];

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
const flowRows = (prefix: string, points: object[], base: Omit<TicketListLink, 'status'>, kinds: Record<string, 'created' | 'resolved'>): Row[] => {
  const keys = Object.keys(kinds);
  const series = points as Record<string, unknown>[];
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
    // The admin is A's account manager, so the account manager briefing's per-customer doors are held here too.
    const [a] = await tx.insert(schema.customers).values({ code: `DCA${S.toUpperCase()}`, name: `Consistency Customer A ${S}`, accountManagerId: adminUser.id }).returning();
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
    const [pu] = await tx.insert(schema.users).values({ email: `dc-portal-${S}@example.test`, name: 'Pat Portal', userType: 'customer', customerId: a!.id, status: 'active' }).returning();
    ids.portalA = pu!.id;
    await tx.insert(schema.userRoles).values({ userId: pu!.id, roleId: await roleId(tx, 'customer_user'), customerId: a!.id });
    const [pa] = await tx.insert(schema.users).values({ email: `dc-portal-admin-${S}@example.test`, name: 'Ada Portal', userType: 'customer', customerId: a!.id, status: 'active' }).returning();
    ids.portalAdminA = pa!.id;
    await tx.insert(schema.userRoles).values({ userId: pa!.id, roleId: await roleId(tx, 'customer_admin'), customerId: a!.id });
  });
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminId))!;
  noah = (await loadPrincipal(ids.noah))!;
  nocManager = (await loadPrincipal(ids.nocManager))!;
  portalA = (await loadPrincipal(ids.portalA))!;
  portalAdminA = (await loadPrincipal(ids.portalAdminA))!;
  expect(portalA.userType).toBe('customer');
  expect(portalAdminA.userType).toBe('customer');
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
    // A change of A scheduled ahead: the portal home's Upcoming line counts it the way the planned-changes page does.
    await mk('c1', { type: 'change', customerId: ids.a, siteId: ids.siteA, serviceId: ids.nocSvc, title: `DC C1 planned change ${S}`, priorityId: ids.p4 });
    // A8 awaits the organisation's approval (counts under "Waiting on you" and "Awaiting your approval"); A9 awaits an internal approver (counts in neither).
    await mk('a8', { type: 'request', customerId: ids.a, title: `DC A8 awaiting the customer's approval ${S}`, priorityId: ids.p4 });
    await mk('a9', { type: 'incident', customerId: ids.a, title: `DC A9 awaiting an internal approval ${S}`, priorityId: ids.p4 });
    await resolveTicket(ctx, t.a7!, { resolutionNotes: 'Resolved during the consistency test' });
    await resolveTicket(ctx, t.b2!, { resolutionNotes: 'Resolved during the consistency test' });
  });
  // Visits and maintenance of A for the portal home's Upcoming line: coming ones at site HQ and without a site, one past, one beyond the horizon.
  await withSystem(async (tx) => {
    const at = (days: number) => new Date(Date.now() + days * 86_400_000);
    const visit = (n: number, v: Partial<typeof schema.fieldVisits.$inferInsert>) => ({ number: `FV-DC-${S}-${n}`, customerId: ids.a, title: `DC visit ${n} ${S}`, ...v });
    const visits = await tx.insert(schema.fieldVisits).values([
      visit(1, { status: 'scheduled', siteId: ids.siteA, engineerId: ids.adminId, scheduledStart: at(2) }),
      visit(2, { status: 'requested', siteId: null, engineerId: ids.adminId, scheduledStart: null }),
      visit(3, { status: 'scheduled', siteId: ids.siteA, engineerId: ids.adminId, scheduledStart: at(-4) }),
      visit(4, { status: 'completed', siteId: ids.siteA, engineerId: ids.adminId, scheduledStart: at(1), actualStart: at(1), actualEnd: at(1) }),
      visit(5, { status: 'scheduled', siteId: ids.siteA, engineerId: ids.adminId, scheduledStart: at(120) }),
    ]).returning({ id: schema.fieldVisits.id, number: schema.fieldVisits.number });
    ids.visit1 = visits.find((v) => v.number === `FV-DC-${S}-1`)!.id;
    const today = toDay(new Date());
    const [hq] = await tx.insert(schema.pmPrograms).values({ customerId: ids.a, siteId: ids.siteA, name: `DC PM HQ ${S}`, frequency: 'monthly', startDate: addDays(today, -60), assignedEngineerId: ids.adminId }).returning();
    const [nosite] = await tx.insert(schema.pmPrograms).values({ customerId: ids.a, siteId: null, name: `DC PM no site ${S}`, frequency: 'monthly', startDate: addDays(today, -60), assignedEngineerId: ids.adminId }).returning();
    const occurrences = await tx.insert(schema.pmOccurrences).values([
      { programId: hq!.id, customerId: ids.a, plannedDate: today, status: 'planned' },
      { programId: hq!.id, customerId: ids.a, plannedDate: addDays(today, 20), scheduledDate: addDays(today, 22), status: 'scheduled' },
      { programId: hq!.id, customerId: ids.a, plannedDate: addDays(today, -30), status: 'completed' },
      { programId: nosite!.id, customerId: ids.a, plannedDate: addDays(today, 5), status: 'rescheduled' },
      { programId: nosite!.id, customerId: ids.a, plannedDate: addDays(today, 100), status: 'planned' },
      // An occurrence at HQ with visit 1 booked for it: the maintenance page lists it as that visit, so the home counts it among the visits and not the maintenance.
      { programId: hq!.id, customerId: ids.a, plannedDate: addDays(today, 2), scheduledDate: addDays(today, 2), status: 'scheduled', fieldVisitId: ids.visit1 },
    ]).returning({ id: schema.pmOccurrences.id, fieldVisitId: schema.pmOccurrences.fieldVisitId });
    ids.foldedOccurrence = occurrences.find((o) => o.fieldVisitId === ids.visit1)!.id;
    // The change's window: tomorrow, two hours.
    await tx.update(schema.changeDetails).set({ scheduledStart: at(1), scheduledEnd: new Date(at(1).getTime() + 2 * 3_600_000) }).where(eq(schema.changeDetails.ticketId, t.c1!));
    // A pending approval of A4 addressed to the organisation's administrators: the home's "N approvals" for a customer_admin is the approvals page's total.
    await tx.insert(schema.approvals).values({ ticketId: t.a4!, customerId: ids.a, step: 1, stepName: 'Customer approval', approverRoleKey: 'customer_admin', status: 'pending' });
    // A8's step is addressed to the organisation's administrators (a customer party), A9's to an internal role.
    await tx.insert(schema.approvals).values({ ticketId: t.a8!, customerId: ids.a, step: 1, stepName: 'Customer approval', approverRoleKey: 'customer_admin', status: 'pending' });
    await tx.insert(schema.approvals).values({ ticketId: t.a9!, customerId: ids.a, step: 1, stepName: 'Service manager', approverRoleKey: 'service_manager', status: 'pending' });
  });
  // SLA states on the engine's own rows: breached is the engine flag, at risk is running and warned,
  // a clock past due that the sweep has not flagged yet (A3) is neither.
  await withSystem(async (tx) => {
    for (const id of [t.a1, t.a5, t.b1]) await tx.execute(sql`UPDATE ticket_slas SET state = 'breached', breached_at = now() WHERE ticket_id = ${id}::uuid AND metric = 'resolution'`);
    for (const id of [t.a2, t.a6]) await tx.execute(sql`UPDATE ticket_slas SET warned_at = now() WHERE ticket_id = ${id}::uuid AND metric = 'resolution'`);
    await tx.execute(sql`UPDATE ticket_slas SET due_at = now() - interval '1 hour' WHERE ticket_id = ${t.a3}::uuid AND metric = 'resolution'`);
    // "Waiting on you" is the column, not the status key: A4 waits for a reply, A8 for the organisation's approval, A9 for an internal approver.
    // A8 and A9 are set by a direct update, which bypasses `statusApplies` (awaiting_approval applies to requests and changes until 1b) and the
    // awaiting_approval guard of `changeStatusCore` (only `startApproval` may enter it); 1b creates A8 through `requestApproval`.
    await tx.update(schema.tickets).set({ statusId: ids.pendingCustomer, pendingWaitingOn: 'customer', pendingReason: 'Please confirm the delivery address', pendingSetAt: new Date() }).where(eq(schema.tickets.id, t.a4!));
    await tx.update(schema.tickets).set({ statusId: ids.awaitingApproval, pendingWaitingOn: 'customer', pendingReason: 'Approval requested (Customer approval)', pendingSetAt: new Date() }).where(eq(schema.tickets.id, t.a8!));
    await tx.update(schema.tickets).set({ statusId: ids.awaitingApproval, pendingWaitingOn: 'internal', pendingReason: 'Approval requested (Service manager)', pendingSetAt: new Date() }).where(eq(schema.tickets.id, t.a9!));
    // A7 (resolved) carries a live survey: the portal home's "to rate" banner has a number to reproduce.
    await tx.delete(schema.ticketSurveys).where(eq(schema.ticketSurveys.ticketId, t.a7!));
    await tx.insert(schema.ticketSurveys).values({ ticketId: t.a7!, customerId: ids.a, ticketType: 'incident', trigger: 'resolved', question: 'How did we do?', tokenHash: `dc-${S}`, tokenPrefix: 'dc', tokenEnc: 'x', status: 'pending', expiresAt: new Date(Date.now() + 7 * 86_400_000) });
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
    if (ids.portalA) await tx.delete(schema.users).where(eq(schema.users.id, ids.portalA));
    if (ids.portalAdminA) await tx.delete(schema.users).where(eq(schema.users.id, ids.portalAdminA));
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
        ...slaRows('sla', d.sla, { customerId }, d.period),
        // The "needs attention" rows: SLA met and breached per customer are doors (the customer, the outcome, the period as the window).
        ...d.byCustomer.flatMap((c) => [row(`byCustomer[${c.name}].slaMet`, c.slaMet, { customerId: c.id, ...ended('met', d.period) }), row(`byCustomer[${c.name}].slaBreached`, c.slaBreached, { customerId: c.id, ...ended('breached', d.period) })]),
        ...d.byService.filter((s) => s.id).flatMap((s) => [
          row(`byService[${s.name}].tickets`, Number(s.tickets), { customerId, serviceId: String(s.id), status: 'any', ...period(d) }),
          row(`byService[${s.name}].breaches`, Number(s.breaches), { customerId, serviceId: String(s.id), status: 'any', sla: 'breached', ...period(d) }),
        ]),
      ];
    };

    for (const days of [7, 30]) {
      // One snapshot per table: the compliance doors count clocks other suites end concurrently, so the dashboard and every list count read the same instant.
      it(`management (${scope.name}, ${days} days)`, () => snapshot(admin, async (ctx) => {
        const customerId = cust();
        const d = await management(ctx, { days, customerId });
        // Six open tickets of A, the planned change C1 (open, without clocks), A8 and A9 awaiting approvals.
        expectScoped(d.kpis.openNow, 9, customerId, 'openNow');
        expectScoped(d.kpis.breachedOpen, 2, customerId, 'breachedOpen');
        expectScoped(d.kpis.ticketsResolved, 1, customerId, 'ticketsResolved');
        expectScoped(d.kpis.ticketsOpened, 10, customerId, 'ticketsOpened');
        // A7 resolved within target; A1 and A5 flagged today: the compliance block is the helper's figure and the KPIs read it.
        expectScoped(d.sla.met, 1, customerId, 'sla.met');
        expectScoped(d.sla.breached, 2, customerId, 'sla.breached');
        expect([d.kpis.slaCompliancePct, d.kpis.resolutionMet, d.kpis.resolutionBreached]).toEqual([d.sla.compliancePct, d.sla.met, d.sla.breached]);
        // A's attention row carries A's own figure (the list keeps the ten customers with the most tickets, so unscoped A may rank below the demo customers).
        const rowA = d.byCustomer.find((c) => c.id === ids.a);
        if (customerId || rowA) expect(rowA).toMatchObject({ slaMet: 1, slaBreached: 2, compliancePct: 33.3 });
        await reproducesIn(ctx, managementRows(d, customerId));
      }));

      it(`management as a NOC manager without soc:read (${scope.name}, ${days} days)`, () => snapshot(nocManager, async (ctx) => {
        const customerId = cust();
        const d = await management(ctx, { days, customerId });
        const a = await as(admin, (ctx) => management(ctx, { days, customerId }));
        // The security ticket (A5) is behind the fence on every tile, the period ones included.
        expectScoped(d.kpis.openNow, 8, customerId, 'openNow');
        expectScoped(d.kpis.breachedOpen, 1, customerId, 'breachedOpen');
        expectScoped(d.kpis.ticketsOpened, 9, customerId, 'ticketsOpened');
        expectScoped(d.kpis.ticketsResolved, 1, customerId, 'ticketsResolved');
        expect(d.kpis.openNow).toBeLessThan(a.kpis.openNow);
        expect(d.kpis.ticketsOpened).toBeLessThan(a.kpis.ticketsOpened);
        // The security clock (A5) is behind the fence on the compliance block and on the attention row alike.
        expectScoped(d.sla.breached, 1, customerId, 'sla.breached');
        const rowA = d.byCustomer.find((c) => c.id === ids.a);
        if (customerId || rowA) expect(rowA).toMatchObject({ slaMet: 1, slaBreached: 1, compliancePct: 50 });
        await reproducesIn(ctx, managementRows(d, customerId));
      }));
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
        ...slaRows('sla', d.sla, { customerId, domain: 'not_soc' }, d.period),
      ];
      // A1, A2, A3, A6 and A9 (awaiting an internal approval, general domain); A5 is security.
      expectScoped(t.openIncidents, 5, customerId, 'openIncidents');
      // A7 met, A1 breached (A5 is security, out of the NOC's domain).
      expectScoped(d.sla.met, 1, customerId, 'sla.met');
      expectScoped(d.sla.breached, 1, customerId, 'sla.breached');
      expect(d.sla.open).toEqual({ atRisk: t.atRisk, breached: t.breached });
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
        ...slaRows('sla', d.sla, { customerId, domain: 'not_soc', teamId: ids.team }, d.period),
      ];
      // A1, A2 and A6 are the team's tickets (A6 is AMC work carried by the NOC team; B1 has no team).
      expect(d.teamId).toBe(ids.team);
      expect([d.sla.met, d.sla.breached]).toEqual([0, 1]);
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
        ...slaRows('sla', d.sla, { customerId, domain: 'soc' }, d.period),
      ];
      expectScoped(t.open, 1, customerId, 'open');
      expectScoped(t.breached, 1, customerId, 'breached');
      // A5: the security clock flagged today.
      expectScoped(d.sla.breached, 1, customerId, 'sla.breached');
      expectScoped(d.sla.met, 0, customerId, 'sla.met');
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
        row('kpis.awaitingCustomer', k.awaitingCustomer, { ...base, waitingOn: ['customer'] }),
        row('queue.counts.awaitingCustomer', d.queue.counts.awaitingCustomer, { ...base, waitingOn: ['customer'] }),
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
        ...slaRows('sla', d.sla, { customerId, domain: 'amc' }, d.period),
      ];
      expectScoped(k.open, 1, customerId, 'open');
      expectScoped(k.atRisk, 1, customerId, 'atRisk');
      // B2 (AMC, resolved within target) is the one clock that ended; A's AMC ticket is still running.
      expectScoped(d.sla.met, 0, customerId, 'sla.met');
      if (!customerId) expect(d.sla.met).toBeGreaterThanOrEqual(1);
      expect(d.sla.open).toEqual({ atRisk: k.atRisk, breached: k.breached });
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
          // The SLA compliance donut beside the desk: a sibling of `kpis` whose KPIs it feeds.
          ...slaRows('desk.sla', desk.sla as SlaBlock, { customerId }, d.period),
        );
        const sla = desk.sla as SlaBlock & { previous: { met: number; breached: number; compliancePct: number | null } };
        expect([k.slaCompliancePct, k.resolutionMet, k.resolutionBreached]).toEqual([sla.compliancePct, sla.met, sla.breached]);
        expect(sla.open).toEqual({ atRisk: k.atRisk, breached: k.breached });
        expect(sla.previous).toMatchObject({ met: expect.any(Number), breached: expect.any(Number) });
        expectScoped(sla.met, 1, customerId, 'desk.sla.met');
        expectScoped(sla.breached, who === 'admin' ? 2 : 1, customerId, 'desk.sla.breached');
        // The fixture through each person's eyes: the security ticket A5 is behind the fence for the NOC manager and Noah.
        const socHidden = who !== 'admin';
        expectScoped(k.open!, socHidden ? 8 : 9, customerId, 'desk open');
        expectScoped(k.breached!, socHidden ? 1 : 2, customerId, 'desk breached');
        expectScoped(k.unassigned!, 6, customerId, 'desk unassigned');
        expectScoped(k.openedInPeriod!, socHidden ? 9 : 10, customerId, 'desk opened');
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
          const attention = (d.management as { needsAttention: { id: string; tickets: number; major: number; slaMet: number; slaBreached: number }[] }).needsAttention;
          expect(attention.map((r) => r.id).sort()).toEqual(m.byCustomer.map((r) => r.id).sort());
          // A row's ticket and major counts are doors (the period as the created range); its met and breached clocks are doors too (the outcome with the period as the window).
          rows.push(...attention.flatMap((r) => [
            row(`management.needsAttention[${r.id}].tickets`, r.tickets, { customerId: r.id, status: 'any', ...period(d) }),
            row(`management.needsAttention[${r.id}].major`, r.major, { customerId: r.id, status: 'any', isMajor: true, ...period(d) }),
            row(`management.needsAttention[${r.id}].slaMet`, r.slaMet, { customerId: r.id, ...ended('met', d.period) }),
            row(`management.needsAttention[${r.id}].slaBreached`, r.slaBreached, { customerId: r.id, ...ended('breached', d.period) }),
          ]));
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
        rows.push(...slaRows('sla', d.sla, { customerId, assignee: 'me' }, d.period));
        if (who === 'noah') {
          // A7 (resolved within target) is Noah's; A5's breached clock is behind his fence.
          expect([d.sla.met, d.sla.breached]).toEqual([1, 0]);
          expect(d.sla.open).toEqual({ atRisk: 0, breached: 0 });
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
      // Staff read the major count (a staff-only key on the list); the rest of the rows are the portal's doors as a staff caller.
      expect(typeof t.majorOpen).toBe('number');
      const rows = [
        row('tickets.open', t.open, base),
        row('tickets.breached', t.breached, { ...base, sla: 'breached' }),
        row('tickets.atRisk', t.atRisk, { ...base, sla: 'at_risk' }),
        row('tickets.waitingOnYou', t.waitingOnYou, { ...base, waitingOn: ['customer'] }),
        row('tickets.awaitingApproval', t.awaitingApproval, { ...base, waitingOn: ['customer'], statusIds: [ids.awaitingApproval] }),
        row('tickets.majorOpen', t.majorOpen!, { ...base, isMajor: true }),
        row('tickets.resolvedInPeriod', t.resolvedInPeriod, { customerId, status: 'any', ...resolvedIn(d) }),
        row('tickets.openedInPeriod', t.openedInPeriod, { customerId, status: 'any', ...period(d) }),
        ...t.byPriority.filter((p) => p.id).flatMap((p) => [row(`byPriority[${p.label}]`, p.count, { ...base, priorityIds: [p.id!] }), row(`byPriority[${p.label}].breached`, p.breached, { ...base, priorityIds: [p.id!], sla: 'breached' })]),
        ...t.byType.flatMap((b) => [row(`byType[${b.type}]`, b.count, { ...base, type: b.type as TicketListLink['type'] }), row(`byType[${b.type}].breached`, b.breached, { ...base, type: b.type as TicketListLink['type'], sla: 'breached' })]),
        ...loadRows('bySite', t.bySite, base, (id) => ({ siteId: id })),
        ...loadRows('byService', t.byService, base, (id) => ({ serviceId: id })),
        ...flowRows('customer', d.series, { customerId }, { opened: 'created', resolved: 'resolved' }),
        ...ageingRows('customer', d.ageing, base),
        ...slaRows('sla', d.sla, { customerId }, d.period),
        ...d.sla.byPriority.filter((p) => p.id).flatMap((p) => [row(`sla.byPriority[${p.label}].met`, p.met, { customerId, priorityIds: [p.id!], ...ended('met', d.period) }), row(`sla.byPriority[${p.label}].breached`, p.breached, { customerId, priorityIds: [p.id!], ...ended('breached', d.period) })]),
      ];
      // The staff view is fenced like the list it opens: the NOC manager does not see A5 (security).
      expect(t.open).toBe(which === 'B' ? 1 : who === 'admin' ? 9 : 8);
      expect([d.sla.met, d.sla.breached]).toEqual(which === 'B' ? [1, 1] : who === 'admin' ? [1, 2] : [1, 1]);
      expect(d.sla.byPriority.reduce((n, p) => n + p.met + p.breached, 0)).toBe(d.sla.met + d.sla.breached);
      // A4 (a reply) and A8 (the organisation's approval) wait on the customer; A9 waits on an internal approver and counts in neither number.
      expect(t.waitingOnYou).toBe(which === 'A' ? 2 : 0);
      expect(t.awaitingApproval).toBe(which === 'A' ? 1 : 0);
      expect(t.resolvedInPeriod).toBe(1);
      expect(t.openedInPeriod).toBe(which === 'B' ? 2 : who === 'admin' ? 10 : 9);
      expect(t.awaitingApprovalStatusId).toBe(ids.awaitingApproval);
      await reproduces(p, rows);
    });
  }
});

describe('the portal home as a portal user (7 days; all sites and site HQ)', () => {
  for (const scope of [{ name: 'all sites', siteId: null }, { name: 'site HQ', siteId: () => ids.siteA }] as const) {
    it(`every number reproduces through the portal list and the Upcoming counts are the lengths of the lists they open (${scope.name})`, async () => {
      const siteId = typeof scope.siteId === 'function' ? scope.siteId() : null;
      await snapshot(portalA, async (ctx) => {
        const d = await customer(ctx, { days: 7, siteId });
        const t = d.tickets;
        expect(d.siteId).toBe(siteId);
        expect(d.site?.name ?? null).toBe(siteId ? 'HQ' : null);
        // Nothing staff-only leaves for a portal principal.
        expect(t.majorOpen).toBeNull();
        const open: TicketListLink = { status: 'open', siteId };
        const any: Omit<TicketListLink, 'status'> = { siteId };
        const rows = [
          row('tickets.open', t.open, open),
          row('tickets.breached', t.breached, { ...open, sla: 'breached' }),
          row('tickets.atRisk', t.atRisk, { ...open, sla: 'at_risk' }),
          row('tickets.waitingOnYou', t.waitingOnYou, { ...open, waitingOn: ['customer'] }),
          row('tickets.awaitingApproval', t.awaitingApproval, { ...open, waitingOn: ['customer'], statusIds: [t.awaitingApprovalStatusId!] }),
          row('tickets.resolvedInPeriod', t.resolvedInPeriod, { ...any, status: 'any', ...resolvedIn(d) }),
          row('tickets.openedInPeriod', t.openedInPeriod, { ...any, status: 'any', ...period(d) }),
          ...t.byType.flatMap((b) => [row(`byType[${b.type}]`, b.count, { ...open, type: b.type as TicketListLink['type'] }), row(`byType[${b.type}].breached`, b.breached, { ...open, type: b.type as TicketListLink['type'], sla: 'breached' })]),
          ...t.byPriority.filter((p) => p.id).flatMap((p) => [row(`byPriority[${p.label}]`, p.count, { ...open, priorityIds: [p.id!] }), row(`byPriority[${p.label}].breached`, p.breached, { ...open, priorityIds: [p.id!], sla: 'breached' })]),
          ...loadRows('bySite', t.bySite, open, (id) => ({ siteId: id })),
          ...loadRows('byService', t.byService, open, (id) => ({ serviceId: id })),
          ...flowRows('portal', d.series, any, { opened: 'created', resolved: 'resolved' }),
          // The by-type flow view: one stacked series per ticket type, each bar that day's tickets of that type (the four sum to the opened bars).
          ...(['incident', 'request', 'problem', 'change'] as const).flatMap((type) => flowRows(`portal.byType[${type}]`, d.series.map((s) => ({ day: s.day, [`${type}sOpened`]: s[`${type}sOpened`] })), { ...any, type }, { [`${type}sOpened`]: 'created' })),
          ...ageingRows('portal', d.ageing, open),
          ...d.byPriorityResponsiveness.filter((r) => r.id).flatMap((r) => [
            row(`byPriorityResponsiveness[${r.priority}].opened`, r.opened, { ...any, status: 'any', priorityIds: [r.id!], ...period(d) }),
            row(`byPriorityResponsiveness[${r.priority}].resolved`, r.resolved, { ...any, status: 'any', priorityIds: [r.id!], ...resolvedIn(d) }),
          ]),
          row('csat.pending.count', d.csat.pending.count, { ...any, statusCategories: ['resolved', 'closed'], csat: 'pending' }),
          // The SLA compliance donut and its per-priority rows: doors through the portal list (the outcome, the period, the site when scoped, the priority on a row).
          ...slaRows('sla', d.sla, any, d.period),
          ...d.sla.byPriority.filter((p) => p.id).flatMap((p) => [row(`sla.byPriority[${p.label}].met`, p.met, { ...any, priorityIds: [p.id!], ...ended('met', d.period) }), row(`sla.byPriority[${p.label}].breached`, p.breached, { ...any, priorityIds: [p.id!], ...ended('breached', d.period) })]),
        ];
        // A portal user is never fenced by domain: the security ticket A5 is theirs to see, as on the list. Site HQ holds A1 (breached), A2 and A6 (at risk) and the change C1.
        expect(t.open).toBe(siteId ? 4 : 9);
        // A7 met (no site), A1 (HQ) and A5 (no site) breached.
        expect([d.sla.met, d.sla.breached]).toEqual(siteId ? [0, 1] : [1, 2]);
        expect(d.sla.open).toEqual({ atRisk: t.atRisk, breached: t.breached });
        expect(d.sla.byPriority.map((p) => [p.key, p.met, p.breached])).toEqual(siteId ? [['p1', 0, 1]] : [['p1', 0, 2], ['p4', 1, 0]]);
        expect([t.breached, t.atRisk]).toEqual(siteId ? [1, 2] : [2, 2]);
        expect(t.waitingOnYou).toBe(siteId ? 0 : 2);
        expect(t.awaitingApproval).toBe(siteId ? 0 : 1);
        expect(d.csat.pending.count).toBe(siteId ? 0 : 1);
        expect(t.byPriority.filter((p) => p.id).map((p) => p.count)).toEqual(siteId ? [2, 2] : [3, 6]);
        // Largest first, then the type in its enum order (incident, request, problem, change).
        expect(t.byType.map((b) => [b.type, b.count])).toEqual(siteId ? [['incident', 3], ['change', 1]] : [['incident', 6], ['request', 2], ['change', 1]]);
        await reproducesInPortal(ctx, rows);
        // The fence row: the same number the list's own tiles show for this organisation (and site).
        const st = await ticketStats(ctx, siteId ? { siteId } : {});
        expect(st.open).toBe(t.open);
        expect(st.breached).toBe(t.breached);
        // The portal's "Waiting on you" tile, the home tile and the navigator badge are one number (and its door is the list chip).
        expect(st.awaitingCustomer).toBe(t.waitingOnYou);
        // The navigator badge is organisation-wide (no site scope).
        if (!siteId) expect((await me(ctx)).counts.awaiting).toBe(t.waitingOnYou);
        if (!siteId) expect(st.surveyPending).toBe(d.csat.pending.count);
        // Upcoming: one predicate per number, so each count is the length of the list it opens (visits and maintenance follow the site; changes and approvals are organisation-wide).
        const m = await portalMaintenance(ctx, { pastDays: 90, futureDays: 90 });
        const visits = m.upcoming.visits.filter((v) => !siteId || v.siteId === siteId);
        const occurrences = m.upcoming.occurrences.filter((o) => !siteId || o.siteId === siteId);
        expect(d.upcoming.counts.visits, 'upcoming.counts.visits').toBe(visits.length);
        expect(d.upcoming.counts.maintenance, 'upcoming.counts.maintenance').toBe(occurrences.length);
        expect(d.upcoming.visits.map((v) => v.id)).toEqual(visits.map((v) => v.id));
        expect(d.upcoming.maintenance.map((o) => o.id)).toEqual(occurrences.map((o) => o.id));
        expect(d.upcoming.counts.visits).toBe(siteId ? 1 : 2);
        expect(d.upcoming.counts.maintenance).toBe(siteId ? 2 : 3);
        // The occurrence with visit 1 booked for it is listed as that visit on both: neither the page's maintenance list nor the home's count holds it, the visit does.
        expect(d.upcoming.visits.map((v) => v.id)).toContain(ids.visit1);
        expect(m.upcoming.occurrences.map((o) => o.id)).not.toContain(ids.foldedOccurrence);
        expect(d.upcoming.maintenance.map((o) => o.id)).not.toContain(ids.foldedOccurrence);
        const [folded] = await ctx.tx.select({ status: schema.pmOccurrences.status, fieldVisitId: schema.pmOccurrences.fieldVisitId }).from(schema.pmOccurrences).where(eq(schema.pmOccurrences.id, ids.foldedOccurrence));
        expect(folded).toEqual({ status: 'scheduled', fieldVisitId: ids.visit1 });
        // Every series point sums its type shares to the opened count.
        expect(d.series.every((s) => s.incidentsOpened + s.requestsOpened + s.problemsOpened + s.changesOpened === s.opened)).toBe(true);
        const changes = await portalPlannedChanges(ctx, { state: 'upcoming' });
        expect(d.upcoming.counts.changes, 'upcoming.counts.changes').toBe(changes.counts.upcoming);
        expect(d.upcoming.counts.changes).toBe(1);
        expect(d.upcoming.changes!.map((c) => c.id)).toEqual(changes.items.map((c) => c.id));
        // A customer_user holds no portal:approve: the approvals count is absent rather than zero.
        expect(d.upcoming.counts.approvals).toBeNull();
        await expect(listPortalApprovals(ctx)).rejects.toThrow(/portal:approve/);
      });
    });

    it(`the approvals count is the approvals page's total for a customer administrator, organisation-wide (${scope.name})`, async () => {
      const siteId = typeof scope.siteId === 'function' ? scope.siteId() : null;
      await snapshot(portalAdminA, async (ctx) => {
        const d = await customer(ctx, { days: 7, siteId });
        const page = await listPortalApprovals(ctx);
        expect(d.upcoming.counts.approvals, 'upcoming.counts.approvals').toBe(page.total);
        expect(d.upcoming.approvals!.map((a) => a.id)).toEqual(page.items.map((a) => a.id));
        expect(d.upcoming.counts.approvals).toBe(2);
        expect(d.upcoming.approvals!.map((a) => a.ticket.title.slice(0, 5)).sort()).toEqual(['DC A4', 'DC A8']);
        // The same organisation reads the same tiles whoever of its users opens the home.
        const asUser = await customer(ctx, { days: 7, siteId });
        expect(asUser.tickets.open).toBe(siteId ? 4 : 9);
        expect(d.tickets.open).toBe(asUser.tickets.open);
      });
    });
  }

  it('a portal link carries only portal-safe keys, and both builders emit the same statusCategory for statusCategories', () => {
    const link: TicketListLink = { customerId: ids.b, domain: 'soc', assignee: 'me', teamId: 'x', isMajor: true, knownError: true, breachRisk: 'high', severityIds: ['y'], categoryId: 'z', status: 'open', statusIds: [ids.pendingCustomer], waitingOn: ['customer'], priorityIds: [ids.p1], siteId: ids.siteA, sla: 'breached', csat: 'pending', createdFrom: '2026-10-01', createdTo: '2026-10-07', resolvedFrom: '2026-10-01', resolvedTo: '2026-10-07', type: 'incident' };
    const keys = [...new URLSearchParams(portalTicketListQuery(link)).keys()];
    expect(keys).toEqual(['type', 'statusId', 'waitingOn', 'slaState', 'priorityId', 'siteId', 'csat', 'createdFrom', 'createdTo', 'resolvedFrom', 'resolvedTo']);
    // `waitingOn` is portal-safe for the customer alone: a supplier (or any other party) is the desk's business and never reaches a portal link, while the staff builder keeps the list.
    expect(portalTicketListQuery({ status: 'open', waitingOn: ['vendor'] })).toBe('');
    expect(portalTicketListQuery({ status: 'open', waitingOn: 'customer' })).toBe('waitingOn=customer');
    expect(ticketListQuery({ status: 'open', waitingOn: ['vendor', 'change'] })).toBe('waitingOn=vendor%2Cchange');
    expect(portalParamsForLink(portalTicketListPath({ waitingOn: 'customer' }))).toEqual({ statusCategory: 'new,open,pending', waitingOn: 'customer' });
    // The portal's legacy chip alias reads as the one key.
    expect(portalParamsForLink('/portal/tickets?status=awaiting')).toEqual({ statusCategory: 'new,open,pending', waitingOn: 'customer' });
    // The SLA outcome keys are portal-safe and come out after the resolved range in both builders.
    const door: TicketListLink = { customerId: ids.a, status: 'any', slaOutcome: 'met', slaEndedFrom: '2026-10-01', slaEndedTo: '2026-10-07' };
    expect(ticketListQuery(door)).toBe(`customerId=${ids.a}&statusCategory=any&slaOutcome=met&slaEndedFrom=2026-10-01&slaEndedTo=2026-10-07`);
    expect(portalTicketListQuery(door)).toBe('statusCategory=any&slaOutcome=met&slaEndedFrom=2026-10-01&slaEndedTo=2026-10-07');
    expect(portalParamsForLink(portalTicketListPath(door))).toEqual({ statusCategory: 'any', slaOutcome: 'met', slaEndedFrom: '2026-10-01', slaEndedTo: '2026-10-07' });
    expect(statsParamsForLink(ticketListPath(door))).toEqual({ customerId: ids.a, slaOutcome: 'met', slaEndedFrom: '2026-10-01', slaEndedTo: '2026-10-07' });
    expect(keys.every((k) => (PORTAL_TICKET_LINK_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(portalTicketListPath({ customerId: ids.b, domain: 'soc', assignee: 'me', status: 'open' })).toBe('/portal/tickets');
    expect(portalTicketListPath({ statusCategories: ['resolved', 'closed'], csat: 'pending' })).toBe('/portal/tickets?statusCategory=resolved%2Cclosed&csat=pending');
    const toRate: TicketListLink = { statusCategories: ['resolved', 'closed'], csat: 'pending' };
    expect(ticketListQuery(toRate)).toBe('statusCategory=resolved%2Cclosed&csat=pending');
    expect(portalTicketListQuery(toRate)).toBe(ticketListQuery(toRate));
    // statusCategories wins over status in both emitters.
    expect(ticketListQuery({ ...toRate, status: 'any' })).toBe(ticketListQuery(toRate));
    expect(portalTicketListQuery({ ...toRate, status: 'any' })).toBe(portalTicketListQuery(toRate));
    expect(ticketListQuery({ status: 'any' })).toBe('statusCategory=any');
    // The portal page carries "any" to the API (the portal API defaults to the open categories), the staff page drops it.
    expect(portalParamsForLink('/portal/tickets?statusCategory=any')).toEqual({ statusCategory: 'any' });
    expect(portalParamsForLink('/portal/tickets')).toEqual({ statusCategory: 'new,open,pending' });
    expect(statsParamsForLink('/tickets?statusCategory=any')).toEqual({});
    // The All pill is no condition; every ticket type the organisation sees is a pill (problems and changes included), so the All pill is the sum of the pills.
    expect(portalParamsForLink('/portal/tickets?type=all')).toEqual({ statusCategory: 'new,open,pending' });
    expect(portalParamsForLink('/portal/tickets?type=problem')).toEqual({ type: 'problem', statusCategory: 'new,open,pending' });
    expect(portalParamsForLink('/portal/tickets?type=change')).toEqual({ type: 'change', statusCategory: 'new,open,pending' });
    expect(portalParamsForLink('/portal/tickets?type=request')).toEqual({ type: 'request', statusCategory: 'new,open,pending' });
    expect(portalParamsForLink('/portal/tickets?type=task')).toEqual({ statusCategory: 'new,open,pending' });
    expect(portalTicketStatsQuery.parse(portalParamsForLink('/portal/tickets?type=all')).type).toBeUndefined();
    expect(portalTicketStatsQuery.parse(portalParamsForLink('/portal/tickets?type=change')).type).toBe('change');
    // `csat=pending` on its own is the To rate door: the page, the link parser and the portal API all read it with the rateable categories.
    expect(portalParamsForLink('/portal/tickets?csat=pending')).toEqual({ statusCategory: 'resolved,closed', csat: 'pending' });
    expect(portalParamsForLink('/portal/tickets?statusCategory=any&csat=pending')).toEqual({ statusCategory: 'any', csat: 'pending' });
  });
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
    // Customer A: A1 and A5 breached, A2 and A6 at risk, A3 (past due, not swept), A4, A8, A9 and the change C1 (no clocks) on track.
    const g = await as(admin, (ctx) => groupTickets(ctx, { customerId: ids.a, open: true }, 'slaState'));
    expect(g.groups).toEqual([{ label: 'Breached', count: 2 }, { label: 'At risk', count: 2 }, { label: 'On track', count: 5 }]);
    const a = await as(admin, (ctx) => amc(ctx, { days: 7, customerId: ids.a }));
    expect([a.kpis.breached, a.kpis.atRisk]).toEqual([0, 1]);
    const onTrackP4 = await as(admin, (ctx) => countTickets(ctx, { customerId: ids.a, open: true, slaState: 'ok', type: 'incident', priorityId: ids.p4 }));
    // A3 (running, past due, not yet swept) and A9 (awaiting an internal approval, its clock running) are on track.
    expect(onTrackP4, 'A3: running, past due, not yet swept → on track').toBe(2);
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

  it('one SLA compliance number: the Overview, management, the customer dashboard (staff and portal), the portal SLA page, the briefing, the attention row, the SLA route, the customer record and the customers overview all read the helper', async () => {
    // Customer A at 7 days, one snapshot: A7 met, A1 and A5 breached → 33.3 % for the administrator.
    await snapshot(admin, async (ctx) => {
      const o = await overview(ctx, { days: 7, customerId: ids.a });
      const desk = o.desk as { sla: SlaBlock };
      const w = { from: o.period.from, to: o.period.to };
      const helper = await resolutionCompliance(ctx, { ...w, fence: sql`AND t.customer_id = ${ids.a}::uuid ${socCond(ctx)}` });
      expect(helper).toEqual({ met: 1, breached: 2, compliancePct: 33.3 });
      const m = await management(ctx, { days: 7, customerId: ids.a });
      const c = await customer(ctx, { days: 7, customerId: ids.a });
      const attention = (await attentionByCustomer(ctx, { ...w, customerId: ids.a })).find((r) => r.id === ids.a)!;
      const route = await complianceOverview(ctx, { customerId: ids.a, from: w.from, to: w.to });
      const figures = (x: { met: number; breached: number; compliancePct: number | null }) => [x.met, x.breached, x.compliancePct];
      expect(figures(desk.sla), 'overview desk.sla').toEqual(figures(helper));
      expect([m.kpis.resolutionMet, m.kpis.resolutionBreached, m.kpis.slaCompliancePct], 'management kpis').toEqual(figures(helper));
      expect(figures(m.sla), 'management sla').toEqual(figures(helper));
      expect(figures(c.sla), 'customer() as staff').toEqual(figures(helper));
      expect([attention.slaMet, attention.slaBreached, attention.compliancePct], 'attentionByCustomer row').toEqual(figures(helper));
      expect(figures(route.resolution), 'GET /sla/compliance resolution').toEqual(figures(helper));
      expect(route.period).toEqual({ days: 7, ...w });
      // The service manager briefing's headline carries the same three figures over the last 7 whole days, unscoped: compare with the unscoped helper.
      const all = await resolutionCompliance(ctx, { ...w, fence: socCond(ctx) });
      const b = await briefingDefinition('service_manager')!.build(ctx, { day: w.to, timezone: 'UTC', now: new Date() });
      const headline = b.headline[0]!;
      expect(headline).toMatch(/^Resolution SLA compliance over the last 7 days is /);
      expect(headline).toContain(`${all.compliancePct === null ? 'not measurable yet' : `${all.compliancePct}%`} (${all.met} met, ${all.breached} breached, clocks that ended in the period)`);
      // Unscoped: the route without a customer is the Overview's unscoped block.
      const unscoped = await overview(ctx, { days: 7 });
      const unscopedRoute = await complianceOverview(ctx, { from: w.from, to: w.to });
      expect(figures((unscoped.desk as { sla: SlaBlock }).sla)).toEqual(figures(unscopedRoute.resolution));
      expect(figures(all)).toEqual(figures(unscopedRoute.resolution));
    });
    // The same number through the portal principal: the home, the SLA page and the route, with and without the site scope.
    await snapshot(portalA, async (ctx) => {
      const c = await customer(ctx, { days: 7 });
      const page = await portalSla(ctx, { days: 7 });
      const route = await complianceOverview(ctx, { from: c.period.from, to: c.period.to });
      expect([c.sla.met, c.sla.breached, c.sla.compliancePct]).toEqual([1, 2, 33.3]);
      expect([page.resolution.met, page.resolution.breached, page.resolution.compliancePct]).toEqual([1, 2, 33.3]);
      expect(page.period).toEqual(c.period.days === 7 ? { days: 7, from: c.period.from, to: c.period.to } : page.period);
      expect([route.resolution.met, route.resolution.breached, route.resolution.compliancePct]).toEqual([1, 2, 33.3]);
      expect(route.customerId).toBe(ids.a);
      // The policy tables of the SLA page (clocks started, every metric) stay beside the figure.
      expect(Array.isArray(page.byMetric) && Array.isArray(page.byPriority)).toBe(true);
    });
    // The NOC manager (no soc:read) reads the fenced number everywhere: 50 %.
    await snapshot(nocManager, async (ctx) => {
      const o = await overview(ctx, { days: 7, customerId: ids.a });
      const m = await management(ctx, { days: 7, customerId: ids.a });
      const c = await customer(ctx, { days: 7, customerId: ids.a });
      for (const x of [(o.desk as { sla: SlaBlock }).sla, m.sla, c.sla]) expect([x.met, x.breached, x.compliancePct]).toEqual([1, 1, 50]);
    });
  });

  it('at 30 days the customer record, the customers overview and the attention door read the same helper figure, and their doors reproduce', async () => {
    await snapshot(admin, async (ctx) => {
      const record = await customerOverview(ctx, ids.a);
      const w = record.sla30d.period;
      expect(w.days).toBe(30);
      const helper = await resolutionCompliance(ctx, { from: w.from, to: w.to, fence: sql`AND t.customer_id = ${ids.a}::uuid ${socCond(ctx)}` });
      expect([record.sla30d.met, record.sla30d.breached, record.sla30d.compliancePct]).toEqual([helper.met, helper.breached, helper.compliancePct]);
      expect(helper).toEqual({ met: 1, breached: 2, compliancePct: 33.3 });
      const o = await customersOverview(ctx);
      expect(o.slaWindow).toEqual(w);
      const rowA = o.slaByCustomer.find((r) => r.id === ids.a)!;
      expect([rowA.met, rowA.breached, rowA.compliancePct]).toEqual([helper.met, helper.breached, helper.compliancePct]);
      const attentionA = o.attention.find((r) => r.id === ids.a);
      if (attentionA) expect(attentionA.slaCompliance30d).toBe(helper.compliancePct);
      const c = await customer(ctx, { days: 30, customerId: ids.a });
      expect([c.sla.met, c.sla.breached, c.sla.compliancePct]).toEqual([helper.met, helper.breached, helper.compliancePct]);
      const route = await complianceOverview(ctx, { customerId: ids.a });
      expect(route.period).toEqual(w);
      expect([route.resolution.met, route.resolution.breached, route.resolution.compliancePct]).toEqual([helper.met, helper.breached, helper.compliancePct]);
      // The doors: the record's met and breached (the attention item's "N SLA breaches in the last 30 days"), the customers overview panel's breached clocks and each row.
      await reproducesIn(ctx, [
        row('customerOverview.sla30d.met', record.sla30d.met, { customerId: ids.a, ...ended('met', w) }),
        row('customerOverview.sla30d.breached', record.sla30d.breached, { customerId: ids.a, ...ended('breached', w) }),
        row('customersOverview.slaByCustomer[A].breached', rowA.breached, { customerId: ids.a, ...ended('breached', o.slaWindow) }),
        row('customersOverview.slaByCustomer[A].met', rowA.met, { customerId: ids.a, ...ended('met', o.slaWindow) }),
        row('customersOverview panel door (every customer, breached clocks)', o.slaByCustomer.reduce((n, r) => n + r.breached, 0), { ...ended('breached', o.slaWindow) }),
      ]);
    });
  });
});

describe('briefing doors reproduce on the list', () => {
  /** The number the list shows for a door's own href: parsed as the page does, validated as the route does, counted with the list's predicates. */
  const staffCount = (ctx: Ctx, href: string) => countTickets(ctx, statsQuerySchema.parse(statsParamsForLink(href)));
  const portalCount = (ctx: Ctx, href: string) => countPortalTickets(ctx, portalTicketStatsQuery.parse(portalParamsForLink(href)));
  interface Door { where: string; label: string; value: number | string; href: string | null }
  /** Every KPI, section door and per-row door of a built briefing, with where it sits. */
  const doorsOf = (built: Awaited<ReturnType<BriefingDefinition['build']>>): Door[] => [
    ...built.kpis.map((k: BriefingKpi) => ({ where: `kpi ${k.key}`, label: k.label, value: k.value, href: k.href })),
    ...built.sections.flatMap((s) => [
      ...s.doors.map((d: BriefingDoor) => ({ where: `section ${s.key}`, label: d.label, value: d.value, href: d.href })),
      ...s.items.flatMap((i) => (i.doors ?? []).map((d) => ({ where: `section ${s.key} row ${i.ref}`, label: d.label, value: d.value, href: d.href }))),
    ]),
  ];
  async function holds(p: Principal, role: string, count: (ctx: Ctx, href: string) => Promise<number>, expectPortal: boolean) {
    await snapshot(p, async (ctx) => {
      const def = briefingDefinition(role)!;
      expect(def.allowed(ctx), `${role} allowed`).toBe(true);
      const built = await def.build(ctx, { day: toDay(new Date()), timezone: 'UTC', now: new Date() });
      const doors = doorsOf(built);
      const linked = doors.filter((d) => d.href);
      expect(linked.length, `${role} has doors`).toBeGreaterThan(0);
      for (const d of linked) {
        if (expectPortal) expect(d.href, `${d.where} ${d.label}`).toMatch(/^\/portal\/tickets/);
        else expect(d.href, `${d.where} ${d.label}`).toMatch(/^\/tickets/);
        expect(typeof d.value, `${d.where} ${d.label} is a number`).toBe('number');
        expect(await count(ctx, d.href!), `${role}: ${d.where} ${d.label} = ${d.value} → ${d.href}`).toBe(d.value);
      }
      return built;
    });
  }
  it('as the admin (service manager and account manager)', async () => {
    await holds(admin, 'service_manager', staffCount, false);
    await holds(admin, 'account_manager', staffCount, false);
  });
  it('as an engineer without soc:read (noah)', async () => {
    await holds(noah, 'engineer', staffCount, false);
  });
  it('as the NOC manager (team doors, no domain key)', async () => {
    await snapshot(nocManager, async (ctx) => {
      const built = await briefingDefinition('noc_manager')!.build(ctx, { day: toDay(new Date()), timezone: 'UTC', now: new Date() });
      const team = built.sections.find((s) => s.key === `team:${ids.team}`);
      expect(team, 'the fixture team has a section').toBeTruthy();
      for (const d of team!.doors) expect(d.href).toContain(`teamId=${ids.team}`);
      for (const d of doorsOf(built)) if (d.href) expect(d.href).not.toContain('domain=');
    });
    await holds(nocManager, 'noc_manager', staffCount, false);
  });
  it('as a customer user and a customer administrator of A (the approval door only for the administrator)', async () => {
    await holds(portalA, 'customer', portalCount, true);
    await holds(portalAdminA, 'customer', portalCount, true);
    await snapshot(portalA, async (ctx) => {
      const built = await briefingDefinition('customer')!.build(ctx, { day: toDay(new Date()), timezone: 'UTC', now: new Date() });
      expect(doorsOf(built).some((d) => d.label === 'Awaiting your approval')).toBe(false);
    });
    await snapshot(portalAdminA, async (ctx) => {
      const built = await briefingDefinition('customer')!.build(ctx, { day: toDay(new Date()), timezone: 'UTC', now: new Date() });
      const approval = doorsOf(built).find((d) => d.label === 'Awaiting your approval');
      expect(approval?.href).toContain(`statusId=${ids.awaitingApproval}`);
      expect(approval?.href).toContain('waitingOn=customer');
      expect(approval?.value).toBe(1);
      // "Waiting on you" is the one word (and the one key) for what waits on the organisation: a reply or an approval.
      const waiting = doorsOf(built).find((d) => d.label === 'Waiting on you');
      expect(waiting?.href).toBe('/portal/tickets?waitingOn=customer');
      expect(waiting?.value).toBe(2);
      expect(doorsOf(built).some((d) => d.label === 'Awaiting your reply')).toBe(false);
    });
  });
});
