/**
 * Daily briefings: preferences parse with safe defaults; a briefing is due
 * once a day after the chosen local time; the engineer briefing carries the
 * person's own tickets and the account manager's only their customers; the
 * model phrases it when on and the facts stand on their own when off; the
 * scheduled generation delivers through the chosen channels under the
 * person's own identity; customer users get nothing.
 * Run with the dev environment sourced: npx vitest run test/briefings.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket } from '../src/modules/tickets/service';
import * as briefings from '../src/modules/briefings/service';
import { detectRole } from '../src/modules/briefings/definitions';
import * as ai from '../src/modules/ai/service';
import type { ChatResponse } from '../src/lib/ai';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-briefings-${S}`, ip: '127.0.0.1' };
let admin: Principal;
let alice: Principal;
let am: Principal;
let portal: Principal;
const ids = { a: '', b: '', team: '', alice: '', am: '', portal: '', p1: '', p3: '', mine: '', unassigned: '', theirs: '' };
const json = (o: unknown): ChatResponse => ({ text: JSON.stringify(o), toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } });
const as = (p: Principal) => <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(p, meta, fn);
const setLimits = (maxPerDay: number, cooldownMinutes: number) =>
  withSystem(async (tx) => {
    await tx.update(schema.systemSettings).set({ value: maxPerDay }).where(eq(schema.systemSettings.key, 'ai.briefing.max_per_day'));
    await tx.update(schema.systemSettings).set({ value: cooldownMinutes }).where(eq(schema.systemSettings.key, 'ai.briefing.cooldown_minutes'));
  });

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  return row!.id;
}
async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  return row!.id;
}
async function reload(id: string) {
  invalidatePrincipal(id);
  return (await loadPrincipal(id))!;
}

beforeAll(async () => {
  ai.setProviderForTests({ name: 'none', model: 'none', chat: async () => json({}) });
  await withSystem(async (tx) => {
    const [adm] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    const engineer = await roleId(tx, 'noc_engineer');
    const [al] = await tx.insert(schema.users).values({ email: `br-alice-${S}@example.test`, name: 'Alice Briefing', userType: 'msp', status: 'active', timezone: 'Asia/Kolkata' }).returning();
    const [mgr] = await tx.insert(schema.users).values({ email: `br-am-${S}@example.test`, name: 'Avery Accounts', userType: 'msp', status: 'active', timezone: 'Europe/London' }).returning();
    ids.alice = al!.id;
    ids.am = mgr!.id;
    await tx.insert(schema.userRoles).values([{ userId: al!.id, roleId: engineer, customerId: null }]);
    const [team] = await tx.insert(schema.teams).values({ key: `br_noc_${S}`, name: `Briefing NOC ${S}`, teamType: 'noc' }).returning();
    ids.team = team!.id;
    await tx.insert(schema.teamMembers).values({ teamId: team!.id, userId: al!.id });
    const [a] = await tx.insert(schema.customers).values({ code: `BA${S.toUpperCase()}`, name: `Briefing Customer A ${S}`, accountManagerId: mgr!.id }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: `BB${S.toUpperCase()}`, name: `Briefing Customer B ${S}`, accountManagerId: adm!.id }).returning();
    ids.a = a!.id;
    ids.b = b!.id;
    // the account manager role is scoped per customer: Avery holds it for customer A only
    await tx.insert(schema.userRoles).values({ userId: mgr!.id, roleId: await roleId(tx, 'account_manager'), customerId: a!.id });
    const [pu] = await tx.insert(schema.users).values({ email: `br-portal-${S}@example.test`, name: 'Briefing Portal', userType: 'customer', customerId: a!.id, status: 'active' }).returning();
    ids.portal = pu!.id;
    await tx.insert(schema.userRoles).values({ userId: pu!.id, roleId: await roleId(tx, 'customer_admin'), customerId: a!.id });
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p3 = await optionId(tx, 'ticket_priority', 'p3');
    invalidatePrincipal(adm!.id);
    admin = (await loadPrincipal(adm!.id))!;
  });
  alice = await reload(ids.alice);
  am = await reload(ids.am);
  portal = await reload(ids.portal);
  await as(admin)(async (ctx) => {
    const mine = await createTicket(ctx, { type: 'incident', customerId: ids.a, title: `Alice's firewall ${S}`, description: 'Assigned to Alice', priorityId: ids.p1, assignedTeamId: ids.team, assigneeId: ids.alice });
    const un = await createTicket(ctx, { type: 'incident', customerId: ids.a, title: `Nobody's printer ${S}`, description: 'Unassigned', priorityId: ids.p3, assignedTeamId: ids.team });
    const theirs = await createTicket(ctx, { type: 'incident', customerId: ids.b, title: `Other customer ${S}`, description: 'Managed by the admin', priorityId: ids.p1, assignedTeamId: ids.team, assigneeId: admin.id });
    ids.mine = mine.id;
    ids.unassigned = un.id;
    ids.theirs = theirs.id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.delete(schema.briefings).where(inArray(schema.briefings.userId, [ids.alice, ids.am]));
    await tx.delete(schema.notificationOutbox).where(eq(schema.notificationOutbox.event, 'briefing.daily'));
    await tx.delete(schema.tickets).where(inArray(schema.tickets.id, [ids.mine, ids.unassigned, ids.theirs]));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.alice, ids.am, ids.portal]));
    await tx.delete(schema.teams).where(eq(schema.teams.id, ids.team));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.a, ids.b]));
  });
  ai.setProviderForTests(null);
  await closeDb();
});

describe('preferences and timing', () => {
  it('parses preferences with safe defaults', () => {
    expect(briefings.prefsOf(undefined)).toEqual({ enabled: false, time: '08:00', role: 'auto', channels: ['email', 'in_app'] });
    expect(briefings.prefsOf({ briefing: { enabled: true, time: '07:30', role: 'engineer', channels: ['in_app'] } })).toEqual({ enabled: true, time: '07:30', role: 'engineer', channels: ['in_app'] });
    expect(briefings.prefsOf({ briefing: { enabled: true, time: '25:99', role: 'ceo' } }).enabled).toBe(false); // invalid shape → defaults
    expect(briefings.prefsOf({ briefing: 'yes' })).toMatchObject({ enabled: false });
  });

  it('a briefing is due once a day after the chosen local time', () => {
    const prefs = briefings.prefsOf({ briefing: { enabled: true, time: '08:00' } });
    // 02:35 UTC = 08:05 in Kolkata
    expect(briefings.isDue(prefs, 'Asia/Kolkata', null, new Date('2026-03-04T02:35:00Z'))).toEqual({ due: true, day: '2026-03-04' });
    expect(briefings.isDue(prefs, 'Asia/Kolkata', null, new Date('2026-03-04T02:20:00Z'))).toEqual({ due: false, day: '2026-03-04' });
    expect(briefings.isDue(prefs, 'Asia/Kolkata', '2026-03-04', new Date('2026-03-04T02:35:00Z'))).toEqual({ due: false, day: '2026-03-04' });
    expect(briefings.isDue(prefs, 'Asia/Kolkata', '2026-03-03', new Date('2026-03-04T02:35:00Z'))).toEqual({ due: true, day: '2026-03-04' });
    // 23:30 UTC on the 3rd is already the 4th in Kolkata, before 08:00
    expect(briefings.isDue(prefs, 'Asia/Kolkata', '2026-03-03', new Date('2026-03-03T23:30:00Z'))).toEqual({ due: false, day: '2026-03-04' });
    expect(briefings.isDue({ ...prefs, enabled: false }, 'UTC', null, new Date('2026-03-04T12:00:00Z')).due).toBe(false);
    expect(briefings.isDue(prefs, 'Mars/Olympus', null, new Date('2026-03-04T12:00:00Z'))).toEqual({ due: true, day: '2026-03-04' }); // unknown zone → UTC
  });
});

describe('roles and content', () => {
  it('picks the role from the person\'s roles and falls back when a chosen role is not open to them', async () => {
    expect(await as(alice)(async (ctx) => detectRole(ctx))).toBe('engineer');
    expect(await as(am)(async (ctx) => detectRole(ctx))).toBe('account_manager');
    expect(await as(admin)(async (ctx) => detectRole(ctx))).toBe('service_manager');
    expect(await as(alice)(async (ctx) => briefings.roleFor(ctx, briefings.prefsOf({ briefing: { role: 'service_manager' } })))).toBe('engineer');
    expect(await as(admin)(async (ctx) => briefings.roleFor(ctx, briefings.prefsOf({ briefing: { role: 'noc_manager' } })))).toBe('noc_manager');
    const t = await as(alice)((ctx) => briefings.today(ctx));
    expect(t.briefing).toBeNull();
    expect(t.roles.find((r) => r.key === 'service_manager')?.allowed).toBe(false);
    expect(t.roles.find((r) => r.key === 'engineer')?.allowed).toBe(true);
    await expect(as(portal)((ctx) => briefings.today(ctx))).rejects.toThrow(/staff/);
  });

  it('writes the engineer briefing from the person\'s own queue and stores it for the day', async () => {
    const { briefing: b, reused, usage } = await as(alice)((ctx) => briefings.generate(ctx, { now: new Date() }));
    expect(reused).toBe(false);
    expect(usage).toMatchObject({ used: 1, remaining: 2, cooling: true, exhausted: false });
    expect(b.role).toBe('engineer');
    expect(b.ai).toBe(false);
    expect(b.text.startsWith('Good morning, Alice.')).toBe(true);
    const mine = await withSystem((tx) => tx.select({ number: schema.tickets.number }).from(schema.tickets).where(eq(schema.tickets.id, ids.mine)).limit(1));
    expect(b.text).toContain(mine[0]!.number);
    expect(b.text).toContain('## Due next');
    expect(b.text).toContain(`## Unassigned in Briefing NOC ${S}`);
    expect(b.facts?.headline[0]).toContain('You have 1 open ticket');
    expect(b.html).toContain('<h3');
    expect(b.html).toContain(`/tickets/${ids.mine}`);
    expect(b.channels).toEqual([]);
    const t = await as(alice)((ctx) => briefings.today(ctx));
    expect(t.briefing?.id).toBe(b.id);
    expect(t.day).toBe(b.day);
    // inside the cooldown a second request returns the stored briefing without a new build
    const again = await as(alice)((ctx) => briefings.generate(ctx));
    expect(again.reused).toBe(true);
    expect(again.reason).toBe('cooldown');
    expect(again.briefing.id).toBe(b.id);
    expect(again.briefing.generations).toBe(1);
    // the other customer's P1 belongs to the admin: not in Alice's queue
    expect(b.text).not.toContain(`Other customer ${S}`);
    expect(b.facts?.headline[1]).toContain('1 ticket in Briefing NOC');
  });

  it('the account manager briefing covers only the customers they manage', async () => {
    const { briefing: b } = await as(am)((ctx) => briefings.generate(ctx));
    expect(b.role).toBe('account_manager');
    expect(b.facts?.headline[0]).toContain('Your 1 customer has 2 open tickets');
    const customers = b.facts?.sections.find((s) => s.key === 'customers');
    expect(customers?.items.map((i) => i.title)).toEqual([`Briefing Customer A ${S}`]);
    expect(b.text).toContain(`Briefing Customer A ${S}`);
    expect(b.text).not.toContain(`Briefing Customer B ${S}`);
    const p1p2 = b.facts?.sections.find((s) => s.key === 'p1p2');
    expect(p1p2?.items.some((i) => i.title === `Alice's firewall ${S}`)).toBe(true);
    expect(p1p2?.items.some((i) => i.title === `Other customer ${S}`)).toBe(false);
  });

  it('takes the model\'s text when a provider is on and keeps the facts otherwise', async () => {
    ai.setProviderForTests({ name: 'fake', model: 'fake-1', chat: async () => json({ text: 'Good morning, Alice. The model wrote this.\n\n- one open ticket\n\n## Due next\n- **[INC-1](/tickets/x)** something' }) });
    try {
      await setLimits(0, 0);
      const { briefing: b } = await as(alice)((ctx) => briefings.generate(ctx));
      expect(b.ai).toBe(true);
      expect(b.text).toContain('The model wrote this');
      expect(b.html).toContain('<a href="');
      await withSystem((tx) => tx.update(schema.systemSettings).set({ value: ['briefing'] }).where(eq(schema.systemSettings.key, 'ai.disabled_features')));
      const { briefing: off } = await as(alice)((ctx) => briefings.generate(ctx));
      expect(off.ai).toBe(false);
    } finally {
      await setLimits(3, 15);
      await withSystem((tx) => tx.update(schema.systemSettings).set({ value: [] }).where(eq(schema.systemSettings.key, 'ai.disabled_features')));
      ai.setProviderForTests({ name: 'none', model: 'none', chat: async () => json({}) });
    }
  });

  it('converts the markdown subset to email HTML with absolute links and escaping', () => {
    const html = briefings.markdownToHtml('Hello <b>\n\n## Due next\n- **[INC-1](/tickets/1)** fix & go — soon\n- plain', 'https://itsm.example/');
    expect(html).toContain('<p style="margin:6px 0">Hello &lt;b&gt;</p>');
    expect(html).toContain('<h3 style="margin:18px 0 6px;font-size:14px">Due next</h3>');
    expect(html).toContain('<strong><a href="https://itsm.example/tickets/1">INC-1</a></strong> fix &amp; go — soon');
    expect(html.match(/<ul/g)?.length).toBe(1);
  });
});

describe('guardrails on generating on request', () => {
  it('caps generations per day and reuses the stored briefing inside the cooldown', async () => {
    await withSystem((tx) => tx.delete(schema.briefings).where(eq(schema.briefings.userId, ids.alice)));
    await setLimits(2, 0);
    try {
      const first = await as(alice)((ctx) => briefings.generate(ctx));
      expect(first).toMatchObject({ reused: false, usage: { used: 1, remaining: 1, exhausted: false } });
      const second = await as(alice)((ctx) => briefings.generate(ctx));
      expect(second).toMatchObject({ reused: false, usage: { used: 2, remaining: 0, exhausted: true } });
      expect(second.briefing.generations).toBe(2);
      const third = await as(alice)((ctx) => briefings.generate(ctx));
      expect(third).toMatchObject({ reused: true, reason: 'limit' });
      expect(third.briefing.id).toBe(first.briefing.id);
      expect(third.briefing.generations).toBe(2);
      const t = await as(alice)((ctx) => briefings.today(ctx));
      expect(t.usage).toMatchObject({ maxPerDay: 2, used: 2, remaining: 0, exhausted: true });
      // the cooldown alone: a fresh briefing, then an immediate request comes back reused
      await setLimits(0, 30);
      await withSystem((tx) => tx.delete(schema.briefings).where(eq(schema.briefings.userId, ids.alice)));
      const fresh = await as(alice)((ctx) => briefings.generate(ctx));
      expect(fresh.usage).toMatchObject({ remaining: null, cooling: true });
      const soon = await as(alice)((ctx) => briefings.generate(ctx));
      expect(soon).toMatchObject({ reused: true, reason: 'cooldown' });
      expect(new Date(soon.usage.nextAllowedAt!).getTime()).toBeGreaterThan(Date.now());
      // the scheduled delivery is never blocked by the cap or the cooldown
      await setLimits(1, 1440);
      await withSystem((tx) => tx.update(schema.users).set({ preferences: { briefing: { enabled: true, time: '00:00', channels: ['in_app'] } } }).where(eq(schema.users.id, ids.alice)));
      const delivered = await briefings.generateForUser(ids.alice, fresh.briefing.day);
      expect(delivered).toMatchObject({ role: 'engineer', channels: ['in_app'] });
      const rows = await withSystem((tx) => tx.select().from(schema.briefings).where(eq(schema.briefings.userId, ids.alice)));
      expect(rows.length).toBe(1);
      expect(rows[0]!.generations).toBe(1); // a delivery does not count against the person's cap
    } finally {
      await setLimits(3, 15);
      await withSystem(async (tx) => {
        await tx.update(schema.users).set({ preferences: {} }).where(eq(schema.users.id, ids.alice));
        await tx.delete(schema.notifications).where(and(eq(schema.notifications.userId, ids.alice), eq(schema.notifications.event, 'briefing.daily')));
        await tx.delete(schema.briefings).where(eq(schema.briefings.userId, ids.alice));
      });
    }
  });
});

describe('scheduling and delivery', () => {
  it('finds the people whose time has come and delivers through their channels under their own identity', async () => {
    await withSystem((tx) => tx.update(schema.users).set({ preferences: { briefing: { enabled: true, time: '08:00', role: 'auto', channels: ['email', 'in_app'] } } }).where(eq(schema.users.id, ids.alice)));
    await withSystem((tx) => tx.delete(schema.briefings).where(eq(schema.briefings.userId, ids.alice)));
    // 03:00 UTC = 08:30 in Kolkata: Alice is due; the account manager has not opted in
    const due = await withSystem((tx) => briefings.dueBriefings(tx, new Date('2026-03-04T03:00:00Z')));
    expect(due.some((d) => d.userId === ids.alice && d.day === '2026-03-04')).toBe(true);
    expect(due.some((d) => d.userId === ids.am)).toBe(false);
    const out = await briefings.generateForUser(ids.alice, '2026-03-04', new Date('2026-03-04T03:00:00Z'));
    expect(out).toMatchObject({ role: 'engineer', ai: false, channels: ['email', 'in_app'] });
    const rows = await withSystem((tx) => tx.select().from(schema.briefings).where(and(eq(schema.briefings.userId, ids.alice), eq(schema.briefings.day, '2026-03-04'))));
    expect(rows.length).toBe(1);
    expect(rows[0]!.deliveredAt).toBeTruthy();
    const mails = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'briefing.daily'), eq(schema.notificationOutbox.entityId, rows[0]!.id))));
    expect(mails.map((m) => m.recipient)).toEqual([alice.email.toLowerCase()]);
    expect(mails[0]!.subject).toContain('engineer briefing for 2026-03-04');
    expect(mails[0]!.body).toContain('Due next');
    const inApp = await withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ids.alice), eq(schema.notifications.event, 'briefing.daily'))));
    expect(inApp.length).toBe(1);
    // generated once: the same day is no longer due
    const after = await withSystem((tx) => briefings.dueBriefings(tx, new Date('2026-03-04T05:00:00Z')));
    expect(after.some((d) => d.userId === ids.alice)).toBe(false);
    // opted out people are skipped even when a stale job fires
    await withSystem((tx) => tx.update(schema.users).set({ preferences: { briefing: { enabled: false } } }).where(eq(schema.users.id, ids.alice)));
    expect(await briefings.generateForUser(ids.alice, '2026-03-05')).toEqual({ skipped: 'disabled' });
    expect(await briefings.generateForUser(ids.portal, '2026-03-05')).toEqual({ skipped: 'inactive' });
  });
});
