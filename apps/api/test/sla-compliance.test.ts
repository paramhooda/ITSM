/**
 * SLA compliance as one number (DB-backed): the helper every dashboard,
 * record page, briefing and assistant fact reads (`modules/sla/compliance.ts`),
 * the list doors its segments open (`slaOutcome` with `slaEndedFrom/To`) and
 * the pinned `GET /sla/compliance` overview. Run with the dev environment sourced:
 *   npx vitest run test/sla-compliance.test.ts
 *
 * Customer C owns resolution clocks that ended inside and outside a seven-day
 * window, on open and on resolved tickets, a reopened ticket (its clock was
 * cleared), a security ticket behind an engineer's fence and clocks on both
 * edges of the window; customer D owns one breached clock and customer E
 * nothing that ended.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { ForbiddenError, ValidationError } from '@/core/errors';
import { createTicket, resolveTicket, reopenTicket } from '@/modules/tickets/service';
import { countTickets, ticketStats } from '@/modules/tickets/list';
import { statsQuerySchema } from '@/modules/tickets/schemas';
import { resolutionCompliance, resolutionComplianceByCustomer, resolutionComplianceByPriority } from '@/modules/sla/compliance';
import { complianceOverview } from '@/modules/sla/policies';
import { custCond, socCond } from '@/modules/dashboards/common';
import { toDay, addDays } from '@/modules/reports/dates';
import { SLA_COMPLIANCE_TARGET, SLA_COMPLIANCE_WARNING, complianceTone, ticketListPath } from '@itsm/shared';
import { statsParamsForLink } from '../../web/src/components/tickets/listQuery';

const S = Math.random().toString(36).slice(2, 8);
const ids = { adminId: '', noah: '', portalC: '', c: '', d: '', e: '', nocSvc: '', socSvc: '', p1: '', p4: '' };
const t: Record<string, string> = {};
let admin: Principal;
let noah: Principal;
let portalC: Principal;
const created: string[] = [];
const meta = { requestId: `sla-compliance-${S}` };
const as = <T>(p: Principal, fn: (ctx: Ctx) => Promise<T>) => runAs(p, meta, fn);

const today = toDay(new Date());
/** The seven-day window under test and the one before it. */
const win = { from: addDays(today, -6), to: today };
const prev = { from: addDays(today, -13), to: addDays(today, -7) };
const at = (day: string, time = '12:00:00.000') => new Date(`${day}T${time}Z`);

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
/** Sets the resolution clock of a ticket directly on the engine's row (state and the end timestamps). */
const setClock = (tx: Tx, ticketId: string, patch: { state: 'met' | 'breached' | 'running'; completedAt?: Date | null; breachedAt?: Date | null }) =>
  tx.execute(sql`UPDATE ticket_slas SET state = ${patch.state}::sla_state, completed_at = ${patch.completedAt ?? null}, breached_at = ${patch.breachedAt ?? null} WHERE ticket_id = ${ticketId}::uuid AND metric = 'resolution'`);

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    if (!adminUser) throw new Error('admin user missing (seed not applied?)');
    ids.adminId = adminUser.id;
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p4 = await optionId(tx, 'ticket_priority', 'p4');
    const [c] = await tx.insert(schema.customers).values({ code: `SCC${S.toUpperCase()}`, name: `Compliance Customer C ${S}` }).returning();
    const [d] = await tx.insert(schema.customers).values({ code: `SCD${S.toUpperCase()}`, name: `Compliance Customer D ${S}` }).returning();
    const [e] = await tx.insert(schema.customers).values({ code: `SCE${S.toUpperCase()}`, name: `Compliance Customer E ${S}` }).returning();
    ids.c = c!.id;
    ids.d = d!.id;
    ids.e = e!.id;
    const [nocSvc] = await tx.insert(schema.services).values({ key: `sc_noc_${S}`, name: `Compliance NOC ${S}`, domain: 'noc' }).returning();
    const [socSvc] = await tx.insert(schema.services).values({ key: `sc_soc_${S}`, name: `Compliance SOC ${S}`, domain: 'soc' }).returning();
    ids.nocSvc = nocSvc!.id;
    ids.socSvc = socSvc!.id;
    const [u] = await tx.insert(schema.users).values({ email: `sc-noah-${S}@example.test`, name: 'Noah Compliance', userType: 'msp', status: 'active' }).returning();
    ids.noah = u!.id;
    await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: await roleId(tx, 'noc_engineer'), customerId: null });
    const [pu] = await tx.insert(schema.users).values({ email: `sc-portal-${S}@example.test`, name: 'Pat Compliance', userType: 'customer', customerId: c!.id, status: 'active' }).returning();
    ids.portalC = pu!.id;
    await tx.insert(schema.userRoles).values({ userId: pu!.id, roleId: await roleId(tx, 'customer_user'), customerId: c!.id });
  });
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminId))!;
  noah = (await loadPrincipal(ids.noah))!;
  portalC = (await loadPrincipal(ids.portalC))!;
  expect(noah.globalPermissions.has('soc:read')).toBe(false);
  expect(portalC.userType).toBe('customer');

  await as(admin, async (ctx) => {
    const mk = async (key: string, input: Parameters<typeof createTicket>[1]) => {
      const r = await createTicket(ctx, input);
      t[key] = r.id;
      created.push(r.id);
      return r;
    };
    await mk('metIn', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC met inside ${S}`, priorityId: ids.p1 });
    await mk('metOut', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC met outside ${S}`, priorityId: ids.p1 });
    await mk('metPrev', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC met previous window ${S}`, priorityId: ids.p4 });
    await mk('breachedOpen', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC breached open ${S}`, priorityId: ids.p1 });
    await mk('breachedResolved', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC breached resolved late ${S}`, priorityId: ids.p4 });
    await mk('reopened', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC reopened ${S}`, priorityId: ids.p4 });
    const sec = await mk('security', { type: 'incident', customerId: ids.c, serviceId: ids.socSvc, title: `SC security met ${S}`, priorityId: ids.p1 });
    expect(sec.domain).toBe('soc');
    await mk('edgeStart', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC edge first instant ${S}`, priorityId: ids.p4 });
    await mk('edgeBefore', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC edge just before ${S}`, priorityId: ids.p4 });
    await mk('edgeEnd', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC edge last instant ${S}`, priorityId: ids.p4 });
    await mk('edgeAfter', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC edge just after ${S}`, priorityId: ids.p4 });
    await mk('running', { type: 'incident', customerId: ids.c, serviceId: ids.nocSvc, title: `SC still running ${S}`, priorityId: ids.p4 });
    await mk('dBreached', { type: 'incident', customerId: ids.d, serviceId: ids.nocSvc, title: `SC D breached ${S}`, priorityId: ids.p1 });
    await mk('eRunning', { type: 'incident', customerId: ids.e, serviceId: ids.nocSvc, title: `SC E running ${S}`, priorityId: ids.p1 });
    // Resolved through the engine: the clocks close as met today (inside the window) ...
    for (const key of ['metIn', 'metOut', 'metPrev', 'breachedResolved', 'reopened', 'security', 'edgeStart', 'edgeBefore', 'edgeEnd', 'edgeAfter']) await resolveTicket(ctx, t[key]!, { resolutionNotes: 'Resolved during the compliance test' });
    // ... and a reopened ticket's clock is cleared and restarted by the engine, so it counts nowhere.
    await reopenTicket(ctx, t.reopened!, { comment: 'Not fixed after all' });
  });
  await withSystem(async (tx) => {
    await setClock(tx, t.metOut!, { state: 'met', completedAt: at(addDays(today, -40)) });
    await setClock(tx, t.metPrev!, { state: 'met', completedAt: at(addDays(today, -10)) });
    // Breached on an open ticket: flagged by the sweep inside the window, no completion.
    await setClock(tx, t.breachedOpen!, { state: 'breached', completedAt: null, breachedAt: at(addDays(today, -2)) });
    // Breached on a resolved ticket: flagged by the sweep, then closed late (both inside the window).
    await setClock(tx, t.breachedResolved!, { state: 'breached', completedAt: at(addDays(today, -1)), breachedAt: at(addDays(today, -3)) });
    // The whole-day cut: the first instant of the window's first day and the last of its last day count; a millisecond outside either does not.
    await setClock(tx, t.edgeStart!, { state: 'met', completedAt: at(win.from, '00:00:00.000') });
    await setClock(tx, t.edgeBefore!, { state: 'met', completedAt: at(addDays(win.from, -1), '23:59:59.999') });
    await setClock(tx, t.edgeEnd!, { state: 'met', completedAt: at(win.to, '23:59:59.999') });
    await setClock(tx, t.edgeAfter!, { state: 'met', completedAt: at(addDays(win.to, 1), '00:00:00.000') });
    await setClock(tx, t.dBreached!, { state: 'breached', completedAt: null, breachedAt: at(addDays(today, -1)) });
    const [reopened] = await tx.select({ state: schema.ticketSlas.state, completedAt: schema.ticketSlas.completedAt, breachedAt: schema.ticketSlas.breachedAt }).from(schema.ticketSlas).where(and(eq(schema.ticketSlas.ticketId, t.reopened!), eq(schema.ticketSlas.metric, 'resolution')));
    expect(reopened).toMatchObject({ state: 'running', completedAt: null, breachedAt: null });
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (created.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, created));
    for (const id of [ids.noah, ids.portalC]) if (id) await tx.delete(schema.users).where(eq(schema.users.id, id));
    const customers = [ids.c, ids.d, ids.e].filter(Boolean);
    if (customers.length) await tx.delete(schema.customers).where(inArray(schema.customers.id, customers));
    const services = [ids.nocSvc, ids.socSvc].filter(Boolean);
    if (services.length) await tx.delete(schema.services).where(inArray(schema.services.id, services));
  });
  await closeDb();
});

