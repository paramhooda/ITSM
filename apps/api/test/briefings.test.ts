/**
 * Daily briefings: preferences parse with safe defaults; a briefing is due
 * once a day after the chosen local time; the engineer briefing carries the
 * person's own tickets and the account manager's only their customers; the
 * model phrases it when on and the facts stand on their own when off; the
 * scheduled generation delivers through the chosen channels under the
 * person's own identity; the facts are typed with doors that reproduce on the
 * list and a bounded narrative the model may phrase but never bend; a
 * customer user gets the brief for their own organisation, on demand, through
 * the portal list only.
 * Run with the dev environment sourced: npx vitest run test/briefings.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket } from '../src/modules/tickets/service';
import * as briefings from '../src/modules/briefings/service';
import { detectRole, metaOf } from '../src/modules/briefings/definitions';
import { countForLink, countForPortalLink, countDueWithin } from '../src/modules/briefings/doors';
import { ticketListPath } from '@itsm/shared';
import * as ai from '../src/modules/ai/service';
import type { ChatResponse } from '../src/lib/ai';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-briefings-${S}`, ip: '127.0.0.1' };
let admin: Principal;
let alice: Principal;
let am: Principal;
let portal: Principal;
/** A customer user of A (no portal:approve). */
let portalUser: Principal;
/** A customer account of A with no role at all (no portal:access). */
let portalNoAccess: Principal;
/** A NOC manager who is a member of Alice's team. */
let nocManager: Principal;
const ids = { a: '', b: '', team: '', alice: '', am: '', portal: '', portalUser: '', portalNoAccess: '', nocManager: '', p1: '', p3: '', mine: '', unassigned: '', theirs: '' };
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
    const [cu] = await tx.insert(schema.users).values({ email: `br-portal-user-${S}@example.test`, name: 'Briefing Customer User', userType: 'customer', customerId: a!.id, status: 'active' }).returning();
    ids.portalUser = cu!.id;
    await tx.insert(schema.userRoles).values({ userId: cu!.id, roleId: await roleId(tx, 'customer_user'), customerId: a!.id });
    const [na] = await tx.insert(schema.users).values({ email: `br-portal-none-${S}@example.test`, name: 'Briefing No Access', userType: 'customer', customerId: a!.id, status: 'active' }).returning();
    ids.portalNoAccess = na!.id;
    const [nm] = await tx.insert(schema.users).values({ email: `br-nocm-${S}@example.test`, name: 'Nadia Manager', userType: 'msp', status: 'active', timezone: 'Asia/Kolkata' }).returning();
    ids.nocManager = nm!.id;
    await tx.insert(schema.userRoles).values({ userId: nm!.id, roleId: await roleId(tx, 'noc_manager'), customerId: null });
    await tx.insert(schema.teamMembers).values({ teamId: team!.id, userId: nm!.id });
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p3 = await optionId(tx, 'ticket_priority', 'p3');
    invalidatePrincipal(adm!.id);
    admin = (await loadPrincipal(adm!.id))!;
  });
  alice = await reload(ids.alice);
  am = await reload(ids.am);
  portal = await reload(ids.portal);
  portalUser = await reload(ids.portalUser);
  portalNoAccess = await reload(ids.portalNoAccess);
  nocManager = await reload(ids.nocManager);
  await as(admin)(async (ctx) => {
    const mine = await createTicket(ctx, { type: 'incident', customerId: ids.a, title: `Alice's firewall ${S}`, description: 'Assigned to Alice', priorityId: ids.p1, assignedTeamId: ids.team, assigneeId: ids.alice });
    const un = await createTicket(ctx, { type: 'incident', customerId: ids.a, title: `Nobody's printer ${S}`, description: 'Unassigned', priorityId: ids.p3, assignedTeamId: ids.team });
    const theirs = await createTicket(ctx, { type: 'incident', customerId: ids.b, title: `Other customer ${S}`, description: 'Managed by the admin', priorityId: ids.p1, assignedTeamId: ids.team, assigneeId: admin.id });
    ids.mine = mine.id;
    ids.unassigned = un.id;
    ids.theirs = theirs.id;
  });
  // Alice's ticket is due in two hours: the "due in 24 hours" figure counts it, whatever the SLA policy set.
  await withSystem((tx) => tx.update(schema.tickets).set({ dueAt: new Date(Date.now() + 2 * 3_600_000) }).where(eq(schema.tickets.id, ids.mine)));
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.delete(schema.briefings).where(inArray(schema.briefings.userId, [ids.alice, ids.am, ids.portal, ids.portalUser, ids.nocManager]));
    await tx.delete(schema.notificationOutbox).where(eq(schema.notificationOutbox.event, 'briefing.daily'));
    await tx.delete(schema.tickets).where(inArray(schema.tickets.id, [ids.mine, ids.unassigned, ids.theirs]));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.alice, ids.am, ids.portal, ids.portalUser, ids.portalNoAccess, ids.nocManager]));
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
    // staff are never offered the customer brief; a customer is offered theirs only
    expect(t.roles.some((r) => r.key === 'customer')).toBe(false);
    const p = await as(portal)((ctx) => briefings.today(ctx));
    expect(p.role).toBe('customer');
    expect(p.roles).toEqual([{ key: 'customer', label: 'Your organisation', description: expect.any(String), allowed: true }]);
    expect(p.briefing).toBeNull();
    expect(await as(portal)(async (ctx) => briefings.roleFor(ctx, briefings.prefsOf({ briefing: { role: 'engineer' } })))).toBe('customer');
    expect(await as(portal)(async (ctx) => detectRole(ctx))).toBe('customer');
    // a customer account whose role lacks portal:access is refused
    await expect(as(portalNoAccess)((ctx) => briefings.today(ctx))).rejects.toThrow(/portal access/);
  });

  it('prints an item\'s instants in the person\'s zone and a day as the day it is, east or west of UTC', () => {
    const instant = '2026-10-20T01:30:00.000Z';
    expect(metaOf({ ref: 'x', title: 'x', kind: 'ticket', dueAt: instant }, 'Asia/Kolkata')).toBe('due 2026-10-20 07:00 GMT+5:30');
    expect(metaOf({ ref: 'x', title: 'x', kind: 'ticket', dueAt: instant }, 'America/New_York')).toMatch(/^due 2026-10-19 21:30 (EDT|GMT-4)$/);
    // a maintenance window or a contract end is a date column: the same day in every zone
    expect(metaOf({ ref: 'x', title: 'x', kind: 'maintenance', when: '2026-10-20', status: 'planned' }, 'America/New_York')).toBe('planned · 2026-10-20');
    expect(metaOf({ ref: 'x', title: 'x', kind: 'maintenance', when: '2026-10-20' }, 'Pacific/Honolulu')).toBe('2026-10-20');
    expect(metaOf({ ref: 'x', title: 'x', kind: 'visit', when: instant }, 'Pacific/Honolulu')).toMatch(/^2026-10-19 15:30 (HST|GMT-10)$/);
  });

  it('greets by the time of day in the person\'s timezone', () => {
    // 03:00 UTC is 08:30 in Kolkata, 13:00 UTC is 18:30
    expect(briefings.greetingFor('Alice Briefing', new Date('2026-03-04T03:00:00Z'), 'Asia/Kolkata')).toBe('Good morning, Alice.');
    expect(briefings.greetingFor('Alice Briefing', new Date('2026-03-04T09:00:00Z'), 'Asia/Kolkata')).toBe('Good afternoon, Alice.');
    expect(briefings.greetingFor('Alice Briefing', new Date('2026-03-04T13:00:00Z'), 'Asia/Kolkata')).toBe('Good evening, Alice.');
    expect(briefings.greetingFor('Alice Briefing', new Date('2026-03-04T13:00:00Z'), 'Mars/Olympus')).toBe('Good afternoon, Alice.');
  });

  it('writes the engineer briefing from the person\'s own queue and stores it for the day', async () => {
    const { briefing: b, reused, usage } = await as(alice)((ctx) => briefings.generate(ctx, { now: new Date() }));
    expect(reused).toBe(false);
    expect(usage).toMatchObject({ used: 1, remaining: 2, cooling: true, exhausted: false });
    expect(b.role).toBe('engineer');
    expect(b.ai).toBe(false);
    expect(b.text).toMatch(/^Good (morning|afternoon|evening), Alice\./);
    const mine = await withSystem((tx) => tx.select({ number: schema.tickets.number, dueAt: schema.tickets.dueAt }).from(schema.tickets).where(eq(schema.tickets.id, ids.mine)).limit(1));
    expect(b.text).toContain(mine[0]!.number);
    // the KPI row: doors where the list reproduces the number, figures elsewhere
    const facts = b.facts!;
    expect(facts.kpis.map((k) => k.label)).toEqual(['Open', 'Due in 24 hours', 'Breached', 'Likely to breach', `Unassigned in Briefing NOC ${S}`]);
    expect(facts.kpis.find((k) => k.key === 'open')).toMatchObject({ value: 1, href: ticketListPath({ assignee: 'me', status: 'open' }) });
    const due = facts.kpis.find((k) => k.key === 'due24')!;
    expect(due.href).toBeNull();
    expect(due.value).toBe(1);
    // the figure is counted over every open ticket of Alice's (never a page): it equals the direct count, which starts now (overdue is the Breached door's business)
    expect(await as(alice)((ctx) => countDueWithin(ctx, { assignee: 'me', status: 'open' }, 24))).toBe(due.value);
    expect(await as(alice)((ctx) => countDueWithin(ctx, { assignee: 'me', status: 'open' }, 1))).toBe(0);
    expect(facts.headline[0]).toContain('1 due in the next 24 hours');
    const unassigned = facts.sections.find((s) => s.key === 'unassigned')!;
    expect(unassigned.doors).toEqual([{ label: `Unassigned in Briefing NOC ${S}`, value: 1, href: ticketListPath({ teamId: ids.team, assignee: 'unassigned', status: 'open' }) }]);
    expect(unassigned.doors[0]!.href).toContain(`teamId=${ids.team}`);
    expect(unassigned.doors[0]!.href).not.toContain('domain=');
    expect(await as(alice)((ctx) => countForLink(ctx, { teamId: ids.team, assignee: 'unassigned', status: 'open' }))).toBe(1);
    // items are typed and the email line is written from the typed fields, times in Alice's zone
    const item = facts.sections.find((s) => s.key === 'due')!.items[0]!;
    expect(item).toMatchObject({ kind: 'ticket', ref: mine[0]!.number, customer: `Briefing Customer A ${S}`, assignee: 'Alice Briefing', breachRisk: null });
    expect(item.priority).toMatchObject({ key: 'p1', label: 'P1 - Critical' });
    expect(item.dueAt).toBe(mine[0]!.dueAt!.toISOString());
    const localDue = new Date(mine[0]!.dueAt!.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
    expect(item.meta).toContain(`due ${localDue}`);
    // the deterministic narrative: a greeting, the headline as the summary, one lead per section, no picks
    expect(b.narrative!.source).toBe('facts');
    expect(b.narrative!.greeting).toMatch(/^Good (morning|afternoon|evening), Alice\.$/);
    expect(b.narrative!.summary).toBe(facts.headline.join(' '));
    expect(b.narrative!.sections.map((s) => s.key)).toEqual(facts.sections.map((s) => s.key));
    expect(b.narrative!.sections.every((s) => s.picks.length === 0)).toBe(true);
    expect(b.facts?.narrative).toEqual(b.narrative!);
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

  it('keeps of the model\'s narrative only what the facts support, and keeps the facts when the provider is off or answers in another shape', async () => {
    await withSystem((tx) => tx.delete(schema.briefings).where(eq(schema.briefings.userId, ids.alice)));
    const unassignedTitle = `Unassigned in Briefing NOC ${S}`;
    ai.setProviderForTests({
      name: 'fake',
      model: 'fake-1',
      chat: async () =>
        json({
          greeting: 'Good day, Alice.',
          summary: 'You have 1 open ticket and 99 breached SLAs that need attention first thing today.',
          sections: [
            { key: 'due', lead: 'Start with the 1 ticket due within the day.', picks: ['NOT-A-REF'] },
            { key: 'invented', lead: 'A section the input does not have.', picks: [] },
          ],
        }),
    });
    try {
      await setLimits(0, 0);
      const { briefing: b } = await as(alice)((ctx) => briefings.generate(ctx));
      expect(b.ai).toBe(true);
      expect(b.narrative!.source).toBe('model');
      expect(b.narrative!.greeting).toBe('Good day, Alice.');
      expect(b.text.startsWith('Good day, Alice.')).toBe(true);
      // the summary quoted 99, a number not in the input: the deterministic summary stands
      expect(b.narrative!.summary).toBe(b.facts!.headline.join(' '));
      // the grounded lead is kept, the pick that is no ref is dropped, the invented section is absent, the omitted ones get the fallback lead
      const due = b.narrative!.sections.find((s) => s.key === 'due')!;
      expect(due.lead).toBe('Start with the 1 ticket due within the day.');
      expect(due.picks).toEqual([]);
      expect(b.narrative!.sections.some((s) => s.key === 'invented')).toBe(false);
      expect(b.narrative!.sections.find((s) => s.key === 'unassigned')?.lead).toBe(b.facts!.sections.find((s) => s.key === 'unassigned')!.summary);
      expect(b.text).toContain(`## ${unassignedTitle}`);
      expect(b.html).toContain('<a href="');
      // the old free-text shape is not a narrative: the facts stand
      ai.setProviderForTests({ name: 'fake', model: 'fake-1', chat: async () => json({ text: 'Good morning, Alice. The model wrote this.' }) });
      const { briefing: old } = await as(alice)((ctx) => briefings.generate(ctx));
      expect(old.ai).toBe(false);
      expect(old.narrative!.source).toBe('facts');
      expect(old.text).not.toContain('The model wrote this');
      // feature switched off: the facts stand
      ai.setProviderForTests({ name: 'fake', model: 'fake-1', chat: async () => json({ greeting: 'Good day, Alice.', summary: 'Everything in your queue is quiet today and nothing needs you.', sections: [] }) });
      await withSystem((tx) => tx.update(schema.systemSettings).set({ value: ['briefing'] }).where(eq(schema.systemSettings.key, 'ai.disabled_features')));
      const { briefing: off } = await as(alice)((ctx) => briefings.generate(ctx));
      expect(off.ai).toBe(false);
    } finally {
      await setLimits(3, 15);
      await withSystem((tx) => tx.update(schema.systemSettings).set({ value: [] }).where(eq(schema.systemSettings.key, 'ai.disabled_features')));
      ai.setProviderForTests({ name: 'none', model: 'none', chat: async () => json({}) });
    }
  });

  it('the NOC manager briefing quotes the counted team figures and its doors carry the team, never a domain', async () => {
    const { briefing: b } = await as(nocManager)((ctx) => briefings.generate(ctx));
    expect(b.role).toBe('noc_manager');
    const team = b.facts!.sections.find((s) => s.key === `team:${ids.team}`)!;
    expect(team.title).toBe(`Briefing NOC ${S}`);
    // "N open, N P1/P2, N breached, N at risk, N unassigned; …": the doors equal the numbers in the sentence
    const nums = (team.summary ?? '').replace('P1/P2', 'priorities').match(/\d+/g)!.map(Number);
    const doorOf = (label: string) => team.doors.find((d) => d.label === label)!;
    expect(doorOf('Open').value).toBe(nums[0]);
    expect(doorOf('Breached').value).toBe(nums[2]);
    expect(doorOf('At risk').value).toBe(nums[3]);
    expect(doorOf('Unassigned').value).toBe(nums[4]);
    expect(doorOf('Open')).toMatchObject({ value: 3, href: ticketListPath({ teamId: ids.team, status: 'open' }) }); // Alice's, the unassigned one and the admin's for customer B all sit in the team
    expect(doorOf('Unassigned')).toMatchObject({ value: 1, href: ticketListPath({ teamId: ids.team, assignee: 'unassigned', status: 'open' }) });
    const hrefs = [...b.facts!.kpis.map((k) => k.href), ...b.facts!.sections.flatMap((s) => s.doors.map((d) => d.href))].filter((h): h is string => !!h);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every((h) => !h.includes('domain='))).toBe(true);
    expect(b.facts!.kpis.find((k) => k.key === 'open')).toMatchObject({ value: 3, href: ticketListPath({ teamId: [ids.team], status: 'open' }) });
    expect(b.facts!.kpis.find((k) => k.key === 'major')).toMatchObject({ href: ticketListPath({ isMajor: true, status: 'open' }) });
    expect(b.facts!.headline[0]).toContain(`Across Briefing NOC ${S}: 3 open tickets`);
  });

  it('a customer user gets the brief for their own organisation through the portal list only', async () => {
    const { briefing: b } = await as(portal)((ctx) => briefings.generate(ctx));
    expect(b.role).toBe('customer');
    expect(b.roleLabel).toBe('Your organisation');
    const facts = b.facts!;
    expect(facts.kpis.map((k) => k.key)).toEqual(['open', 'awaiting', 'breached', 'atRisk', 'sla', 'toRate']);
    for (const k of facts.kpis) if (k.href) expect(k.href.startsWith('/portal/tickets')).toBe(true);
    expect(facts.kpis.find((k) => k.key === 'open')).toMatchObject({ value: 2, href: '/portal/tickets' });
    expect(facts.kpis.find((k) => k.key === 'sla')!.href).toBeNull();
    // the home's numbers equal the portal list's own count for the door's link
    expect(await as(portal)((ctx) => countForPortalLink(ctx, { status: 'open' }))).toBe(2);
    expect(await as(portal)((ctx) => countForPortalLink(ctx, { sla: 'breached' }))).toBe(facts.kpis.find((k) => k.key === 'breached')!.value);
    // every link is a portal (or shared knowledge) path; no staff list, record or customer path
    const links = [...facts.kpis.map((k) => k.href), ...facts.sections.flatMap((s) => [...s.doors.map((d) => d.href), ...s.items.map((i) => i.link)])].filter((h): h is string => !!h);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l).toMatch(/^\/(portal\/|knowledge\/known-errors)/);
    const text = JSON.stringify(facts);
    expect(text).not.toContain(`Other customer ${S}`);
    expect(text).not.toContain('Alice Briefing');
    expect(text).not.toContain(`Briefing Customer B ${S}`);
    expect(facts.sections.flatMap((s) => s.items).every((i) => i.assignee === null || i.assignee === undefined)).toBe(true);
    expect(facts.sections.flatMap((s) => s.items).every((i) => !i.team)).toBe(true);
    expect(b.text).toContain('Your organisation');
    expect(facts.headline[0]).toBe('Your organisation has 2 open tickets, 0 waiting on you and 0 with a breached SLA.');
    // the administrator holds portal:approve, so the approval door exists; a customer user has no such door
    const awaiting = facts.sections.find((s) => s.key === 'awaiting')!;
    expect(awaiting.doors.map((d) => d.label)).toEqual(['Awaiting your reply', 'Awaiting your approval']);
    const { briefing: u } = await as(portalUser)((ctx) => briefings.generate(ctx));
    expect(u.role).toBe('customer');
    expect(u.facts!.sections.find((s) => s.key === 'awaiting')!.doors.map((d) => d.label)).toEqual(['Awaiting your reply']);
    expect(JSON.stringify(u.facts)).not.toContain('Awaiting your approval');
    // a role the customer may not take falls through to theirs; a customer account without portal access is refused
    const forced = await as(portalUser)((ctx) => briefings.generate(ctx, { role: 'engineer' }));
    expect(forced.briefing.role).toBe('customer');
    await expect(as(portalNoAccess)((ctx) => briefings.generate(ctx))).rejects.toThrow(/portal access/);
    const t = await as(portal)((ctx) => briefings.today(ctx));
    expect(t.briefing?.id).toBe(b.id);
    expect(t.roles.map((r) => r.key)).toEqual(['customer']);
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
