/**
 * Status page and announcements: announcements are shared rows whose
 * visibility follows audience and customer (row-level security plus the
 * service), only staff write them; the health job derives a business
 * service's health from a major incident on something it relies on and clears
 * it when the incident is demoted; the portal status page and the public,
 * token-only page carry the customer's own services and nothing internal; a
 * revoked token opens nothing; the drafted announcement falls back to a
 * template without a provider; Grady's create_announcement tool previews and
 * publishes. Run with the dev environment sourced: npx vitest run test/status.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, withTenant, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket } from '../src/modules/tickets/service';
import { declareMajor, demoteMajor, postMajorUpdate } from '../src/modules/tickets/major';
import * as cmdb from '../src/modules/cmdb/service';
import * as status from '../src/modules/status/service';
import { computeServiceHealth, healthOf } from '../src/modules/status/health';
import { draftAnnouncement } from '../src/modules/status/draft';
import { portalBanners } from '../src/modules/portal/service';
import { ALL_TOOLS } from '../src/modules/ai/tools';
import * as ai from '../src/modules/ai/service';
import type { ChatResponse } from '../src/lib/ai';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-status-${S}`, ip: '127.0.0.1' };
let admin: Principal;
let portalA: Principal;
let portalB: Principal;
const ids = { a: '', b: '', siteA: '', userA: '', userB: '', p1: '', bs: '', app: '', db: '', ticket: '' };
const types: Record<string, string> = {};
const relTypes: Record<string, string> = {};
const created = { announcements: [] as string[], tickets: [] as string[], tokens: [] as string[] };
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asA = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalA, meta, fn);
const asB = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalB, meta, fn);

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  return row!.id;
}
const json = (o: unknown): ChatResponse => ({ text: JSON.stringify(o), toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } });
const announce = (input: Parameters<typeof status.createAnnouncement>[1]) =>
  asAdmin(async (ctx) => {
    const a = await status.createAnnouncement(ctx, input);
    created.announcements.push(a.id);
    return a;
  });

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adm] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    const [a] = await tx.insert(schema.customers).values({ code: `SA${S.toUpperCase()}`, name: `Status Customer A ${S}`, timezone: 'Asia/Kolkata' }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: `SB${S.toUpperCase()}`, name: `Status Customer B ${S}`, timezone: 'Asia/Kolkata' }).returning();
    ids.a = a!.id;
    ids.b = b!.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: a!.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.siteA = site!.id;
    const [ua] = await tx.insert(schema.users).values({ email: `st-a-${S}@example.test`, name: 'Status Portal A', userType: 'customer', customerId: a!.id, status: 'active' }).returning();
    const [ub] = await tx.insert(schema.users).values({ email: `st-b-${S}@example.test`, name: 'Status Portal B', userType: 'customer', customerId: b!.id, status: 'active' }).returning();
    ids.userA = ua!.id;
    ids.userB = ub!.id;
    await tx.insert(schema.userRoles).values([
      { userId: ua!.id, roleId: await roleId(tx, 'customer_admin'), customerId: a!.id },
      { userId: ub!.id, roleId: await roleId(tx, 'customer_user'), customerId: b!.id },
    ]);
    for (const t of await tx.select().from(schema.ciTypes)) types[t.key] = t.id;
    for (const r of await tx.select().from(schema.ciRelationshipTypes)) relTypes[r.key] = r.id;
    const [p1] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_priority'), eq(schema.configOptions.key, 'p1'))).limit(1);
    ids.p1 = p1!.id;
    invalidatePrincipal(adm!.id);
    admin = (await loadPrincipal(adm!.id))!;
  });
  portalA = (await loadPrincipal(ids.userA))!;
  portalB = (await loadPrincipal(ids.userB))!;
  await withSystem((tx) => tx.insert(schema.systemSettings).values({ key: 'ai.disabled_features', value: [], description: 'test' }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: [] } }));
  ai.setProviderForTests({ name: 'none', model: 'none', chat: async () => json({}) });
});

afterAll(async () => {
  ai.setProviderForTests(null);
  await withSystem(async (tx) => {
    if (created.announcements.length) await tx.delete(schema.announcements).where(inArray(schema.announcements.id, created.announcements));
    if (created.tickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, created.tickets));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.userA, ids.userB]));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.a, ids.b]));
  });
  await closeDb();
});

describe('announcements', () => {
  it('are seen by audience and customer: everyone, customers of one organisation, staff only', async () => {
    const everyone = await announce({ title: `Everyone ${S}`, body: 'Portal and staff alike.', type: 'info' });
    const onlyA = await announce({ title: `Only A ${S}`, body: 'Aimed at customer A.', type: 'maintenance', audience: 'customers', customerIds: [ids.a] });
    const staff = await announce({ title: `Staff ${S}`, body: 'Internal notice.', audience: 'staff' });
    const later = await announce({ title: `Later ${S}`, body: 'Scheduled.', startsAt: new Date(Date.now() + 3600_000) });
    const titlesA = (await asA((ctx) => status.activeAnnouncements(ctx))).items.map((i) => i.title);
    expect(titlesA).toContain(everyone.title);
    expect(titlesA).toContain(onlyA.title);
    expect(titlesA).not.toContain(staff.title);
    expect(titlesA).not.toContain(later.title);
    const titlesB = (await asB((ctx) => status.activeAnnouncements(ctx))).items.map((i) => i.title);
    expect(titlesB).toContain(everyone.title);
    expect(titlesB).not.toContain(onlyA.title);
    expect(titlesB).not.toContain(staff.title);
    const titlesStaff = (await asAdmin((ctx) => status.activeAnnouncements(ctx))).items.map((i) => i.title);
    expect(titlesStaff).toContain(everyone.title);
    expect(titlesStaff).toContain(staff.title);
    expect(titlesStaff).not.toContain(onlyA.title);
    // The portal banners carry them next to the major incident notices.
    const banners = await asA((ctx) => portalBanners(ctx));
    expect(banners.items.filter((i) => i.kind === 'announcement').map((i) => i.title)).toContain(onlyA.title);
  });
  it('row-level security keeps a customer scope to its own and shared announcements, and refuses its writes', async () => {
    const seen = await withTenant({ userId: ids.userB, allCustomers: false, customerIds: [ids.b] }, (tx) => tx.select({ title: schema.announcements.title, audience: schema.announcements.audience }).from(schema.announcements).where(inArray(schema.announcements.id, created.announcements)));
    expect(seen.every((r) => r.audience !== 'staff')).toBe(true);
    expect(seen.map((r) => r.title)).not.toContain(`Only A ${S}`);
    expect(seen.map((r) => r.title)).toContain(`Everyone ${S}`);
    let caught: unknown = null;
    try {
      await withTenant({ userId: ids.userB, allCustomers: false, customerIds: [ids.b] }, (tx) => tx.insert(schema.announcements).values({ title: 'Nope', body: 'A customer cannot announce.' }));
    } catch (e) {
      caught = e;
    }
    const err = caught as { code?: string; cause?: { code?: string } } | null;
    expect((err?.cause ?? err)?.code).toBe('42501');
    await expect(asB((ctx) => status.createAnnouncement(ctx, { title: 'Nope', body: 'Still no.' }))).rejects.toMatchObject({ statusCode: 403 });
  });
  it('lists by state, updates with an audit trail and ends', async () => {
    const live = await asAdmin((ctx) => status.listAnnouncements(ctx, { page: 1, pageSize: 50, state: 'live', q: S } as never));
    expect(live.items.map((i) => i.title)).toContain(`Everyone ${S}`);
    expect(live.items.map((i) => i.title)).not.toContain(`Later ${S}`);
    const scheduled = await asAdmin((ctx) => status.listAnnouncements(ctx, { page: 1, pageSize: 50, state: 'scheduled', q: S } as never));
    expect(scheduled.items.map((i) => i.title)).toEqual([`Later ${S}`]);
    const target = live.items.find((i) => i.title === `Only A ${S}`)!;
    expect(target.customers.map((c) => c.id)).toEqual([ids.a]);
    const updated = await asAdmin((ctx) => status.updateAnnouncement(ctx, target.id, { pinned: true, endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 7200_000) }));
    expect(updated.pinned).toBe(true);
    const ended = await asAdmin((ctx) => status.listAnnouncements(ctx, { page: 1, pageSize: 50, state: 'ended', q: S } as never));
    expect(ended.items.map((i) => i.id)).toContain(target.id);
    expect((await asA((ctx) => status.activeAnnouncements(ctx))).items.map((i) => i.id)).not.toContain(target.id);
    await expect(asAdmin((ctx) => status.updateAnnouncement(ctx, target.id, { endsAt: new Date(Date.now() - 20_000_000) }))).rejects.toMatchObject({ statusCode: 422 });
    const audits = await withSystem((tx) => tx.select({ action: schema.auditLog.action }).from(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'announcement'), eq(schema.auditLog.entityId, target.id))));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['announcement.create', 'announcement.update']));
  });
});

describe('service health', () => {
  it('pure: a major incident wins, maintenance beats an alert, nothing is good', () => {
    const deps = new Set(['svc', 'app', 'db']);
    const base = { majors: [], critical: [], alerts: [], visits: [], changes: [], inMaintenance: new Map<string, string>() };
    expect(healthOf(deps, base)).toEqual({ health: 'good', reasons: [] });
    expect(healthOf(deps, { ...base, alerts: [{ id: 'e1', ciId: 'db', source: 'prtg', message: 'down', receivedAt: new Date() }] }).health).toBe('degraded');
    expect(healthOf(deps, { ...base, alerts: [{ id: 'e1', ciId: 'db', source: 'prtg', message: 'down', receivedAt: new Date() }], changes: [{ id: 'c1', number: 'CHG-1', title: 'Patch', ciIds: ['app'], endsAt: null }] }).health).toBe('maintenance');
    const r = healthOf(deps, { ...base, majors: [{ ticketId: 't1', number: 'INC-1', title: 'Outage', ciIds: ['db'], declaredAt: new Date() }], changes: [{ id: 'c1', number: 'CHG-1', title: 'Patch', ciIds: ['app'], endsAt: null }] });
    expect(r.health).toBe('down');
    expect(r.reasons.map((x) => x.kind)).toEqual(['major_incident', 'change']);
    expect(healthOf(deps, { ...base, majors: [{ ticketId: 't1', number: 'INC-1', title: 'Elsewhere', ciIds: ['other'], declaredAt: new Date() }] }).health).toBe('good');
  });
  it('a business service goes down with a major incident on a dependency and recovers when it is demoted', async () => {
    const bs = await asAdmin((ctx) => cmdb.createCi(ctx, { customerId: ids.a, siteId: ids.siteA, typeId: types.business_service!, name: `Payments ${S}`, criticality: 'critical', attributes: { tier: 'tier1' } }));
    const app = await asAdmin((ctx) => cmdb.createCi(ctx, { customerId: ids.a, siteId: ids.siteA, typeId: types.application!, name: `pay-app ${S}` }));
    const db = await asAdmin((ctx) => cmdb.createCi(ctx, { customerId: ids.a, siteId: ids.siteA, typeId: types.database!, name: `pay-db ${S}` }));
    Object.assign(ids, { bs: bs.id, app: app.id, db: db.id });
    await asAdmin((ctx) => cmdb.addRelationship(ctx, bs.id, { targetCiId: app.id, typeId: relTypes.depends_on! }));
    await asAdmin((ctx) => cmdb.addRelationship(ctx, db.id, { targetCiId: app.id, typeId: relTypes.supports! }));
    await computeServiceHealth();
    const before = await asA((ctx) => status.portalStatus(ctx));
    expect(before.services.find((s) => s.id === bs.id)).toMatchObject({ health: 'good', reasons: [] });
    expect(before.overall).toBe('good');

    const t = await asAdmin((ctx) => createTicket(ctx, { type: 'incident', customerId: ids.a, siteId: ids.siteA, title: `Database cluster down ${S}`, priorityId: ids.p1, primaryCiId: db.id } as never));
    created.tickets.push(t.id);
    ids.ticket = t.id;
    await asAdmin((ctx) => declareMajor(ctx, t.id, { portalBanner: true, notify: false } as never));
    await asAdmin((ctx) => postMajorUpdate(ctx, t.id, { body: 'Engineers are failing over to the standby cluster.', kind: 'stakeholder', portalBanner: true }));
    const run = await computeServiceHealth();
    expect(run.down).toBeGreaterThanOrEqual(1);
    const during = await asA((ctx) => status.portalStatus(ctx));
    const svc = during.services.find((s) => s.id === bs.id)!;
    expect(svc.health).toBe('down');
    expect(svc.reasons[0]).toMatchObject({ kind: 'major_incident', label: t.number });
    expect(during.overall).toBe('down');
    expect(during.incidents.map((i) => i.ticketId)).toContain(t.id);
    expect(during.incidents.find((i) => i.ticketId === t.id)?.latestUpdate?.body).toMatch(/standby cluster/);
    // Another customer's status page knows nothing of it.
    const other = await asB((ctx) => status.portalStatus(ctx));
    expect(other.services.map((s) => s.id)).not.toContain(bs.id);
    expect(other.incidents).toHaveLength(0);

    await asAdmin((ctx) => demoteMajor(ctx, t.id, { reason: 'False alarm' }));
    await computeServiceHealth();
    const after = await asA((ctx) => status.portalStatus(ctx));
    // The P1 ticket is still open on the dependency, so the service is degraded, not down.
    expect(after.services.find((s) => s.id === bs.id)?.health).toBe('degraded');
    expect(after.incidents).toHaveLength(0);
  });
});

describe('public status page', () => {
  let token = '';
  let tokenId = '';
  it('a token opens an aggregate page with no ids, and is listed by prefix only', async () => {
    const made = await asAdmin((ctx) => status.createToken(ctx, { customerId: ids.a, label: `Lobby screen ${S}` }));
    token = made.token;
    tokenId = made.id;
    expect(made.url).toContain(`/status/${token}`);
    expect(made.tokenPrefix).toBe(token.slice(0, 6));
    const list = await asAdmin((ctx) => status.listTokens(ctx, ids.a));
    expect(list.items.map((t) => t.id)).toContain(tokenId);
    expect(JSON.stringify(list)).not.toContain(token);
    const page = await status.publicStatus(token);
    expect(page).not.toBeNull();
    expect(page!.customer.name).toContain('Status Customer A');
    const svc = page!.services.find((s) => s.name === `Payments ${S}`)!;
    expect(svc.health).toBe('degraded');
    expect(svc.reasons[0]).toMatch(/Incident INC-/);
    expect(JSON.stringify(page)).not.toContain(ids.ticket);
    expect(JSON.stringify(page)).not.toContain(ids.bs);
    expect(page!.announcements.map((a) => a.title)).toContain(`Everyone ${S}`);
    expect(page!.announcements.map((a) => a.title)).not.toContain(`Staff ${S}`);
    expect(JSON.stringify(page)).not.toContain('customerIds');
  });
  it('a revoked or unknown token opens nothing; a customer user cannot mint one', async () => {
    await expect(asA((ctx) => status.createToken(ctx, { customerId: ids.a, label: 'Nope' }))).rejects.toMatchObject({ statusCode: 403 });
    await asAdmin((ctx) => status.revokeToken(ctx, tokenId));
    expect(await status.publicStatus(token)).toBeNull();
    expect(await status.publicStatus('not-a-real-token-at-all-0000')).toBeNull();
    expect(await status.publicStatus('short')).toBeNull();
    await asAdmin((ctx) => status.deleteToken(ctx, tokenId));
    expect((await asAdmin((ctx) => status.listTokens(ctx, ids.a))).items.map((t) => t.id)).not.toContain(tokenId);
  });
});

describe('Grady', () => {
  it('drafts an announcement from a ticket without a provider and from the model with one', async () => {
    const d = await asAdmin((ctx) => draftAnnouncement(ctx, { ticketId: ids.ticket }));
    expect(d.aiGenerated).toBe(false);
    expect(d.type).toBe('outage');
    expect(d.title).toContain('Service disruption');
    expect(d.body).toMatch(/pay-db/);
    await expect(asA((ctx) => draftAnnouncement(ctx, { ticketId: ids.ticket }))).rejects.toMatchObject({ statusCode: 403 });
    ai.setProviderForTests({ name: 'fake', model: 'fake-1', chat: async () => json({ title: 'Payments: service disruption', body: 'We are working on a database issue affecting payments. Next update within the hour.' }) });
    try {
      const m = await asAdmin((ctx) => draftAnnouncement(ctx, { ticketId: ids.ticket, type: 'outage', audience: 'customers' }));
      expect(m.aiGenerated).toBe(true);
      expect(m.title).toBe('Payments: service disruption');
      expect(m.audience).toBe('customers');
    } finally {
      ai.setProviderForTests({ name: 'none', model: 'none', chat: async () => json({}) });
    }
  });
  it('create_announcement previews the wording and publishes for one customer', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'create_announcement')!;
    expect(tool.tier).toBe('outbound');
    expect(tool.portal).toBeNull();
    const input = { title: `Grady notice ${S}`, body: 'Planned maintenance on the payments platform tonight from 22:00 to 23:00.', type: 'maintenance', audience: 'customers', customer: ids.a };
    const preview = await asAdmin((ctx) => tool.preview!(ctx, input));
    const text = typeof preview === 'string' ? preview : preview.text;
    expect(text).toContain('maintenance announcement to customers only');
    const result = (await asAdmin((ctx) => tool.run(ctx, input))) as { id: string; customers: number | string };
    created.announcements.push(result.id);
    expect(result.customers).toBe(1);
    expect((await asA((ctx) => status.activeAnnouncements(ctx))).items.map((i) => i.title)).toContain(input.title);
    expect((await asB((ctx) => status.activeAnnouncements(ctx))).items.map((i) => i.title)).not.toContain(input.title);
  });
});