const fenceC = (ctx: Ctx) => sql`${custCond(ids.c)} ${socCond(ctx)}`;

describe('resolution compliance: clocks that ended in the period', () => {
  it('counts met by completed_at and breached by breached_at inside whole UTC days, open or resolved, never a reopened or a running clock', async () => {
    const r = await as(admin, (ctx) => resolutionCompliance(ctx, { ...win, fence: fenceC(ctx), previous: prev }));
    // Met: inside, the security ticket, the two edge clocks inside the window. Breached: the open one and the late one.
    // The previous window holds the clock from ten days ago and the edge clock that closed the millisecond before this window.
    expect(r).toEqual({ met: 4, breached: 2, compliancePct: 66.7, previous: { met: 2, breached: 0, compliancePct: 100 } });
    // Without a previous window the key is absent.
    const bare = await as(admin, (ctx) => resolutionCompliance(ctx, { ...win, fence: fenceC(ctx) }));
    expect(bare).toEqual({ met: 4, breached: 2, compliancePct: 66.7 });
    // A wider window takes the clock from forty days ago, the previous window's two as well; tomorrow's edge stays out.
    const wide = await as(admin, (ctx) => resolutionCompliance(ctx, { from: addDays(today, -60), to: today, fence: fenceC(ctx) }));
    expect(wide).toEqual({ met: 7, breached: 2, compliancePct: 77.8 });
    // The window's bounds are inclusive whole days: a millisecond before the first day or after the last day is outside.
    const before = await as(admin, (ctx) => resolutionCompliance(ctx, { from: addDays(win.from, -1), to: addDays(win.from, -1), fence: fenceC(ctx) }));
    expect(before).toEqual({ met: 1, breached: 0, compliancePct: 100 });
    const after = await as(admin, (ctx) => resolutionCompliance(ctx, { from: addDays(win.to, 1), to: addDays(win.to, 1), fence: fenceC(ctx) }));
    expect(after).toEqual({ met: 1, breached: 0, compliancePct: 100 });
  });

  it('is null when nothing ended, and the security fence hides a clock on a security ticket', async () => {
    const e = await as(admin, (ctx) => resolutionCompliance(ctx, { ...win, fence: sql`${custCond(ids.e)} ${socCond(ctx)}` }));
    expect(e).toEqual({ met: 0, breached: 0, compliancePct: null });
    expect(complianceTone(e.compliancePct)).toBeNull();
    // Noah (no soc:read): the security ticket's met clock is behind his fence, so one fewer met.
    const n = await as(noah, (ctx) => resolutionCompliance(ctx, { ...win, fence: fenceC(ctx) }));
    expect(n).toEqual({ met: 3, breached: 2, compliancePct: 60 });
    // A portal principal of C reads C whatever fence is passed (row-level security pins the clocks), never D's.
    const p = await as(portalC, (ctx) => resolutionCompliance(ctx, { ...win, fence: sql`` }));
    expect(p).toEqual({ met: 4, breached: 2, compliancePct: 66.7 });
    const pD = await as(portalC, (ctx) => resolutionCompliance(ctx, { ...win, fence: custCond(ids.d) }));
    expect(pD).toEqual({ met: 0, breached: 0, compliancePct: null });
  });

  it('by customer and by priority split the same clocks', async () => {
    const byCustomer = await as(admin, (ctx) => resolutionComplianceByCustomer(ctx, { ...win, fence: sql`AND t.customer_id = ANY(ARRAY[${ids.c}::uuid, ${ids.d}::uuid, ${ids.e}::uuid]) ${socCond(ctx)}` }));
    expect(byCustomer.get(ids.c)).toEqual({ met: 4, breached: 2, compliancePct: 66.7 });
    expect(byCustomer.get(ids.d)).toEqual({ met: 0, breached: 1, compliancePct: 0 });
    expect(byCustomer.has(ids.e)).toBe(false);
    const byPriority = await as(admin, (ctx) => resolutionComplianceByPriority(ctx, { ...win, fence: fenceC(ctx) }));
    expect(byPriority.map((r) => [r.key, r.level, r.met, r.breached, r.compliancePct])).toEqual([['p1', 1, 2, 1, 66.7], ['p4', 4, 2, 1, 66.7]]);
    expect(byPriority.every((r) => typeof r.id === 'string' && typeof r.label === 'string')).toBe(true);
    const total = byPriority.reduce((n, r) => n + r.met + r.breached, 0);
    expect(total).toBe(6);
  });

  it('the thresholds and the tone are the shared pair', () => {
    expect(SLA_COMPLIANCE_TARGET).toBe(95);
    expect(SLA_COMPLIANCE_WARNING).toBe(90);
    expect(complianceTone(100)).toBe('good');
    expect(complianceTone(95)).toBe('good');
    expect(complianceTone(94.9)).toBe('warning');
    expect(complianceTone(90)).toBe('warning');
    expect(complianceTone(89.9)).toBe('critical');
    expect(complianceTone(0)).toBe('critical');
    expect(complianceTone(null)).toBeNull();
    expect(complianceTone(undefined)).toBeNull();
  });
});

