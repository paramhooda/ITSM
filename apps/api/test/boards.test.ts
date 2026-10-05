/**
 * Task boards: the ticket board (lanes by status or by assignee, the scope
 * rules, the SOC fence, the task progress and the per-customer action flags),
 * the task board (overdue state, the team scope through the ticket's team,
 * the due filter, the done window), the task reorder under savepoints, the
 * sticky notes (author-only, in the service and in the row-level policy, the
 * nightly purge), the shift handover panel composed from the handover module,
 * the refusals the ticket routes raise for a move the board must snap back,
 * the customer-user fence on every function, the assistant tools and the
 * settings loader.
 * Run with the dev environment sourced: npx vitest run test/boards.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket, resolveTicket, closeTicket, changeStatus } from '../src/modules/tickets/service';
import { createTask, updateTask } from '../src/modules/tickets/activity';
import * as handover from '../src/modules/handover/service';
import * as boards from '../src/modules/boards/service';
import { toolByName, availableTools } from '../src/modules/ai/tools';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-boards-${S}`, ip: '127.0.0.1' };
const DAY = 86_400_000;
let admin: Principal;
let alice: Principal;
let bob: Principal;
let carol: Principal;
let dana: Principal;
let portal: Principal;
const ids = { customer: '', team: '', other: '', alice: '', bob: '', carol: '', dana: '', portal: '', p1: '', p3: '', inProgress: '', pendingCustomer: '', resolved: '', closed: '', inFulfilment: '', underInvestigation: '', a1: '', a2: '', b1: '', u1: '', r1: '', c1: '', q1: '', s1: '', tCheck: '', tCall: '', tPsu: '', tTriage: '' };
const created = { tickets: [] as string[] };
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asAlice = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(alice, meta, fn);
const asBob = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(bob, meta, fn);
const asCarol = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(carol, meta, fn);
const asDana = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(dana, meta, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portal, meta, fn);
const setSetting = (key: string, value: unknown) => withSystem((tx) => tx.update(schema.systemSettings).set({ value: value as never }).where(eq(schema.systemSettings.key, key)));
const none = undefined;

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing (seed not applied?)`);
  return row.id;
}
async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}/${key} missing`);
  return row.id;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adm] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    const [c] = await tx.insert(schema.customers).values({ code: `BO${S.toUpperCase()}`, name: `Boards Customer ${S}` }).returning();
    ids.customer = c!.id;
    const [team] = await tx.insert(schema.teams).values({ key: `bo_noc_${S}`, name: `Boards NOC ${S}`, teamType: 'noc' }).returning();
    const [other] = await tx.insert(schema.teams).values({ key: `bo_other_${S}`, name: `Boards Other ${S}`, teamType: 'network' }).returning();
    ids.team = team!.id;
    ids.other = other!.id;
    const mk = async (name: string, role: string) => {
      const [u] = await tx.insert(schema.users).values({ email: `bo-${name}-${S}@example.test`, name: `${name[0]!.toUpperCase()}${name.slice(1)} Boards`, userType: 'msp', status: 'active' }).returning();
      await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: await roleId(tx, role), customerId: null });
      return u!.id;
    };
    ids.alice = await mk('alice', 'noc_engineer');
    ids.bob = await mk('bob', 'noc_engineer');
    ids.carol = await mk('carol', 'engineer');
    ids.dana = await mk('dana', 'noc_manager');
    await tx.insert(schema.teamMembers).values([{ teamId: team!.id, userId: ids.alice }, { teamId: team!.id, userId: ids.bob, isLead: true }]);
    const [pu] = await tx.insert(schema.users).values({ email: `bo-portal-${S}@example.test`, name: 'Boards Portal', userType: 'customer', customerId: c!.id, status: 'active' }).returning();
    ids.portal = pu!.id;
    await tx.insert(schema.userRoles).values({ userId: pu!.id, roleId: await roleId(tx, 'customer_admin'), customerId: c!.id });
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p3 = await optionId(tx, 'ticket_priority', 'p3');
    ids.inProgress = await optionId(tx, 'ticket_status', 'in_progress');
    ids.pendingCustomer = await optionId(tx, 'ticket_status', 'pending_customer');
    ids.resolved = await optionId(tx, 'ticket_status', 'resolved');
    ids.closed = await optionId(tx, 'ticket_status', 'closed');
    ids.inFulfilment = await optionId(tx, 'ticket_status', 'in_fulfilment');
    ids.underInvestigation = await optionId(tx, 'ticket_status', 'under_investigation');
    await tx.insert(schema.teamShifts).values([
      { teamId: team!.id, name: 'Day', startTime: '08:00', endTime: '20:00', timezone: 'UTC', sortOrder: 10 },
      { teamId: team!.id, name: 'Night', startTime: '20:00', endTime: '08:00', timezone: 'UTC', sortOrder: 20 },
    ]);
    invalidatePrincipal(adm!.id);
    admin = (await loadPrincipal(adm!.id))!;
  });
  alice = (await loadPrincipal(ids.alice))!;
  bob = (await loadPrincipal(ids.bob))!;
  carol = (await loadPrincipal(ids.carol))!;
  dana = (await loadPrincipal(ids.dana))!;
  portal = (await loadPrincipal(ids.portal))!;
  await asAdmin(async (ctx) => {
    const mk = (title: string, over: Partial<Parameters<typeof createTicket>[1]> = {}) => createTicket(ctx, { type: 'incident', customerId: ids.customer, title: `${title} ${S}`, description: 'Boards fixture', priorityId: ids.p3, assignedTeamId: ids.team, assigneeId: ids.alice, ...over });
    const a1 = await mk('Uplink flapping');
    const a2 = await mk('Core router down', { priorityId: ids.p1 });
    const b1 = await mk('PSU failed', { assigneeId: ids.bob });
    const u1 = await mk('Printer offline', { assigneeId: null });
    const r1 = await mk('VPN restored');
    const c1 = await mk('Old ticket');
    const q1 = await mk('New laptop', { type: 'request' });
    const s1 = await mk('Phishing report');
    created.tickets.push(a1.id, a2.id, b1.id, u1.id, r1.id, c1.id, q1.id, s1.id);
    Object.assign(ids, { a1: a1.id, a2: a2.id, b1: b1.id, u1: u1.id, r1: r1.id, c1: c1.id, q1: q1.id, s1: s1.id });
    await resolveTicket(ctx, r1.id, { resolutionNotes: 'Tunnel re-established' });
    await resolveTicket(ctx, c1.id, { resolutionNotes: 'Done long ago' });
    await closeTicket(ctx, c1.id, {});
    const tCheck = await createTask(ctx, a1.id, { title: 'Check uplink', assigneeId: ids.alice, dueAt: new Date(Date.now() - DAY) });
    const tCall = await createTask(ctx, a1.id, { title: 'Call vendor', assigneeId: ids.alice, status: 'in_progress' });
    const tPsu = await createTask(ctx, b1.id, { title: 'Replace PSU', assigneeId: ids.bob });
    const tTriage = await createTask(ctx, u1.id, { title: 'Triage', teamId: ids.team });
    Object.assign(ids, { tCheck: tCheck.id, tCall: tCall.id, tPsu: tPsu.id, tTriage: tTriage.id });
  });
  // The SOC ticket: the domain comes from the category or the service, so the fixture sets it directly.
  await withSystem((tx) => tx.update(schema.tickets).set({ domain: 'soc' }).where(eq(schema.tickets.id, ids.s1)));
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.delete(schema.boardNotes).where(inArray(schema.boardNotes.userId, [ids.alice, ids.bob, ids.carol, ids.dana]));
    await tx.delete(schema.shiftHandovers).where(inArray(schema.shiftHandovers.teamId, [ids.team, ids.other]));
    await tx.delete(schema.notificationOutbox).where(eq(schema.notificationOutbox.event, 'handover.published'));
    if (created.tickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, created.tickets));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.alice, ids.bob, ids.carol, ids.dana, ids.portal]));
    await tx.delete(schema.teams).where(inArray(schema.teams.id, [ids.team, ids.other]));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
  });
  await setSetting('boards.wip_default_limit', 8);
  await setSetting('boards.card_limit', 300);
  await closeDb();
});

const byNumberOf = (cards: { id: string }[]) => new Set(cards.map((c) => c.id));

describe('ticket board', () => {
  it('my board by status: the person\'s own tickets in every applicable lane, closed hidden, the SOC ticket fenced, task progress and action flags on each card', async () => {
    const b = await asAlice((ctx) => boards.ticketBoard(ctx, { scope: 'mine', lanes: 'status', includeClosed: none }));
    expect(b.board).toBe('tickets');
    expect(b.lanesBy).toBe('status');
    expect(b.truncated).toBe(false);
    const labels = b.lanes.map((l) => l.label);
    expect(labels).toEqual(expect.arrayContaining(['New', 'In Progress', 'Resolved']));
    expect(labels).not.toContain('Closed');
    expect(labels).not.toContain('Cancelled');
    expect(b.lanes.every((l) => l.kind === 'status' && l.limit === null)).toBe(true);
    const have = byNumberOf(b.cards);
    expect(have).toEqual(new Set([ids.a1, ids.a2, ids.q1, ids.r1]));
    expect(b.total).toBe(4);
    expect(b.statusesByType.incident).toContain(ids.inProgress);
    expect(b.statusesByType.incident).not.toContain(ids.inFulfilment);
    expect(b.statusesByType.request).toContain(ids.inFulfilment);
    expect(b.statusesByType.request).not.toContain(ids.underInvestigation);
    const a1 = b.cards.find((c) => c.id === ids.a1)!;
    expect(a1.tasks).toEqual({ total: 2, done: 0 });
    expect(a1.can).toEqual({ update: true, assign: true, resolve: true });
    expect(a1.lane).toBe(a1.status.id);
    expect(a1.ageMinutes).toBeGreaterThanOrEqual(0);
    expect(b.cards.find((c) => c.id === ids.r1)!.status.category).toBe('resolved');
    const newLane = b.lanes.find((l) => l.statusKey === 'new')!;
    expect(newLane.count).toBe(3);
    expect(newLane.open).toBe(3);
    expect(b.lanes.find((l) => l.statusKey === 'resolved')!.open).toBe(0);
    expect(b.settings).toEqual({ wipDefaultLimit: 8, cardLimit: 300 });
  });

  it('show closed adds the closed ticket and a Closed lane', async () => {
    const b = await asAlice((ctx) => boards.ticketBoard(ctx, { scope: 'mine', lanes: 'status', includeClosed: true }));
    expect(byNumberOf(b.cards).has(ids.c1)).toBe(true);
    const closed = b.lanes.find((l) => l.statusKey === 'closed')!;
    expect(closed).toBeDefined();
    expect(closed.count).toBe(1);
    expect(b.cards.find((c) => c.id === ids.c1)!.lane).toBe(ids.closed);
  });

  it('team board by assignee: Unassigned first, then the members with their open count against the WIP limit', async () => {
    const b = await asAlice((ctx) => boards.ticketBoard(ctx, { scope: 'team', teamId: ids.team, lanes: 'assignee', includeClosed: none }));
    expect(b.lanes.map((l) => l.label)).toEqual(['Unassigned', 'Alice Boards', 'Bob Boards']);
    expect(b.lanes.map((l) => l.count)).toEqual([1, 4, 1]);
    const me = b.lanes.find((l) => l.key === ids.alice)!;
    expect(me.open).toBe(3);
    expect(me.limit).toBe(8);
    expect(me.over).toBe(false);
    expect(b.lanes[0]!.limit).toBeNull();
    expect(b.cards.find((c) => c.id === ids.u1)!.lane).toBe('unassigned');
    expect(b.cards.find((c) => c.id === ids.b1)!.lane).toBe(ids.bob);
    // the team is the default when the person belongs to one
    const mine = await asAlice((ctx) => boards.ticketBoard(ctx, { scope: 'team', lanes: 'assignee', includeClosed: none }));
    expect(mine.total).toBe(b.total);
    // one person's board holds nothing unassigned, so it carries no Unassigned lane
    const own = await asAlice((ctx) => boards.ticketBoard(ctx, { scope: 'mine', lanes: 'assignee', includeClosed: none }));
    expect(own.lanes.map((l) => l.key)).toEqual([ids.alice]);
    const bobs = await asAlice((ctx) => boards.ticketBoard(ctx, { scope: 'assignee', assigneeId: ids.bob, lanes: 'assignee', includeClosed: none }));
    expect(bobs.lanes.map((l) => [l.key, l.count])).toEqual([[ids.bob, 1]]);
    expect(typeof b.dueSoon).toBe('number');
    expect(b.dueSoon).toBeLessThanOrEqual(b.total);
    await setSetting('boards.wip_default_limit', 2);
    try {
      const tight = await asAlice((ctx) => boards.ticketBoard(ctx, { scope: 'team', teamId: ids.team, lanes: 'assignee', includeClosed: none }));
      expect(tight.lanes.find((l) => l.key === ids.alice)!.over).toBe(true);
      expect(tight.lanes.find((l) => l.key === ids.bob)!.over).toBe(false);
      await setSetting('boards.wip_default_limit', 0);
      const off = await asAlice((ctx) => boards.ticketBoard(ctx, { scope: 'team', teamId: ids.team, lanes: 'assignee', includeClosed: none }));
      expect(off.lanes.find((l) => l.key === ids.alice)!.limit).toBeNull();
      expect(off.lanes.every((l) => !l.over)).toBe(true);
    } finally {
      await setSetting('boards.wip_default_limit', 8);
    }
  });

  it('the team scope needs a team, and a person without customer access sees an empty board', async () => {
    await expect(asCarol((ctx) => boards.ticketBoard(ctx, { scope: 'team', lanes: 'status', includeClosed: none }))).rejects.toThrow(/pick a team/i);
    await expect(asCarol((ctx) => boards.ticketBoard(ctx, { scope: 'assignee', lanes: 'status', includeClosed: none }))).rejects.toThrow(/pick an engineer/i);
    const empty = await asCarol((ctx) => boards.ticketBoard(ctx, { scope: 'mine', lanes: 'status', includeClosed: none }));
    expect(empty.cards).toEqual([]);
    expect(empty.total).toBe(0);
    const all = await asCarol((ctx) => boards.ticketBoard(ctx, { scope: 'all', lanes: 'assignee', includeClosed: none }));
    expect(all.cards.some((c) => created.tickets.includes(c.id))).toBe(false);
  });

  it('the SOC fence holds on the board: a NOC manager without soc:read never sees the security ticket, the administrator does', async () => {
    const d = await asDana((ctx) => boards.ticketBoard(ctx, { scope: 'team', teamId: ids.team, lanes: 'status', includeClosed: none }));
    expect(byNumberOf(d.cards).has(ids.s1)).toBe(false);
    expect(d.total).toBe(6);
    const a = await asAdmin((ctx) => boards.ticketBoard(ctx, { scope: 'team', teamId: ids.team, lanes: 'status', includeClosed: none }));
    expect(byNumberOf(a.cards).has(ids.s1)).toBe(true);
    expect(a.total).toBe(7);
    const one = await asAdmin((ctx) => boards.ticketBoard(ctx, { scope: 'assignee', assigneeId: ids.bob, lanes: 'status', includeClosed: none }));
    expect(byNumberOf(one.cards)).toEqual(new Set([ids.b1]));
    const typed = await asAdmin((ctx) => boards.ticketBoard(ctx, { scope: 'team', teamId: ids.team, lanes: 'status', type: 'request', includeClosed: none }));
    expect(byNumberOf(typed.cards)).toEqual(new Set([ids.q1]));
    expect(typed.lanes.map((l) => l.statusKey)).toContain('in_fulfilment');
    expect(typed.lanes.map((l) => l.statusKey)).not.toContain('under_investigation');
  });

  it('a move the record refuses is refused for the board too: a status that does not apply, a resolution without notes, a ticket out of sight', async () => {
    await expect(asAlice((ctx) => changeStatus(ctx, ids.q1, { statusId: ids.underInvestigation }))).rejects.toThrow(/does not apply/);
    await expect(asAlice((ctx) => changeStatus(ctx, ids.a1, { statusId: ids.resolved }))).rejects.toThrow(/Resolution notes are required/);
    await expect(asCarol((ctx) => changeStatus(ctx, ids.a1, { statusId: ids.inProgress }))).rejects.toThrow(/not found/i);
    const b = await asAlice((ctx) => boards.ticketBoard(ctx, { scope: 'mine', lanes: 'status', includeClosed: none }));
    expect(b.cards.find((c) => c.id === ids.q1)!.status.key).toBe('new');
    expect(b.cards.find((c) => c.id === ids.a1)!.status.key).toBe('new');
  });
});

describe('task board', () => {
  it('my tasks by lane with the overdue state; the team scope reaches tasks through the ticket\'s team; the due filter and the done window', async () => {
    const mine = await asAlice((ctx) => boards.taskBoard(ctx, { scope: 'mine', lanes: 'status', due: 'any', includeDone: none }));
    expect(mine.board).toBe('tasks');
    expect(mine.cards.map((c) => c.title).sort()).toEqual(['Call vendor', 'Check uplink']);
    const check = mine.cards.find((c) => c.title === 'Check uplink')!;
    expect(check.overdue).toBe(true);
    expect(check.lane).toBe('open');
    expect(check.ticketNumber).toBeTruthy();
    expect(check.ticketStatus.key).toBe('new');
    expect(check.can.update).toBe(true);
    expect(mine.cards.find((c) => c.title === 'Call vendor')!.lane).toBe('in_progress');
    expect(mine.lanes.map((l) => [l.label, l.count])).toEqual([['Open', 1], ['In progress', 1], ['Done', 0]]);
    expect(mine.lanes.find((l) => l.key === 'open')!.open).toBe(1);
    expect(mine.overdue).toBe(1);
    expect(mine.dueSoon).toBe(0);
    // a person's board by assignee has no Unassigned lane
    const ownLanes = await asAlice((ctx) => boards.taskBoard(ctx, { scope: 'mine', lanes: 'assignee', due: 'any', includeDone: none }));
    expect(ownLanes.lanes.map((l) => l.key)).toEqual([ids.alice]);
    const team = await asAlice((ctx) => boards.taskBoard(ctx, { scope: 'team', teamId: ids.team, lanes: 'status', due: 'any', includeDone: none }));
    expect(team.cards.map((c) => c.title).sort()).toEqual(['Call vendor', 'Check uplink', 'Replace PSU', 'Triage']);
    expect(team.total).toBe(4);
    const people = await asAlice((ctx) => boards.taskBoard(ctx, { scope: 'team', teamId: ids.team, lanes: 'assignee', due: 'any', includeDone: none }));
    expect(people.lanes.map((l) => [l.label, l.count, l.open])).toEqual([['Unassigned', 1, 1], ['Alice Boards', 2, 2], ['Bob Boards', 1, 1]]);
    const overdue = await asAlice((ctx) => boards.taskBoard(ctx, { scope: 'team', teamId: ids.team, lanes: 'status', due: 'overdue', includeDone: none }));
    expect(overdue.cards.map((c) => c.title)).toEqual(['Check uplink']);
    const searched = await asAlice((ctx) => boards.taskBoard(ctx, { scope: 'team', teamId: ids.team, lanes: 'status', due: 'any', q: 'psu', includeDone: none }));
    expect(searched.cards.map((c) => c.title)).toEqual(['Replace PSU']);
    await asAlice((ctx) => updateTask(ctx, ids.a1, ids.tCall, { status: 'done' }));
    const withDone = await asAlice((ctx) => boards.taskBoard(ctx, { scope: 'mine', lanes: 'status', due: 'any', includeDone: true }));
    expect(withDone.cards.find((c) => c.title === 'Call vendor')!.lane).toBe('done');
    expect(withDone.lanes.map((l) => l.label)).toEqual(['Open', 'In progress', 'Done', 'Cancelled']);
    expect(withDone.lanes.find((l) => l.key === 'done')!.count).toBe(1);
    // a task done within the last seven days still shows without the switch; the Cancelled lane does not
    const recent = await asAlice((ctx) => boards.taskBoard(ctx, { scope: 'mine', lanes: 'status', due: 'any', includeDone: none }));
    expect(recent.cards.find((c) => c.title === 'Call vendor')!.lane).toBe('done');
    expect(recent.lanes.map((l) => l.label)).toEqual(['Open', 'In progress', 'Done']);
    // customer users and the SOC fence apply to tasks too
    const d = await asDana((ctx) => boards.taskBoard(ctx, { scope: 'all', lanes: 'status', due: 'any', includeDone: none }));
    expect(d.cards.some((c) => c.ticketId === ids.s1)).toBe(false);
  });

  it('reorders and moves tasks item by item: a foreign task fails on its own, a person without sight of the ticket changes nothing', async () => {
    const res = await asAlice((ctx) => boards.reorderTasks(ctx, [
      { taskId: ids.tCheck, ticketId: ids.a1, status: 'in_progress', sortOrder: 0 },
      { taskId: ids.tCall, ticketId: ids.a1, status: 'in_progress', sortOrder: 1 },
    ]));
    expect(res).toEqual({ ok: true, updated: 2, failed: [] });
    const rows = await withSystem((tx) => tx.select().from(schema.ticketTasks).where(inArray(schema.ticketTasks.id, [ids.tCheck, ids.tCall])));
    expect(rows.every((r) => r.status === 'in_progress' && r.completedAt === null)).toBe(true);
    expect(rows.find((r) => r.id === ids.tCheck)!.sortOrder).toBe(0);
    expect(rows.find((r) => r.id === ids.tCall)!.sortOrder).toBe(1);
    const audits = await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, ids.a1), eq(schema.auditLog.action, 'task.update'))));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const mixed = await asAlice((ctx) => boards.reorderTasks(ctx, [
      { taskId: '00000000-0000-0000-0000-00000000beef', ticketId: ids.a1, sortOrder: 5 },
      { taskId: ids.tPsu, ticketId: ids.b1, sortOrder: 3 },
    ]));
    expect(mixed.updated).toBe(1);
    expect(mixed.failed).toHaveLength(1);
    expect(mixed.failed[0]!.error).toMatch(/not found/i);
    expect((await withSystem((tx) => tx.select().from(schema.ticketTasks).where(eq(schema.ticketTasks.id, ids.tPsu))))[0]!.sortOrder).toBe(3);
    const outsider = await asCarol((ctx) => boards.reorderTasks(ctx, [{ taskId: ids.tCheck, ticketId: ids.a1, sortOrder: 9 }]));
    expect(outsider.updated).toBe(0);
    expect(outsider.failed[0]!.error).toMatch(/not found|permission/i);
    expect((await withSystem((tx) => tx.select().from(schema.ticketTasks).where(eq(schema.ticketTasks.id, ids.tCheck))))[0]!.sortOrder).toBe(0);
  });
});

describe('sticky notes', () => {
  it('belong to their author: listed pinned first, invisible to anyone else (service and row-level policy), purged after the retention when done', async () => {
    const first = await asAlice((ctx) => boards.createNote(ctx, { board: 'tickets', body: 'Vendor callback 16:00', color: 'amber', pinned: true, teamId: null }));
    const second = await asAlice((ctx) => boards.createNote(ctx, { board: 'tickets', body: 'Check the backup job', color: 'blue', pinned: false }));
    expect(first.shiftDate).toBe(new Date().toISOString().slice(0, 10));
    expect(first.userId).toBe(ids.alice);
    const list = await asAlice((ctx) => boards.listNotes(ctx, { board: 'tickets', includeDone: none }));
    expect(list.items.map((n) => n.body)).toEqual(['Vendor callback 16:00', 'Check the backup job']);
    expect((await asAlice((ctx) => boards.listNotes(ctx, { board: 'tasks', includeDone: none }))).items).toEqual([]);
    expect((await asBob((ctx) => boards.listNotes(ctx, { board: 'tickets', includeDone: none }))).items).toEqual([]);
    await expect(asBob((ctx) => boards.updateNote(ctx, first.id, { done: true }))).rejects.toThrow(/not found/i);
    await expect(asBob((ctx) => boards.deleteNote(ctx, first.id))).rejects.toThrow(/not found/i);
    // the row-level policy alone hides the rows from staff without tenant:all, even without the service predicate,
    // and refuses a note written in someone else's name; tenant:all staff rely on the service predicate above
    const raw = await asCarol((ctx) => ctx.tx.select().from(schema.boardNotes).where(eq(schema.boardNotes.userId, ids.alice)));
    expect(raw).toEqual([]);
    await expect(asCarol((ctx) => ctx.tx.insert(schema.boardNotes).values({ userId: ids.alice, body: 'forged', board: 'tickets' }))).rejects.toThrow();
    const own = await asCarol((ctx) => boards.createNote(ctx, { board: 'tickets', body: 'Carol only', color: 'slate', pinned: false }));
    expect((await asCarol((ctx) => ctx.tx.select().from(schema.boardNotes))).map((n) => n.id)).toEqual([own.id]);
    await asCarol((ctx) => boards.deleteNote(ctx, own.id));
    // a team board note is listed on that board only
    const teamNote = await asAlice((ctx) => boards.createNote(ctx, { board: 'tickets', body: 'Team: watch the WAN', color: 'green', pinned: false, teamId: ids.team }));
    expect((await asAlice((ctx) => boards.listNotes(ctx, { board: 'tickets', teamId: ids.team, includeDone: none }))).items.map((n) => n.id)).toEqual([teamNote.id]);
    expect((await asAlice((ctx) => boards.listNotes(ctx, { board: 'tickets', includeDone: none }))).items.map((n) => n.id)).not.toContain(teamNote.id);
    await expect(asAlice((ctx) => boards.createNote(ctx, { board: 'tickets', body: 'x', color: 'amber', pinned: false, teamId: '00000000-0000-0000-0000-00000000beef' }))).rejects.toThrow(/unknown team/i);
    // done notes leave the default list and are purged after the retention
    const done = await asAlice((ctx) => boards.updateNote(ctx, second.id, { done: true, color: 'green' }));
    expect(done.done).toBe(true);
    expect(done.color).toBe('green');
    expect(done.doneAt).toBeInstanceOf(Date);
    // the retention clock starts when the note is marked done; a later edit does not restart it
    const repinned = await asAlice((ctx) => boards.updateNote(ctx, second.id, { pinned: true }));
    expect(repinned.doneAt!.getTime()).toBe(done.doneAt!.getTime());
    expect(repinned.updatedAt.getTime()).toBeGreaterThanOrEqual(done.updatedAt.getTime());
    expect((await asAlice((ctx) => boards.listNotes(ctx, { board: 'tickets', includeDone: none }))).items.map((n) => n.id)).toEqual([first.id]);
    expect((await asAlice((ctx) => boards.listNotes(ctx, { board: 'tickets', includeDone: true }))).items.map((n) => n.id)).toEqual([first.id, second.id]);
    const purged = await boards.purgeDoneNotes(new Date(Date.now() + 31 * DAY));
    expect(purged.deleted).toBeGreaterThanOrEqual(1);
    expect((await asAlice((ctx) => boards.listNotes(ctx, { board: 'tickets', includeDone: true }))).items.map((n) => n.id)).toEqual([first.id]);
    await asAlice((ctx) => boards.deleteNote(ctx, first.id));
    await asAlice((ctx) => boards.deleteNote(ctx, teamNote.id));
    expect((await asAlice((ctx) => boards.listNotes(ctx, { board: 'tickets', includeDone: true }))).items).toEqual([]);
    const audit = await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'board_note'), eq(schema.auditLog.entityId, first.id))));
    expect(audit.map((a) => a.action).sort()).toEqual(['create', 'delete']);
  });
});

describe('handover panel', () => {
  it('shows the running shift, the latest published handover with its Watch first section, who may acknowledge, and the acknowledgement once given', async () => {
    const before = await asAlice((ctx) => boards.handoverPanel(ctx, ids.team));
    expect(before.team.name).toBe(`Boards NOC ${S}`);
    expect(before.latest).toBeNull();
    expect(before.canWrite).toBe(true);
    expect(before.canAcknowledge).toBe(false);
    expect(before.unacknowledged).toBe(0);
    expect(before.current?.name).toMatch(/Day|Night/);
    expect(before.next?.name).toMatch(/Day|Night/);
    const published = await asBob((ctx) => handover.create(ctx, { teamId: ids.team, body: '## Watch first\n- Check the core router first\n\n## Notes\nQuiet shift.', publish: true }));
    expect(published.status).toBe('final');
    const mine = await asAlice((ctx) => boards.handoverPanel(ctx, ids.team));
    expect(mine.latest?.id).toBe(published.id);
    expect(mine.latest?.status).toBe('final');
    expect(mine.latest?.authorName).toBe(bob.name);
    expect(mine.latest?.watchFirst).toBe('- Check the core router first');
    expect(mine.latest?.body).toContain('Quiet shift.');
    expect(mine.unacknowledged).toBe(1);
    expect(mine.canAcknowledge).toBe(true);
    expect((await asBob((ctx) => boards.handoverPanel(ctx, ids.team))).canAcknowledge).toBe(false);
    // an on-call manager may acknowledge for a team she is not a member of; an outsider may not
    expect((await asDana((ctx) => boards.handoverPanel(ctx, ids.team))).canAcknowledge).toBe(true);
    const outsider = await asCarol((ctx) => boards.handoverPanel(ctx, ids.team));
    expect(outsider.canAcknowledge).toBe(false);
    expect(outsider.canWrite).toBe(false);
    await asAlice((ctx) => handover.acknowledge(ctx, published.id, 'Taken over'));
    const after = await asAlice((ctx) => boards.handoverPanel(ctx, ids.team));
    expect(after.latest?.status).toBe('acknowledged');
    expect(after.latest?.acknowledgedByName).toBe(alice.name);
    expect(after.latest?.acknowledgementNote).toBe('Taken over');
    expect(after.unacknowledged).toBe(0);
    expect(after.canAcknowledge).toBe(false);
    await expect(asCarol((ctx) => boards.handoverPanel(ctx, '00000000-0000-0000-0000-00000000beef'))).rejects.toThrow(/not found/i);
  });
});

describe('customer users', () => {
  it('are refused by every board function', async () => {
    const fence = /internal|permission/i;
    await expect(asPortal((ctx) => boards.ticketBoard(ctx, { scope: 'mine', lanes: 'status', includeClosed: none }))).rejects.toThrow(fence);
    await expect(asPortal((ctx) => boards.taskBoard(ctx, { scope: 'mine', lanes: 'status', due: 'any', includeDone: none }))).rejects.toThrow(fence);
    await expect(asPortal((ctx) => boards.reorderTasks(ctx, [{ taskId: ids.tCheck, ticketId: ids.a1, sortOrder: 0 }]))).rejects.toThrow(fence);
    await expect(asPortal((ctx) => boards.listNotes(ctx, { board: 'tickets', includeDone: none }))).rejects.toThrow(fence);
    await expect(asPortal((ctx) => boards.createNote(ctx, { board: 'tickets', body: 'x', color: 'amber', pinned: false }))).rejects.toThrow(fence);
    await expect(asPortal((ctx) => boards.handoverPanel(ctx, ids.team))).rejects.toThrow(fence);
    expect((await withSystem((tx) => tx.select().from(schema.boardNotes).where(eq(schema.boardNotes.userId, ids.portal))))).toEqual([]);
  });
});

describe('assistant tools', () => {
  it('my_board reports the person\'s lanes, the handover and the notes with exact facts; team_board names who is over the WIP limit; add_board_note previews and creates the note; none reaches the portal', async () => {
    const my = toolByName('my_board')!;
    expect(my.portal).toBeNull();
    expect(my.action).toBe(false);
    const res = (await asAlice((ctx) => my.run(ctx, {}))) as { total: number; facts: string[]; link: string; handover: { status: string; acknowledgedBy: string | null } | null; notes: unknown[]; lanes: { label: string; count: number }[] };
    expect(res.total).toBe(4);
    expect(res.facts[0]).toMatch(/^4 ticket\(s\) on your board: /);
    expect(res.facts[0]).toContain('3 new');
    expect(res.facts.some((f) => /^You are within the WIP limit \(3 open of 8\)$/.test(f))).toBe(true);
    expect(res.facts.some((f) => f.startsWith(`Latest Boards NOC ${S} handover:`) && f.includes(`acknowledged by ${alice.name}`))).toBe(true);
    expect(res.facts.some((f) => /^0 sticky note\(s\), 0 pinned$/.test(f))).toBe(true);
    expect(res.link.startsWith('/tickets/boards')).toBe(true);
    expect(res.handover?.status).toBe('acknowledged');
    expect(res.handover?.acknowledgedBy).toBe(alice.name);
    expect(res.notes).toEqual([]);
    const tasks = (await asAlice((ctx) => my.run(ctx, { board: 'tasks', limit: 5 }))) as { total: number; facts: string[]; link: string };
    expect(tasks.total).toBe(2);
    expect(tasks.facts[0]).toMatch(/^2 task\(s\) on your board: /);
    expect(tasks.link).toBe('/tickets/boards?board=tasks&scope=mine');

    const team = toolByName('team_board')!;
    expect(team.portal).toBeNull();
    await setSetting('boards.wip_default_limit', 2);
    try {
      const t = (await asDana((ctx) => team.run(ctx, { team: `bo_noc_${S}` }))) as { total: number; overCount: number; engineers: { name: string; open: number; over: boolean }[]; facts: string[]; link: string };
      expect(t.total).toBe(6);
      expect(t.overCount).toBe(1);
      expect(t.engineers.find((e) => e.name === alice.name)).toMatchObject({ open: 3, over: true });
      expect(t.facts.some((f) => f.startsWith('Over the WIP limit (2): Alice Boards (3)'))).toBe(true);
      expect(t.facts[0]).toContain(`Boards NOC ${S}: 6 ticket(s) on the board`);
      expect(t.facts[0]).toContain('1 unassigned');
      expect(t.link).toBe(`/tickets/boards?board=tickets&scope=team&teamId=${ids.team}&lanes=status`);
      const one = (await asDana((ctx) => team.run(ctx, { team: `bo_noc_${S}`, engineer: `bo-bob-${S}@example.test`, lanes: 'assignee' }))) as { total: number; engineer: string | null; link: string };
      expect(one.total).toBe(1);
      expect(one.engineer).toBe(bob.name);
      expect(one.link).toContain(`scope=assignee&assigneeId=${ids.bob}`);
    } finally {
      await setSetting('boards.wip_default_limit', 8);
    }
    await expect(asDana((ctx) => team.run(ctx, { team: `no-such-team-${S}` }))).rejects.toThrow(/no team/i);

    const add = toolByName('add_board_note')!;
    expect(add.action).toBe(true);
    expect(add.tier).toBe('write_low');
    expect(add.invalidates).toEqual(['boards']);
    expect(add.portal).toBeNull();
    const preview = await asAlice((ctx) => add.preview!(ctx, { body: 'Vendor calls back at four', pinned: true }));
    expect(typeof preview === 'string' ? preview : preview.text).toContain('Vendor calls back at four');
    expect(typeof preview === 'string' ? preview : preview.text).toContain('pinned');
    const out = (await asAlice((ctx) => add.run(ctx, { body: 'Vendor calls back at four', pinned: true }))) as { added: boolean; noteId: string; link: string; facts: string[] };
    expect(out.added).toBe(true);
    const row = await withSystem((tx) => tx.select().from(schema.boardNotes).where(eq(schema.boardNotes.id, out.noteId)));
    expect(row[0]).toMatchObject({ userId: ids.alice, body: 'Vendor calls back at four', pinned: true, board: 'tickets' });
    expect(out.link).toBe('/tickets/boards?board=tickets&scope=mine&panel=notes');
    const again = (await asAlice((ctx) => my.run(ctx, {}))) as { facts: string[]; notes: { pinned: boolean }[] };
    expect(again.facts.some((f) => /^1 sticky note\(s\), 1 pinned$/.test(f))).toBe(true);
    expect(again.notes).toEqual([{ body: 'Vendor calls back at four', color: 'amber', pinned: true, done: false }]);

    const offered = await asPortal(async (ctx) => availableTools(ctx).map((t) => t.name));
    for (const n of ['my_board', 'team_board', 'add_board_note']) expect(offered).not.toContain(n);
    const staff = await asAlice(async (ctx) => availableTools(ctx).map((t) => t.name));
    for (const n of ['my_board', 'team_board', 'add_board_note']) expect(staff).toContain(n);
  });
});

describe('settings', () => {
  it('the loader clamps every board setting to its range', async () => {
    await setSetting('boards.card_limit', 9999);
    await setSetting('boards.wip_default_limit', -1);
    try {
      const s = await withSystem((tx) => boards.loadBoardSettings(tx));
      expect(s.cardLimit).toBe(500);
      expect(s.wipDefaultLimit).toBe(0);
      expect(s.noteRetentionDays).toBe(30);
    } finally {
      await setSetting('boards.card_limit', 300);
      await setSetting('boards.wip_default_limit', 8);
    }
    const defaults = await withSystem((tx) => boards.loadBoardSettings(tx));
    expect(defaults).toEqual({ wipDefaultLimit: 8, cardLimit: 300, noteRetentionDays: 30 });
  });
});
