/**
 * On-call and paging: rota arithmetic (handoffs, overrides, shift windows,
 * timezones), the schedule, who is on call, the on-call notification flag,
 * escalation rules that page, step timeouts and expiry, acknowledgement from
 * the message link (with assignment), cancellation on resolution, the public
 * acknowledgement page and the dashboard line. Run with the dev environment
 * sourced: npx vitest run test/oncall.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { buildApp } from '../src/core/app';
import { hashPassword } from '../src/lib/crypto';
import { createTicket, resolveTicket } from '../src/modules/tickets/service';
import { applyEscalationRules } from '../src/modules/tickets/escalation';
import { notifyTicketEvent } from '../src/modules/tickets/notify';
import { systemCtx, reloadTicket } from '../src/modules/tickets/common';
import { timeline } from '../src/modules/tickets/activity';
import { handoffAt, cycleAt, resolveOnCall, expandSchedule, inShiftWindow, type RotaDef, type Participant } from '../src/modules/oncall/schedule';
import { createRota, createPolicy, deletePolicy, setTeamPolicy, onCallNow, whoIsOnCall, schedule, createOverride, deleteOverride } from '../src/modules/oncall/service';
import { pageTicket, processTimeout, sweepTimeouts, acknowledgeByToken, pageByToken, listPages } from '../src/modules/oncall/paging';
import { noc } from '../src/modules/dashboards/service';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-oncall-${S}`, ip: '127.0.0.1' };
let admin: Principal;
let alice: Principal;
const ids = { customer: '', site: '', p1: '', team: '', manager: '', alice: '', bob: '', portal: '', ticket: '', ticket2: '', rota: '', policy: '', rule: '' };
const created: string[] = [];
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asAlice = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(alice, meta, fn);

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}
async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing`);
  return row.id;
}
const outboxFor = (event: string, ticketId: string) => withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, event), eq(schema.notificationOutbox.entityId, ticketId))).orderBy(desc(schema.notificationOutbox.createdAt)));
const inAppFor = (event: string, userId: string) => withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.event, event), eq(schema.notifications.userId, userId))).orderBy(desc(schema.notifications.createdAt)));
const backdate = (pageId: string) => withSystem((tx) => tx.update(schema.pages).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.pages.id, pageId)));
const tokenFrom = (body: string | null | undefined) => body?.match(/\/api\/oncall\/ack\/([A-Za-z0-9_-]+)/)?.[1] ?? null;

// ------------------------------------------------------------------ pure arithmetic

const WEEKLY: RotaDef = { id: 'r', timezone: 'Asia/Kolkata', rotation: 'weekly', rotationDays: 7, handoffTime: '09:00', shiftStart: null, shiftEnd: null, startDate: '2026-09-28' };
const PEOPLE: Participant[] = [{ userId: 'A', position: 0 }, { userId: 'B', position: 1 }, { userId: 'C', position: 2 }];
const at = (iso: string) => new Date(iso);

describe('rota arithmetic', () => {
  it('hands over on the start date at the handoff time, in the rota timezone', () => {
    expect(handoffAt(WEEKLY, 0).toUTC().toISO()).toBe('2026-09-28T03:30:00.000Z');
    expect(cycleAt(WEEKLY, at('2026-09-28T03:29:59Z'))).toBe(-1);
    expect(cycleAt(WEEKLY, at('2026-09-28T03:30:00Z'))).toBe(0);
    const first = resolveOnCall(WEEKLY, PEOPLE, [], at('2026-09-28T03:30:00Z'));
    expect(first.userId).toBe('A');
    expect(first.until?.toISOString()).toBe('2026-10-05T03:30:00.000Z');
  });
  it('rotates across the week boundary and wraps around the list', () => {
    expect(resolveOnCall(WEEKLY, PEOPLE, [], at('2026-10-05T03:29:59Z')).userId).toBe('A');
    expect(resolveOnCall(WEEKLY, PEOPLE, [], at('2026-10-05T03:30:00Z')).userId).toBe('B');
    expect(resolveOnCall(WEEKLY, PEOPLE, [], at('2026-10-12T04:00:00Z')).userId).toBe('C');
    expect(resolveOnCall(WEEKLY, PEOPLE, [], at('2026-10-19T04:00:00Z')).userId).toBe('A');
    expect(resolveOnCall(WEEKLY, PEOPLE, [], at('2026-09-27T04:00:00Z')).userId).toBe('C');
    expect(resolveOnCall(WEEKLY, [], [], at('2026-09-29T04:00:00Z')).userId).toBeNull();
  });
  it('an override wins over the rotation for its period', () => {
    const o = { id: 'o1', userId: 'C', startsAt: at('2026-10-06T00:00:00Z'), endsAt: at('2026-10-07T00:00:00Z'), reason: 'swap' };
    const r = resolveOnCall(WEEKLY, PEOPLE, [o], at('2026-10-06T12:00:00Z'));
    expect(r.userId).toBe('C');
    expect(r.override?.id).toBe('o1');
    expect(r.until?.toISOString()).toBe('2026-10-07T00:00:00.000Z');
    expect(resolveOnCall(WEEKLY, PEOPLE, [o], at('2026-10-07T00:00:00Z')).userId).toBe('B');
  });
  it('a daily window (overnight) leaves nobody on call outside it', () => {
    const night: RotaDef = { ...WEEKLY, shiftStart: '18:00', shiftEnd: '08:00' };
    expect(inShiftWindow(night, at('2026-09-29T06:30:00Z'))).toBe(false); // 12:00 IST
    const noon = resolveOnCall(night, PEOPLE, [], at('2026-09-29T06:30:00Z'));
    expect(noon.userId).toBeNull();
    expect(noon.until?.toISOString()).toBe('2026-09-29T12:30:00.000Z'); // next 18:00 IST
    const evening = resolveOnCall(night, PEOPLE, [], at('2026-09-29T15:00:00Z')); // 20:30 IST
    expect(evening.userId).toBe('A');
    expect(evening.until?.toISOString()).toBe('2026-09-30T02:30:00.000Z'); // 08:00 IST next day
    expect(resolveOnCall(night, PEOPLE, [], at('2026-09-30T01:00:00Z')).userId).toBe('A'); // 06:30 IST, still the overnight window
  });
  it('a handoff follows the local clock across a daylight-saving change', () => {
    const ny: RotaDef = { ...WEEKLY, timezone: 'America/New_York' };
    expect(handoffAt(ny, 0).toUTC().toISO()).toBe('2026-09-28T13:00:00.000Z'); // EDT
    expect(handoffAt(ny, 5).toUTC().toISO()).toBe('2026-11-02T14:00:00.000Z'); // EST after 1 Nov
    expect(DateTime.fromJSDate(handoffAt(ny, 5).toJSDate(), { zone: 'America/New_York' }).toFormat('HH:mm')).toBe('09:00');
  });
  it('expands a daily rota into one shift per day and splits a shift around an override', () => {
    const daily: RotaDef = { ...WEEKLY, rotation: 'daily' };
    const from = at('2026-09-28T03:30:00Z');
    const to = at('2026-10-05T03:30:00Z');
    const plain = expandSchedule(daily, PEOPLE, [], from, to);
    expect(plain.map((s) => s.userId)).toEqual(['A', 'B', 'C', 'A', 'B', 'C', 'A']);
    expect(plain[0]!.start.toISOString()).toBe('2026-09-28T03:30:00.000Z');
    expect(plain[6]!.end.toISOString()).toBe('2026-10-05T03:30:00.000Z');
    const o = { id: 'o2', userId: 'C', startsAt: at('2026-09-29T10:00:00Z'), endsAt: at('2026-09-29T12:00:00Z') };
    const split = expandSchedule(daily, PEOPLE, [o], from, to);
    expect(split).toHaveLength(9);
    const day2 = split.filter((s) => s.start >= at('2026-09-29T03:30:00Z') && s.end <= at('2026-09-30T03:30:00Z'));
    expect(day2.map((s) => [s.userId, s.overrideId])).toEqual([['B', null], ['C', 'o2'], ['B', null]]);
    const windowed = expandSchedule({ ...daily, shiftStart: '18:00', shiftEnd: '08:00' }, PEOPLE, [], from, to);
    expect(windowed.every((s) => s.end.getTime() - s.start.getTime() <= 14 * 3600_000)).toBe(true);
    expect(windowed.length).toBeGreaterThanOrEqual(7);
  });
});

// ------------------------------------------------------------------ the module against the database

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [a] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    const [c] = await tx.insert(schema.customers).values({ code: `OC${S.toUpperCase()}`, name: `On-call Customer ${S}`, timezone: 'Asia/Kolkata' }).returning();
    ids.customer = c!.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: c!.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.site = site!.id;
    const engineerRole = await roleId(tx, 'engineer');
    const [manager] = await tx.insert(schema.users).values({ email: `oc-mgr-${S}@example.test`, name: 'Meera Manager', userType: 'msp', status: 'active', phone: '9800000001', whatsappOptIn: true }).returning();
    const [al] = await tx.insert(schema.users).values({ email: `oc-alice-${S}@example.test`, name: 'Alice Engineer', userType: 'msp', status: 'active', phone: '9800000002', whatsappOptIn: true }).returning();
    const [bob] = await tx.insert(schema.users).values({ email: `oc-bob-${S}@example.test`, name: 'Bob Engineer', userType: 'msp', status: 'active' }).returning();
    const [portal] = await tx.insert(schema.users).values({ email: `oc-portal-${S}@example.test`, name: 'Portal User', userType: 'customer', customerId: c!.id, status: 'active', passwordHash: await hashPassword('Demo@12345') }).returning();
    ids.manager = manager!.id;
    ids.alice = al!.id;
    ids.bob = bob!.id;
    ids.portal = portal!.id;
    await tx.insert(schema.userRoles).values([
      { userId: manager!.id, roleId: await roleId(tx, 'noc_manager') },
      { userId: al!.id, roleId: engineerRole },
      { userId: bob!.id, roleId: engineerRole },
      { userId: portal!.id, roleId: await roleId(tx, 'customer_user'), customerId: c!.id },
    ]);
    const [team] = await tx.insert(schema.teams).values({ key: `oncall_${S}`, name: `NOC ${S}`, teamType: 'noc', managerUserId: manager!.id }).returning();
    ids.team = team!.id;
    await tx.insert(schema.teamMembers).values([{ teamId: team!.id, userId: al!.id, isLead: true }, { teamId: team!.id, userId: bob!.id }, { teamId: team!.id, userId: manager!.id }]);
    invalidatePrincipal(a!.id);
    admin = (await loadPrincipal(a!.id))!;
  });
  alice = (await loadPrincipal(ids.alice))!;
  const t = await asAdmin((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customer, siteId: ids.site, title: `Core switch down ${S}`, description: 'Site-wide outage', priorityId: ids.p1, assignedTeamId: ids.team }));
  ids.ticket = t.id;
  created.push(t.id);
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (ids.rule) await tx.delete(schema.escalationRules).where(eq(schema.escalationRules.id, ids.rule));
    if (created.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, created));
    await tx.delete(schema.teams).where(eq(schema.teams.id, ids.team));
    if (ids.policy) await tx.delete(schema.escalationPolicies).where(eq(schema.escalationPolicies.id, ids.policy));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.manager, ids.alice, ids.bob, ids.portal]));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
  });
  await closeDb();
});

describe('on-call schedules', () => {
  it('a rota with a policy puts the first participant on call this week', async () => {
    const monday = DateTime.now().setZone('Asia/Kolkata').startOf('week').toISODate()!;
    const rota = await asAdmin((ctx) => createRota(ctx, { teamId: ids.team, name: 'Primary', startDate: monday, handoffTime: '00:00', timezone: 'Asia/Kolkata', participants: [ids.alice, ids.bob] }));
    ids.rota = rota.id;
    expect(rota.participants.map((p) => p.userId)).toEqual([ids.alice, ids.bob]);
    const policy = await asAdmin((ctx) =>
      createPolicy(ctx, {
        name: `NOC critical ${S}`,
        steps: [
          { target: 'oncall', channels: ['email', 'in_app', 'whatsapp'], timeoutMinutes: 5 },
          { target: 'manager', channels: ['email', 'in_app'], timeoutMinutes: 5 },
        ],
      }),
    );
    ids.policy = policy.id;
    await asAdmin((ctx) => setTeamPolicy(ctx, ids.team, policy.id));
    const now = await asAdmin((ctx) => onCallNow(ctx, { teamId: ids.team }));
    const team = now.teams.find((t) => t.id === ids.team)!;
    expect(team.escalationPolicyName).toBe(`NOC critical ${S}`);
    expect(team.rotas).toHaveLength(1);
    expect(team.rotas[0]!.user?.id).toBe(ids.alice);
    expect(team.rotas[0]!.until).toBeInstanceOf(Date);
  });

  it('cover (an override) wins, and an engineer may only cover themselves', async () => {
    const o = await asAdmin((ctx) => createOverride(ctx, { rotaId: ids.rota, userId: ids.bob, startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 3600_000), reason: 'swap' }));
    const during = await withSystem((tx) => whoIsOnCall(tx, ids.team));
    expect(during[0]!.userId).toBe(ids.bob);
    expect(during[0]!.override?.id).toBe(o.id);
    await expect(asAlice((ctx) => createOverride(ctx, { rotaId: ids.rota, userId: ids.bob, startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) }))).rejects.toThrow(/only add cover for yourself/);
    const mine = await asAlice((ctx) => createOverride(ctx, { rotaId: ids.rota, userId: ids.alice, startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000) }));
    expect(mine.userId).toBe(ids.alice);
    await asAlice((ctx) => deleteOverride(ctx, mine.id));
    await asAdmin((ctx) => deleteOverride(ctx, o.id));
    expect((await withSystem((tx) => whoIsOnCall(tx, ids.team)))[0]!.userId).toBe(ids.alice);
  });

  it('the schedule for the week names only people in the rota', async () => {
    const from = new Date();
    const to = new Date(Date.now() + 7 * 86_400_000);
    const s = await asAdmin((ctx) => schedule(ctx, { teamId: ids.team, from, to }));
    expect(s.rotas.map((r) => r.id)).toEqual([ids.rota]);
    expect(s.shifts.length).toBeGreaterThanOrEqual(1);
    expect(s.shifts.every((x) => x.userId === ids.alice || x.userId === ids.bob)).toBe(true);
    expect(s.shifts[0]!.userId).toBe(ids.alice);
    expect(s.shifts[0]!.userName).toBe('Alice Engineer');
    await expect(asAdmin((ctx) => schedule(ctx, { teamId: ids.team, from, to: new Date(from.getTime() + 100 * 86_400_000) }))).rejects.toThrow(/limited to 62 days/);
  });

  it('the on-call recipient flag reaches whoever is on call for the assigned team', async () => {
    const ticket = await withSystem((tx) => reloadTicket(tx, ids.ticket));
    const queued = await asAdmin((ctx) => notifyTicketEvent(ctx, 'ticket.escalated', ticket, { recipientOverride: { onCall: true }, channels: ['in_app', 'email'], reason: 'flag test' }));
    expect(queued).toBe(1);
    const rows = await inAppFor('ticket.escalated', ids.alice);
    expect(rows.some((n) => n.entityId === ids.ticket)).toBe(true);
  });
});

describe('paging', () => {
  it('an escalation rule pages through the team policy and notifies the on-call engineer', async () => {
    const [rule] = await withSystem((tx) => tx.insert(schema.escalationRules).values({ name: `Page on breach ${S}`, sortOrder: 999, conditions: { onBreach: true, metric: 'any', teamIds: [ids.team] }, actions: { notifyOnCall: true, pageTeam: true } }).returning());
    ids.rule = rule!.id;
    const res = await withSystem(async (tx) => applyEscalationRules(systemCtx(tx, 'test'), await reloadTicket(tx, ids.ticket), { kind: 'breach', metric: 'response', pct: 100 }));
    expect(res.applied).toContain(`Page on breach ${S}`);
    const pages = await asAdmin((ctx) => listPages(ctx, { ticketId: ids.ticket }));
    expect(pages.items).toHaveLength(1);
    const page = pages.items[0]!;
    expect(page.status).toBe('pending');
    expect(page.source).toBe('rule');
    expect(page.step).toBe(0);
    expect(page.targetUserId).toBe(ids.alice);
    expect(page.policyName).toBe(`NOC critical ${S}`);
    expect(page.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    const mails = await outboxFor('page.sent', ids.ticket);
    expect(mails.filter((m) => m.channel === 'email').map((m) => m.recipient)).toEqual([`oc-alice-${S}@example.test`]);
    expect(mails[0]!.body).toContain('/api/oncall/ack/');
    const inApp = await inAppFor('page.sent', ids.alice);
    expect(inApp[0]!.title).toMatch(/PAGE: Core switch down/);
    expect(inApp[0]!.link).toBe(`/tickets/${ids.ticket}`);
    // A second start is refused while a step is waiting.
    await expect(asAdmin((ctx) => pageTicket(ctx, ids.ticket, { source: 'manual' }))).rejects.toThrow(/already in progress/);
  });

  it('a step that times out escalates to the next step, and the last step expires to the managers', async () => {
    const [first] = (await asAdmin((ctx) => listPages(ctx, { ticketId: ids.ticket, status: 'open' }))).items;
    expect(await processTimeout(first!.id)).toBe('not_due');
    await backdate(first!.id);
    expect(await processTimeout(first!.id)).toBe('escalated');
    const after = await asAdmin((ctx) => listPages(ctx, { ticketId: ids.ticket }));
    expect(after.items.map((p) => p.status)).toEqual(['pending', 'escalated']);
    const second = after.items[0]!;
    expect(second.step).toBe(1);
    expect(second.targetKind).toBe('manager');
    expect(second.targetUserId).toBe(ids.manager);
    expect(second.rootPageId).toBe(first!.id);
    expect(await processTimeout(first!.id)).toBe('not_pending');
    await backdate(second.id);
    expect(await processTimeout(second.id)).toBe('expired');
    const done = await asAdmin((ctx) => listPages(ctx, { ticketId: ids.ticket }));
    expect(done.items.map((p) => p.status)).toEqual(['expired', 'escalated']);
    const expired = await outboxFor('page.expired', ids.ticket);
    expect(expired.some((m) => m.recipient === `oc-mgr-${S}@example.test`)).toBe(true);
    const tl = await asAdmin((ctx) => timeline(ctx, ids.ticket));
    expect(tl.items.filter((i) => i.kind === 'activity' && (i as { type?: string }).type === 'page').length).toBeGreaterThanOrEqual(4);
  });

  it('the message link acknowledges the page and assigns the ticket to the acknowledger', async () => {
    const page = await asAdmin((ctx) => pageTicket(ctx, ids.ticket, { reason: 'Customer on the phone', source: 'manual' }));
    expect(page.status).toBe('pending');
    expect(page.targetUserId).toBe(ids.alice);
    const [note] = await inAppFor('page.sent', ids.alice);
    const token = tokenFrom(note!.body);
    expect(token).toBeTruthy();
    expect((await pageByToken(token!))!.status).toBe('pending');
    const res = await acknowledgeByToken(token!);
    expect(res.status).toBe('acked');
    expect(res.ackedBy).toBe('Alice Engineer');
    expect(res.ticket.number).toMatch(/^INC-/);
    const ticket = await withSystem((tx) => reloadTicket(tx, ids.ticket));
    expect(ticket.assigneeId).toBe(ids.alice);
    expect(await processTimeout(page.id)).toBe('not_pending');
    expect((await pageByToken(token!))!.status).toBe('acked');
    expect((await acknowledgeByToken(token!)).status).toBe('acked');
    const pagedBy = await inAppFor('page.acknowledged', admin.id);
    expect(pagedBy.some((n) => n.entityId === ids.ticket)).toBe(true);
    await expect(acknowledgeByToken('not-a-real-token-at-all')).rejects.toThrow();
  });

  it('resolving the ticket calls off a waiting page', async () => {
    const page = await asAdmin((ctx) => pageTicket(ctx, ids.ticket, { source: 'manual' }));
    expect(page.status).toBe('pending');
    await asAdmin((ctx) => resolveTicket(ctx, ids.ticket, { resolutionNotes: 'Switch replaced' }));
    const pages = await asAdmin((ctx) => listPages(ctx, { ticketId: ids.ticket, limit: 1 }));
    expect(pages.items[0]!.id).toBe(page.id);
    expect(pages.items[0]!.status).toBe('cancelled');
  });

  it('the sweep moves a page on when the delayed job is gone', async () => {
    const t2 = await asAdmin((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customer, siteId: ids.site, title: `Firewall flapping ${S}`, description: 'x', priorityId: ids.p1, assignedTeamId: ids.team }));
    ids.ticket2 = t2.id;
    created.push(t2.id);
    const page = await asAdmin((ctx) => pageTicket(ctx, t2.id, { policyId: ids.policy, source: 'manual' }));
    await backdate(page.id);
    expect(await sweepTimeouts()).toBeGreaterThanOrEqual(1);
    const pages = await asAdmin((ctx) => listPages(ctx, { ticketId: t2.id }));
    expect(pages.items.map((p) => p.status)).toEqual(['pending', 'escalated']);
  });

  it('a policy in use by an escalation rule cannot be deleted', async () => {
    await withSystem((tx) => tx.update(schema.escalationRules).set({ actions: { pagePolicyId: ids.policy } }).where(eq(schema.escalationRules.id, ids.rule)));
    await expect(asAdmin((ctx) => deletePolicy(ctx, ids.policy))).rejects.toThrow(/pages through this policy/);
  });

  it('the NOC dashboard shows who is on call', async () => {
    const d = await asAdmin((ctx) => noc(ctx, { days: 7 }));
    const mine = (d.onCall as { teamId: string; rotas: { userId: string | null }[] }[]).find((t) => t.teamId === ids.team);
    expect(mine?.rotas[0]?.userId).toBe(ids.alice);
  });
});

describe('acknowledgement page and permissions (HTTP)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminToken = '';
  let portalToken = '';
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = async (email: string, password: string) => ((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).json() as { accessToken: string }).accessToken;
    adminToken = await login('admin@msp.local', 'Admin@12345');
    portalToken = await login(`oc-portal-${S}@example.test`, 'Demo@12345');
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET shows a button and never acknowledges; POST acknowledges; a bad token is 404', async () => {
    // The sweep left the second ticket's page waiting on the manager; the link in her message closes the chain.
    const [pending] = (await asAdmin((ctx) => listPages(ctx, { ticketId: ids.ticket2, status: 'open' }))).items;
    expect(pending?.targetUserId).toBe(ids.manager);
    const [note] = await inAppFor('page.sent', pending!.targetUserId!);
    const token = tokenFrom(note!.body)!;
    const shown = await app.inject({ method: 'GET', url: `/api/oncall/ack/${token}` });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-type']).toContain('text/html');
    expect(shown.body).toContain('Acknowledge the page');
    expect((await pageByToken(token))!.status).toBe('pending');
    const acked = await app.inject({ method: 'POST', url: `/api/oncall/ack/${token}` });
    expect(acked.statusCode).toBe(200);
    expect(acked.body).toContain('Acknowledged');
    expect((await pageByToken(token))!.status).toBe('acked');
    const again = await app.inject({ method: 'GET', url: `/api/oncall/ack/${token}` });
    expect(again.body).toContain('Already acknowledged');
    const bad = await app.inject({ method: 'GET', url: '/api/oncall/ack/abcdefghijklmnopqrstuvwxyz0123' });
    expect(bad.statusCode).toBe(404);
  });

  it('staff read the board; customer users and anonymous callers are refused', async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/oncall/now?teamId=${ids.team}`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { teams: { id: string }[] }).teams[0]!.id).toBe(ids.team);
    const portal = await app.inject({ method: 'GET', url: '/api/oncall/now', headers: { authorization: `Bearer ${portalToken}` } });
    expect(portal.statusCode).toBe(403);
    const anon = await app.inject({ method: 'GET', url: '/api/oncall/policies' });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/api/oncall/policies', headers: { authorization: `Bearer ${adminToken}` }, payload: { name: 'x', steps: [{ target: 'user', channels: ['email'], timeoutMinutes: 5 }] } });
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { message: string }).message).toMatch(/pick the person/);
    const shape = await app.inject({ method: 'POST', url: '/api/oncall/policies', headers: { authorization: `Bearer ${adminToken}` }, payload: { name: 'x', steps: [] } });
    expect(shape.statusCode).toBe(400);
  });
});