describe('the met and breached segments are doors', () => {
  const listCount = (p: Principal, href: string) => as(p, (ctx) => countTickets(ctx, statsQuerySchema.parse(statsParamsForLink(href))));

  it('slaOutcome with slaEndedFrom/To reproduces the helper exactly through the link builder, the page parser, the route schema and the list predicates', async () => {
    const r = await as(admin, (ctx) => resolutionCompliance(ctx, { ...win, fence: fenceC(ctx) }));
    const met = ticketListPath({ customerId: ids.c, status: 'any', slaOutcome: 'met', slaEndedFrom: win.from, slaEndedTo: win.to });
    const breached = ticketListPath({ customerId: ids.c, status: 'any', slaOutcome: 'breached', slaEndedFrom: win.from, slaEndedTo: win.to });
    expect(met).toBe(`/tickets?customerId=${ids.c}&statusCategory=any&slaOutcome=met&slaEndedFrom=${win.from}&slaEndedTo=${win.to}`);
    expect(await listCount(admin, met)).toBe(r.met);
    expect(await listCount(admin, breached)).toBe(r.breached);
    // The same doors through Noah's eyes count what his dashboard shows.
    const n = await as(noah, (ctx) => resolutionCompliance(ctx, { ...win, fence: fenceC(ctx) }));
    expect(await listCount(noah, met)).toBe(n.met);
    expect(await listCount(noah, breached)).toBe(n.breached);
    // The open status default would hide the resolved tickets: a door always carries `status: 'any'`.
    expect(await listCount(admin, ticketListPath({ customerId: ids.c, slaOutcome: 'met', slaEndedFrom: win.from, slaEndedTo: win.to }))).toBe(0);
    // The outcome alone (no window) is every ticket whose resolution clock ever ended that way; a window on one bound is honoured
    // (direct API calls carry no status key: `any` is the page's token, which the parser drops).
    expect(await as(admin, (ctx) => countTickets(ctx, { customerId: ids.c, slaOutcome: 'met' }))).toBe(8);
    expect(await as(admin, (ctx) => countTickets(ctx, { customerId: ids.c, slaOutcome: 'met', slaEndedTo: addDays(today, -30) }))).toBe(1);
    expect(await as(admin, (ctx) => countTickets(ctx, { customerId: ids.c, slaOutcome: 'breached' }))).toBe(2);
  });

  it('the window without an outcome is refused by buildWhere on the list and the stats alike, and the outcome is base scope on the stats', async () => {
    await expect(as(admin, (ctx) => countTickets(ctx, { customerId: ids.c, slaEndedFrom: win.from }))).rejects.toBeInstanceOf(ValidationError);
    await expect(as(admin, (ctx) => countTickets(ctx, { customerId: ids.c, slaEndedTo: win.to }))).rejects.toBeInstanceOf(ValidationError);
    await expect(as(admin, (ctx) => ticketStats(ctx, { customerId: ids.c, slaEndedFrom: win.from, slaEndedTo: win.to }))).rejects.toBeInstanceOf(ValidationError);
    const s = await as(admin, (ctx) => ticketStats(ctx, { customerId: ids.c, slaOutcome: 'breached', slaEndedFrom: win.from, slaEndedTo: win.to }));
    expect(s.total).toBe(2);
    // Base scope: the tiles follow the outcome (one of the two breached-clock tickets is still open and flagged).
    expect(s.open).toBe(1);
    expect(s.breached).toBe(1);
  });
});

