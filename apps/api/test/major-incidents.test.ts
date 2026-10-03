/**
 * Major incident workflow: declare and demote, stakeholder update fan-out, child incidents,
 * status sync with the ticket, the list and the overdue reminder. Run with the dev
 * environment sourced: npx vitest run test/major-incidents.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket, getTicket, resolveTicket, reopenTicket } from '../src/modules/tickets/service';
import { timeline } from '../src/modules/tickets/activity';
import { declareMajor, demoteMajor, getMajor, updateMajor, postMajorUpdate, addChild, listMajor, remindOverdueUpdates } from '../src/modules/tickets/major';
import { portalBanners } from '../src/modules/portal/service';
import { noc } from '../src/modules/dashboards/service';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-major-${S}`, ip: '127.0.0.1' };
let admin: Principal;
let engineer: Principal;
let portalUser: Principal;
const ids = { customer: '', site: '', p1: '', engineer: '', requester: '', contact: '', major: '', child: '', request: '' };
const created: string[] = [];
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asEngineer = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(engineer, meta, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalUser, meta, fn);

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
const outboxFor = (event: string, ticketId: string) => withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, event), eq(schema.notificationOutbox.entityId, ticketId))));

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [a] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    const [c] = await tx.insert(schema.customers).values({ code: `MI${S.toUpperCase()}`, name: `Major Customer ${S}`, timezone: 'Asia/Kolkata' }).returning();
    ids.customer = c!.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: c!.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.site = site!.id;
    // An engineer without tickets:major, a portal requester and a customer contact for the fan-out.
    const [eng] = await tx.insert(schema.users).values({ email: `mi-eng-${S}@example.test`, name: 'Plain Engineer', userType: 'msp', status: 'active' }).returning();
    await tx.insert(schema.userRoles).values({ userId: eng!.id, roleId: await roleId(tx, 'engineer'), customerId: c!.id });
    ids.engineer = eng!.id;
    const [req] = await tx.insert(schema.users).values({ email: `mi-req-${S}@example.test`, name: 'Requester', userType: 'customer', customerId: c!.id, status: 'active' }).returning();
    await tx.insert(schema.userRoles).values({ userId: req!.id, roleId: await roleId(tx, 'customer_user'), customerId: c!.id });
    ids.requester = req!.id;
    const [contact] = await tx.insert(schema.contacts).values({ customerId: c!.id, name: 'Ops Contact', email: `mi-contact-${S}@example.test`, isPrimary: true }).returning();
    ids.contact = contact!.id;
    invalidatePrincipal(a!.id);
    admin = (await loadPrincipal(a!.id))!;
  });
  // Principals read through their own connection, so the new users must be committed first.
  engineer = (await loadPrincipal(ids.engineer))!;
  portalUser = (await loadPrincipal(ids.requester))!;
  const t = await asAdmin((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customer, siteId: ids.site, title: `Core switch down ${S}`, description: 'Site-wide outage', priorityId: ids.p1, requesterUserId: ids.requester, assigneeId: ids.engineer }));
  ids.major = t.id;
  created.push(t.id);
  const child = await asAdmin((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customer, siteId: ids.site, title: `Wifi down in building B ${S}`, description: 'Symptom of the outage', priorityId: ids.p1 }));
  ids.child = child.id;
  created.push(child.id);
  const request = await asAdmin((ctx) => createTicket(ctx, { type: 'request', customerId: ids.customer, siteId: ids.site, title: `New laptop ${S}`, description: 'Not an incident' }));
  ids.request = request.id;
  created.push(request.id);
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (created.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, created));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.engineer, ids.requester]));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
  });
  await closeDb();
});

describe('declare and demote', () => {
  it('refuses a user without tickets:major and refuses a request', async () => {
    await expect(asEngineer((ctx) => declareMajor(ctx, ids.major, { reason: 'Site down' }))).rejects.toThrow(/tickets:major|permission|forbidden/i);
    await expect(asAdmin((ctx) => declareMajor(ctx, ids.request, {}))).rejects.toThrow(/Only incidents/);
  });

  it('declares: flags the ticket, opens the record with a cadence and notifies the response team', async () => {
    const m = await asAdmin((ctx) => declareMajor(ctx, ids.major, { reason: 'Site-wide outage', bridgeUrl: 'https://meet.example.com/bridge-1', updateIntervalMinutes: 15 }));
    expect(m.record?.status).toBe('active');
    expect(m.record?.bridgeUrl).toBe('https://meet.example.com/bridge-1');
    expect(m.record?.updateIntervalMinutes).toBe(15);
    expect(m.record?.nextUpdateDueAt).toBeTruthy();
    expect(m.record?.commanderUserId).toBe(ids.engineer); // defaults to the assignee
    const t = await asAdmin((ctx) => getTicket(ctx, ids.major));
    expect(t.isMajor).toBe(true);
    expect(t.major?.status).toBe('active');
    expect(t.permissions.major).toBe(true);
    const tl = await asAdmin((ctx) => timeline(ctx, ids.major));
    const declared = tl.items.find((i) => i.kind === 'activity' && i.type === 'major');
    expect(declared?.summary).toMatch(/Declared a major incident: Site-wide outage/);
    expect(declared?.customerVisible).toBe(true);
    // The seeded rule notifies the assignee, the team, its manager, the account manager and the operations managers.
    const rows = await outboxFor('incident.major_declared', ids.major);
    expect(rows.map((r) => r.recipient)).toContain(`mi-eng-${S}@example.test`);
    expect(rows.every((r) => r.channel === 'email')).toBe(true);
    expect(rows.some((r) => r.subject?.includes('MAJOR INCIDENT'))).toBe(true);
  });

  it('is idempotent: declaring twice is refused while active', async () => {
    await expect(asAdmin((ctx) => declareMajor(ctx, ids.major, {}))).rejects.toThrow(/already a major incident/);
  });

  it('rejects a commander who is not active MSP staff', async () => {
    await expect(asAdmin((ctx) => updateMajor(ctx, ids.major, { commanderUserId: ids.requester }))).rejects.toThrow(/active staff member/);
  });
});

describe('stakeholder updates', () => {
  it('sends a stakeholder update to the chosen audience, logs it and resets the cadence', async () => {
    const before = await asAdmin((ctx) => getMajor(ctx, ids.major));
    const u = await asAdmin((ctx) => postMajorUpdate(ctx, ids.major, { body: 'Core switch replaced, services recovering. Next update in 15 minutes.', audience: { requester: true, customerContacts: true }, channels: ['email', 'in_app'], portalBanner: true }));
    expect(u.kind).toBe('stakeholder');
    expect(u.sentCount).toBeGreaterThanOrEqual(2); // requester (email + in-app counts once per channel) and the contact
    const rows = await outboxFor('incident.major_update', ids.major);
    const recipients = rows.map((r) => r.recipient).sort();
    expect(recipients).toContain(`mi-req-${S}@example.test`);
    expect(recipients).toContain(`mi-contact-${S}@example.test`);
    expect(rows.some((r) => r.body.includes('Core switch replaced'))).toBe(true);
    const inApp = await withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ids.requester), eq(schema.notifications.event, 'incident.major_update'))));
    expect(inApp.length).toBe(1);
    const after = await asAdmin((ctx) => getMajor(ctx, ids.major));
    expect(after.record?.lastUpdateAt).toBeTruthy();
    expect(after.record!.nextUpdateDueAt!.getTime()).toBeGreaterThan(before.record!.nextUpdateDueAt!.getTime() - 1);
    expect(after.updates[0]?.body).toMatch(/Core switch replaced/);
    expect(after.updates[0]?.audience).toEqual({ requester: true, customerContacts: true });
  });

  it('a bridge note joins the log without notifying anyone', async () => {
    const before = (await outboxFor('incident.major_update', ids.major)).length;
    const u = await asAdmin((ctx) => postMajorUpdate(ctx, ids.major, { body: 'Vendor engineer joined the bridge', kind: 'internal' }));
    expect(u.sentCount).toBe(0);
    expect((await outboxFor('incident.major_update', ids.major)).length).toBe(before);
    const tl = await asAdmin((ctx) => timeline(ctx, ids.major));
    const note = tl.items.find((i) => i.kind === 'activity' && i.type === 'major_update' && /Bridge note/.test(i.summary ?? ''));
    expect(note?.customerVisible).toBe(false);
  });

  it('shows the customer a portal banner with the latest stakeholder update', async () => {
    const b = await asPortal((ctx) => portalBanners(ctx));
    const mine = b.items.find((i) => i.ticketId === ids.major);
    expect(mine?.latestUpdate?.body).toMatch(/Core switch replaced/);
    // Hidden once the banner is switched off.
    await asAdmin((ctx) => updateMajor(ctx, ids.major, { portalBanner: false }));
    expect((await asPortal((ctx) => portalBanners(ctx))).items.find((i) => i.ticketId === ids.major)).toBeUndefined();
    await asAdmin((ctx) => updateMajor(ctx, ids.major, { portalBanner: true }));
  });

  it('reminds the communications lead once when an update is overdue', async () => {
    await asAdmin((ctx) => updateMajor(ctx, ids.major, { commsLeadUserId: admin.id }));
    await withSystem((tx) => tx.update(schema.majorIncidents).set({ nextUpdateDueAt: new Date(Date.now() - 10 * 60_000) }).where(eq(schema.majorIncidents.ticketId, ids.major)));
    const first = await remindOverdueUpdates();
    expect(first).toBeGreaterThanOrEqual(1);
    const rows = await outboxFor('incident.major_update_due', ids.major);
    expect(rows.length).toBe(1);
    expect(rows[0]!.subject).toMatch(/overdue by \d+ min/);
    // The same missed slot is not reminded twice.
    await remindOverdueUpdates();
    expect((await outboxFor('incident.major_update_due', ids.major)).length).toBe(1);
    expect((await asAdmin((ctx) => getMajor(ctx, ids.major))).record?.overdue).toBe(true);
  });
});

describe('children, list and dashboard', () => {
  it('links a child incident visible from both ends', async () => {
    const m = await asAdmin((ctx) => addChild(ctx, ids.major, { ticketId: ids.child }));
    expect(m.children.map((c) => c.id)).toEqual([ids.child]);
    const child = await asAdmin((ctx) => getTicket(ctx, ids.child));
    expect(child.links.some((l) => l.linkType === 'child_of' && l.ticket.id === ids.major)).toBe(true);
    await expect(asAdmin((ctx) => addChild(ctx, ids.major, { ticketId: ids.major }))).rejects.toThrow(/own child/);
  });

  it('lists active incidents first with counts and an overdue flag', async () => {
    const list = await asAdmin((ctx) => listMajor(ctx, { status: 'active', q: S }));
    const row = list.items.find((r) => r.ticketId === ids.major);
    expect(row).toBeTruthy();
    expect(row!.childrenCount).toBe(1);
    expect(row!.updatesCount).toBe(1); // bridge notes are not stakeholder updates
    expect(row!.overdue).toBe(true);
    expect(row!.commsLeadName).toBeTruthy();
    expect(list.summary.active).toBeGreaterThanOrEqual(1);
    expect(list.summary.overdue).toBeGreaterThanOrEqual(1);
    await expect(asPortal((ctx) => listMajor(ctx, {}))).rejects.toThrow();
  });

  it('shows up on the NOC dashboard', async () => {
    const d = await asAdmin((ctx) => noc(ctx));
    const mine = d.majorIncidents.find((m) => m.id === ids.major);
    expect(mine?.children).toBe(1);
    expect(mine?.overdue).toBe(true);
  });
});

describe('resolution and review', () => {
  it('resolving the ticket resolves the major record, stops the cadence and notifies stakeholders', async () => {
    await asAdmin((ctx) => resolveTicket(ctx, ids.major, { resolutionNotes: 'Faulty line card replaced' }));
    const m = await asAdmin((ctx) => getMajor(ctx, ids.major));
    expect(m.record?.status).toBe('resolved');
    expect(m.record?.resolvedAt).toBeTruthy();
    expect(m.record?.nextUpdateDueAt).toBeNull();
    const rows = await outboxFor('incident.major_resolved', ids.major);
    expect(rows.map((r) => r.recipient)).toContain(`mi-req-${S}@example.test`);
    expect(rows.some((r) => r.body.includes('Faulty line card replaced'))).toBe(true);
    // The overdue reminder leaves resolved incidents alone.
    expect((await outboxFor('incident.major_update_due', ids.major)).length).toBe(1);
    await remindOverdueUpdates();
    expect((await outboxFor('incident.major_update_due', ids.major)).length).toBe(1);
  });

  it('reopening the ticket re-activates the major record', async () => {
    await asAdmin((ctx) => reopenTicket(ctx, ids.major, { comment: 'Outage recurred' }));
    const m = await asAdmin((ctx) => getMajor(ctx, ids.major));
    expect(m.record?.status).toBe('active');
    expect(m.record?.nextUpdateDueAt).toBeTruthy();
    await asAdmin((ctx) => updateMajor(ctx, ids.major, { status: 'resolved' }));
  });

  it('records the post-incident review with owned actions and completes it', async () => {
    const m = await asAdmin((ctx) => updateMajor(ctx, ids.major, { pirWhatHappened: 'Line card failed at 09:10; failover did not engage.', pirImpact: 'Site offline 42 minutes', pirRootCause: 'Stale failover config after the firmware upgrade', pirActions: [{ id: 'a1', text: 'Audit failover config on all core switches', ownerId: admin.id, dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), done: false }], status: 'review_done' }));
    expect(m.record?.status).toBe('review_done');
    expect(m.record?.pirCompletedAt).toBeTruthy();
    expect(m.record?.pirActions[0]?.ownerName).toBe(admin.name);
    const list = await asAdmin((ctx) => listMajor(ctx, { status: 'review_done', q: S }));
    expect(list.items.some((r) => r.ticketId === ids.major)).toBe(true);
  });
});

describe('demote', () => {
  it('drops the flag and the banner, keeps the record for the audit trail', async () => {
    const t = await asAdmin((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.customer, siteId: ids.site, title: `False alarm ${S}`, description: 'Monitoring blip', priorityId: ids.p1, isMajor: true }));
    created.push(t.id);
    expect(t.isMajor).toBe(true); // flagged at creation goes through the same declare path
    expect((await asAdmin((ctx) => getMajor(ctx, t.id))).record?.status).toBe('active');
    const m = await asAdmin((ctx) => demoteMajor(ctx, t.id, { reason: 'Single switch, not a site outage' }));
    expect(m.record?.status).toBe('demoted');
    expect(m.record?.portalBanner).toBe(false);
    expect(m.record?.demotedAt).toBeTruthy();
    const fresh = await asAdmin((ctx) => getTicket(ctx, t.id));
    expect(fresh.isMajor).toBe(false);
    expect(fresh.major?.status).toBe('demoted');
    await expect(asAdmin((ctx) => postMajorUpdate(ctx, t.id, { body: 'x' }))).rejects.toThrow(/not a major incident/);
    await expect(asAdmin((ctx) => demoteMajor(ctx, t.id, {}))).rejects.toThrow(/not a major incident/);
    expect((await asAdmin((ctx) => listMajor(ctx, { status: 'active', q: S }))).items.some((r) => r.ticketId === t.id)).toBe(false);
    // Re-declaring re-activates the same record.
    const again = await asAdmin((ctx) => declareMajor(ctx, t.id, { reason: 'It spread after all' }));
    expect(again.record?.status).toBe('active');
    expect(again.record?.demotedAt).toBeNull();
  });
});
