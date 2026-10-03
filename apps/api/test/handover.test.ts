/**
 * Shift handover: shift arithmetic in the team's timezone; the digest counts
 * what the team has open, breached, at risk, unassigned and major; the draft
 * falls back to the deterministic note without a provider and takes the
 * model's text with one; publishing notifies the incoming shift (on call next,
 * else the team) and never the author; the author cannot acknowledge; the
 * tool reads the picture; customer users see nothing.
 * Run with the dev environment sourced: npx vitest run test/handover.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket } from '../src/modules/tickets/service';
import { declareMajor } from '../src/modules/tickets/major';
import * as handover from '../src/modules/handover/service';
import { currentAndNext, previous, instancesBetween } from '../src/modules/handover/shifts';
import { renderHandover } from '../src/modules/ai/digest';
import { ALL_TOOLS } from '../src/modules/ai/tools';
import * as ai from '../src/modules/ai/service';
import type { ChatResponse } from '../src/lib/ai';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-handover-${S}`, ip: '127.0.0.1' };
let admin: Principal;
let alice: Principal;
let bob: Principal;
let carol: Principal;
let portal: Principal;
const ids = { customer: '', team: '', other: '', alice: '', bob: '', carol: '', portal: '', p1: '', p3: '', day: '', night: '', major: '', p1Ticket: '', unassigned: '' };
const created = { tickets: [] as string[], handovers: [] as string[] };
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asAlice = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(alice, meta, fn);
const asBob = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(bob, meta, fn);
const asCarol = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(carol, meta, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portal, meta, fn);
const json = (o: unknown): ChatResponse => ({ text: JSON.stringify(o), toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } });

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  return row!.id;
}
async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  return row!.id;
}

beforeAll(async () => {
  ai.setProviderForTests({ name: 'none', model: 'none', chat: async () => json({}) });
  await withSystem(async (tx) => {
    const [adm] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    const [c] = await tx.insert(schema.customers).values({ code: `HO${S.toUpperCase()}`, name: `Handover Customer ${S}` }).returning();
    ids.customer = c!.id;
    const [team] = await tx.insert(schema.teams).values({ key: `ho_noc_${S}`, name: `Handover NOC ${S}`, teamType: 'noc' }).returning();
    const [other] = await tx.insert(schema.teams).values({ key: `ho_other_${S}`, name: `Handover Other ${S}`, teamType: 'network' }).returning();
    ids.team = team!.id;
    ids.other = other!.id;
    const engineer = await roleId(tx, 'noc_engineer');
    const mk = async (name: string) => {
      const [u] = await tx.insert(schema.users).values({ email: `ho-${name}-${S}@example.test`, name: `${name[0]!.toUpperCase()}${name.slice(1)} Handover`, userType: 'msp', status: 'active' }).returning();
      await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: engineer, customerId: null });
      return u!.id;
    };
    ids.alice = await mk('alice');
    ids.bob = await mk('bob');
    ids.carol = await mk('carol');
    await tx.insert(schema.teamMembers).values([{ teamId: team!.id, userId: ids.alice }, { teamId: team!.id, userId: ids.bob, isLead: true }, { teamId: other!.id, userId: ids.carol }]);
    const [pu] = await tx.insert(schema.users).values({ email: `ho-portal-${S}@example.test`, name: 'Handover Portal', userType: 'customer', customerId: c!.id, status: 'active' }).returning();
    ids.portal = pu!.id;
    await tx.insert(schema.userRoles).values({ userId: pu!.id, roleId: await roleId(tx, 'customer_admin'), customerId: c!.id });
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p3 = await optionId(tx, 'ticket_priority', 'p3');
    const [day] = await tx.insert(schema.teamShifts).values({ teamId: team!.id, name: 'Day', startTime: '08:00', endTime: '20:00', timezone: 'UTC', sortOrder: 10 }).returning();
    const [night] = await tx.insert(schema.teamShifts).values({ teamId: team!.id, name: 'Night', startTime: '20:00', endTime: '08:00', timezone: 'UTC', sortOrder: 20 }).returning();
    ids.day = day!.id;
    ids.night = night!.id;
    invalidatePrincipal(adm!.id);
    admin = (await loadPrincipal(adm!.id))!;
  });
  alice = (await loadPrincipal(ids.alice))!;
  bob = (await loadPrincipal(ids.bob))!;
  carol = (await loadPrincipal(ids.carol))!;
  portal = (await loadPrincipal(ids.portal))!;
  await asAdmin(async (ctx) => {
    const major = await createTicket(ctx, { type: 'incident', customerId: ids.customer, title: `Core router down ${S}`, description: 'Site offline', priorityId: ids.p1, assignedTeamId: ids.team, assigneeId: ids.alice });
    const p1 = await createTicket(ctx, { type: 'incident', customerId: ids.customer, title: `WAN flapping ${S}`, description: 'Links flapping', priorityId: ids.p1, assignedTeamId: ids.team, assigneeId: ids.bob });
    const un = await createTicket(ctx, { type: 'incident', customerId: ids.customer, title: `Printer offline ${S}`, description: 'Nobody looked yet', priorityId: ids.p3, assignedTeamId: ids.team });
    const elsewhere = await createTicket(ctx, { type: 'incident', customerId: ids.customer, title: `Other team ticket ${S}`, description: 'Not ours', priorityId: ids.p1, assignedTeamId: ids.other });
    created.tickets.push(major.id, p1.id, un.id, elsewhere.id);
    ids.major = major.id;
    ids.p1Ticket = p1.id;
    ids.unassigned = un.id;
    await declareMajor(ctx, major.id, { commanderUserId: ids.alice, updateIntervalMinutes: 30 });
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.delete(schema.shiftHandovers).where(inArray(schema.shiftHandovers.teamId, [ids.team, ids.other]));
    await tx.delete(schema.notificationOutbox).where(eq(schema.notificationOutbox.event, 'handover.published'));
    if (created.tickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, created.tickets));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.alice, ids.bob, ids.carol, ids.portal]));
    await tx.delete(schema.teams).where(inArray(schema.teams.id, [ids.team, ids.other]));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
  });
  ai.setProviderForTests(null);
  await closeDb();
});

const shifts = [
  { id: 'd', name: 'Day', startTime: '08:00', endTime: '20:00', days: [1, 2, 3, 4, 5, 6, 7], timezone: 'Asia/Kolkata' },
  { id: 'n', name: 'Night', startTime: '20:00', endTime: '08:00', days: [1, 2, 3, 4, 5, 6, 7], timezone: 'Asia/Kolkata' },
];

describe('shift arithmetic', () => {
  it('finds the shift running now, the next one and the previous one in the team timezone', () => {
    // 10:00 IST on Wednesday 4 March 2026 = 04:30 UTC
    const at = new Date('2026-03-04T04:30:00Z');
    const { current, next } = currentAndNext(shifts, at);
    expect(current?.shift.name).toBe('Day');
    expect(current?.shiftDate).toBe('2026-03-04');
    expect(current?.startsAt.toISOString()).toBe('2026-03-04T02:30:00.000Z');
    expect(current?.endsAt.toISOString()).toBe('2026-03-04T14:30:00.000Z');
    expect(next?.shift.name).toBe('Night');
    expect(next?.startsAt.toISOString()).toBe('2026-03-04T14:30:00.000Z');
    // 02:00 IST: the night shift that started the evening before is still running
    const late = currentAndNext(shifts, new Date('2026-03-04T20:30:00Z'));
    expect(late.current?.shift.name).toBe('Night');
    expect(late.current?.shiftDate).toBe('2026-03-04');
    expect(late.current?.endsAt.toISOString()).toBe('2026-03-05T02:30:00.000Z');
    expect(late.next?.shift.name).toBe('Day');
    expect(late.next?.shiftDate).toBe('2026-03-05');
    const prev = previous(shifts, new Date('2026-03-04T14:35:00Z'));
    expect(prev?.shift.name).toBe('Day');
    expect(prev?.shiftDate).toBe('2026-03-04');
  });

  it('respects weekdays and skips inactive shifts', () => {
    const weekdaysOnly = [{ ...shifts[0]!, days: [1, 2, 3, 4, 5] }, { ...shifts[1]!, isActive: false }];
    // Saturday 7 March 2026, 10:00 IST
    const sat = currentAndNext(weekdaysOnly, new Date('2026-03-07T04:30:00Z'));
    expect(sat.current).toBeNull();
    expect(sat.next?.shiftDate).toBe('2026-03-09');
    expect(instancesBetween(weekdaysOnly, new Date('2026-03-02T00:00:00Z'), new Date('2026-03-09T00:00:00Z')).map((i) => i.shiftDate)).toEqual(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']);
  });
});

describe('shifts', () => {
  it('only people who manage on-call edit a team\'s shifts', async () => {
    await expect(asAlice((ctx) => handover.createShift(ctx, { teamId: ids.team, name: 'Evening', startTime: '16:00', endTime: '00:00', days: [1, 2, 3, 4, 5], timezone: 'UTC', sortOrder: 15, isActive: true }))).rejects.toThrow(/permission/i);
    const s = await asAdmin((ctx) => handover.createShift(ctx, { teamId: ids.team, name: 'Evening', startTime: '16:00', endTime: '00:00', days: [5, 5, 1], timezone: 'UTC', sortOrder: 15, isActive: false }));
    expect(s.days).toEqual([1, 5]);
    await expect(asAdmin((ctx) => handover.updateShift(ctx, s.id, { timezone: 'Mars/Olympus' }))).rejects.toThrow(/timezone/i);
    const u = await asAdmin((ctx) => handover.updateShift(ctx, s.id, { name: 'Evening cover', isActive: false }));
    expect(u.name).toBe('Evening cover');
    const list = await asAlice((ctx) => handover.listShifts(ctx, ids.team));
    expect(list.items.map((x) => x.name)).toEqual(['Day', 'Evening cover', 'Night']);
    await asAdmin((ctx) => handover.deleteShift(ctx, s.id));
    expect((await asAlice((ctx) => handover.listShifts(ctx, ids.team))).items.length).toBe(2);
  });

  it('lists teams with the running shift, the next one and whether the person may write', async () => {
    const teams = await asAlice((ctx) => handover.listTeams(ctx, new Date()));
    const mine = teams.items.find((t) => t.id === ids.team)!;
    expect(mine.canWrite).toBe(true);
    expect(mine.shifts.length).toBe(2);
    expect(mine.current?.name).toMatch(/Day|Night/);
    expect(mine.next?.name).toMatch(/Day|Night/);
    expect(mine.next!.startsAt.getTime()).toBe(mine.current!.endsAt.getTime());
    expect(teams.items[0]!.id).toBe(ids.team); // own teams first
    const theirs = teams.items.find((t) => t.id === ids.other)!;
    expect(theirs.canWrite).toBe(false);
    await expect(asPortal((ctx) => handover.listTeams(ctx))).rejects.toThrow(/internal|permission/i);
  });
});

describe('digest and draft', () => {
  it('counts what the team has open, P1/P2, unassigned and major, with the lists behind the numbers', async () => {
    const d = await asAlice((ctx) => handover.digest(ctx, ids.team));
    expect(d.team.name).toBe(`Handover NOC ${S}`);
    expect(d.counts.open).toBe(3);
    expect(d.counts.p1p2).toBe(2);
    expect(d.counts.unassigned).toBe(1);
    expect(d.counts.major).toBeGreaterThanOrEqual(1);
    expect(d.counts.openedInShift).toBe(3);
    const p1p2 = d.tickets.find((l) => l.key === 'p1p2')!;
    expect(p1p2.items.map((t) => t.id).sort()).toEqual([ids.major, ids.p1Ticket].sort());
    expect(p1p2.items.every((t) => t.customer === `Handover Customer ${S}`)).toBe(true);
    expect(d.tickets.find((l) => l.key === 'unassigned')!.items[0]!.id).toBe(ids.unassigned);
    expect(d.major.some((m) => m.id === ids.major && m.commander === alice.name)).toBe(true);
    expect(d.onCall.now).toEqual([]);
    // the other team's P1 never leaks into this digest
    expect(d.tickets.flatMap((l) => l.items).some((t) => t.title.startsWith('Other team'))).toBe(false);
  });

  it('drafts the note from the facts without a provider and from the model with one', async () => {
    const d = await asAlice((ctx) => handover.draft(ctx, { teamId: ids.team, notes: 'Vendor callback at 21:00.' }));
    expect(d.ai).toBe(false);
    expect(d.body).toContain('## Watch first');
    expect(d.body).toContain('## On call');
    expect(d.body).toContain('Vendor callback at 21:00.');
    const major = await withSystem((tx) => tx.select({ number: schema.tickets.number }).from(schema.tickets).where(eq(schema.tickets.id, ids.major)).limit(1));
    expect(d.body).toContain(major[0]!.number);
    expect(d.body).toContain('3 open tickets: 2 P1/P2');
    expect(renderHandover(d.facts, null)).toContain('## Notes\nNone');
    ai.setProviderForTests({ name: 'fake', model: 'fake-1', chat: async () => json({ body: '## Watch first\n- INC-000001 the model wrote this\n\n## Open and at risk\n3 open\n\n## Major incidents\nNone\n\n## Scheduled next\nNothing scheduled\n\n## On call\nNobody\n\n## Notes\nVendor callback at 21:00.' }) });
    try {
      const m = await asAlice((ctx) => handover.draft(ctx, { teamId: ids.team, notes: 'Vendor callback at 21:00.' }));
      expect(m.ai).toBe(true);
      expect(m.body).toContain('the model wrote this');
      // the feature switch turns the model off again
      await withSystem((tx) => tx.update(schema.systemSettings).set({ value: ['handover'] }).where(eq(schema.systemSettings.key, 'ai.disabled_features')));
      const off = await asAlice((ctx) => handover.draft(ctx, { teamId: ids.team }));
      expect(off.ai).toBe(false);
    } finally {
      await withSystem((tx) => tx.update(schema.systemSettings).set({ value: [] }).where(eq(schema.systemSettings.key, 'ai.disabled_features')));
      ai.setProviderForTests({ name: 'none', model: 'none', chat: async () => json({}) });
    }
    // only members (or on-call managers) draft for a team
    await expect(asCarol((ctx) => handover.draft(ctx, { teamId: ids.team }))).rejects.toThrow(/members of the team/);
  });
});

describe('handovers', () => {
  it('publishes to the incoming shift (every member but the author when nobody is on a rota) and records the audit trail', async () => {
    const d = await asAlice((ctx) => handover.draft(ctx, { teamId: ids.team }));
    const draft = await asAlice((ctx) => handover.create(ctx, { teamId: ids.team, body: d.body, aiDraft: null, facts: d.facts, publish: false }));
    created.handovers.push(draft.id);
    expect(draft.status).toBe('draft');
    expect(draft.shiftName).toMatch(/Day|Night/);
    expect(draft.authorName).toBe(alice.name);
    expect(draft.facts?.counts.open).toBe(3);
    // bob may not edit alice's draft, alice may
    await expect(asBob((ctx) => handover.update(ctx, draft.id, { body: 'x' }))).rejects.toThrow(/author/);
    const edited = await asAlice((ctx) => handover.update(ctx, draft.id, { body: `${d.body}\n\nAlso: check the UPS.` }));
    expect(edited.body).toContain('check the UPS');
    await expect(asBob((ctx) => handover.acknowledge(ctx, draft.id))).rejects.toThrow(/not been published/);
    const published = await asAlice((ctx) => handover.publish(ctx, draft.id));
    expect(published.status).toBe('final');
    expect(published.publishedAt).toBeTruthy();
    await expect(asAlice((ctx) => handover.update(ctx, draft.id, { body: 'late edit' }))).rejects.toThrow(/cannot be edited/);
    const mails = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'handover.published'), eq(schema.notificationOutbox.entityId, draft.id), eq(schema.notificationOutbox.channel, 'email'))));
    expect(mails.map((m) => m.recipient).sort()).toEqual([bob.email.toLowerCase()]);
    expect(mails[0]!.subject).toContain(`Handover NOC ${S}`);
    expect(mails[0]!.body).toContain('Watch first');
    const inApp = await withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ids.bob), eq(schema.notifications.event, 'handover.published'))));
    expect(inApp.length).toBe(1);
    expect(inApp[0]!.link).toContain(`/operations/handover?team=${ids.team}&handover=${draft.id}`);
    const audit = await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'shift_handover'), eq(schema.auditLog.entityId, draft.id))));
    expect(audit.map((a) => a.action).sort()).toEqual(['create', 'publish', 'update']);
    expect((audit.find((a) => a.action === 'publish')!.metadata as { via: string }).via).toBe('team');
  });

  it('the incoming engineer acknowledges once; the author and outsiders cannot', async () => {
    const id = created.handovers[0]!;
    await expect(asAlice((ctx) => handover.acknowledge(ctx, id, 'me'))).rejects.toThrow(/incoming shift/);
    await expect(asCarol((ctx) => handover.acknowledge(ctx, id))).rejects.toThrow(/members of the team/);
    const ack = await asBob((ctx) => handover.acknowledge(ctx, id, '  Taken over, watching the router first.  '));
    expect(ack.status).toBe('acknowledged');
    expect(ack.acknowledgedByName).toBe(bob.name);
    expect(ack.acknowledgementNote).toBe('Taken over, watching the router first.');
    await expect(asBob((ctx) => handover.acknowledge(ctx, id))).rejects.toThrow(/already acknowledged/);
    const teams = await asBob((ctx) => handover.listTeams(ctx));
    const mine = teams.items.find((t) => t.id === ids.team)!;
    expect(mine.latest?.status).toBe('acknowledged');
    expect(mine.unacknowledged).toBe(0);
    const list = await asCarol((ctx) => handover.list(ctx, { teamId: ids.team, status: 'acknowledged', page: 1, pageSize: 10 }));
    expect(list.total).toBe(1);
    expect(list.items[0]!.acknowledgedByName).toBe(bob.name);
    await expect(asPortal((ctx) => handover.get(ctx, id))).rejects.toThrow(/internal|permission/i);
  });

  it('a published handover stays unless a manager deletes it; drafts go with their author', async () => {
    const id = created.handovers[0]!;
    await expect(asAlice((ctx) => handover.remove(ctx, id))).rejects.toThrow(/kept/);
    const second = await asBob((ctx) => handover.create(ctx, { teamId: ids.team, body: 'Quiet shift.', publish: true }));
    created.handovers.push(second.id);
    expect(second.status).toBe('final');
    const unack = await asAlice((ctx) => handover.listTeams(ctx));
    expect(unack.items.find((t) => t.id === ids.team)!.unacknowledged).toBe(1);
    await expect(asAlice((ctx) => handover.create(ctx, { teamId: ids.team, body: '   ', publish: true }))).rejects.toThrow(/Write the handover/);
    const draft = await asAlice((ctx) => handover.create(ctx, { teamId: ids.team, body: 'scratch', publish: false }));
    await expect(asBob((ctx) => handover.remove(ctx, draft.id))).rejects.toThrow(/author/);
    await asAlice((ctx) => handover.remove(ctx, draft.id));
    await asAdmin((ctx) => handover.remove(ctx, id));
    const list = await asAlice((ctx) => handover.list(ctx, { teamId: ids.team, status: 'all', page: 1, pageSize: 10 }));
    expect(list.items.map((h) => h.id)).toEqual([second.id]);
  });

  it('the shift_handover tool reads the digest and the latest handover', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'shift_handover')!;
    expect(tool).toBeTruthy();
    expect(tool.action).toBe(false);
    const res = (await asAlice((ctx) => tool.run(ctx, { team: `ho_noc_${S}` }))) as { counts: { open: number }; facts: string[]; latestHandover: { status: string; author: string } | null; link: string };
    expect(res.counts.open).toBe(3);
    expect(res.facts[0]).toContain('3 open ticket(s), 2 P1/P2');
    expect(res.latestHandover?.status).toBe('final');
    expect(res.latestHandover?.author).toBe(bob.name);
    expect(res.link).toBe(`/operations/handover?team=${ids.team}`);
  });
});