describe('GET /sla/compliance overview', () => {
  it('adds the dashboards\' resolution figure over whole days and pins the customer', async () => {
    const o = await as(admin, (ctx) => complianceOverview(ctx, { customerId: ids.c, from: win.from, to: win.to }));
    expect(o.customerId).toBe(ids.c);
    expect(o.period).toEqual({ days: 7, ...win });
    expect(o.resolution).toEqual({ met: 4, breached: 2, compliancePct: 66.7 });
    // The policy figures stay (clocks started in the period, every metric).
    expect(o.groupBy).toBe('metric');
    expect(typeof o.totals.met).toBe('number');
    // Default window: the last 30 whole days (the clock from forty days ago and tomorrow's edge stay out; the previous window's and the day-before edge come in).
    const d = await as(admin, (ctx) => complianceOverview(ctx, { customerId: ids.c }));
    expect(d.period).toEqual({ days: 30, from: addDays(today, -29), to: today });
    expect(d.resolution).toEqual({ met: 6, breached: 2, compliancePct: 75 });
    // A portal principal reads their own organisation whatever they name; a foreign id is refused.
    const p = await as(portalC, (ctx) => complianceOverview(ctx, { from: win.from, to: win.to }));
    expect(p.customerId).toBe(ids.c);
    expect(p.resolution).toEqual({ met: 4, breached: 2, compliancePct: 66.7 });
    await expect(as(portalC, (ctx) => complianceOverview(ctx, { customerId: ids.d, from: win.from, to: win.to }))).rejects.toBeInstanceOf(ForbiddenError);
    // Staff without soc:read read the fenced figure; a reversed window is refused.
    const n = await as(noah, (ctx) => complianceOverview(ctx, { customerId: ids.c, from: win.from, to: win.to }));
    expect(n.resolution).toEqual({ met: 3, breached: 2, compliancePct: 60 });
    await expect(as(admin, (ctx) => complianceOverview(ctx, { customerId: ids.c, from: win.to, to: win.from }))).rejects.toBeInstanceOf(ValidationError);
  });
});
