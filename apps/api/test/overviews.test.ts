/**
 * Module Overview endpoints (DB-backed): assets, customers, contracts (+ the
 * paged entitlement list), field, knowledge and the portal assets overview.
 * Run with the dev environment sourced:
 *   npx vitest run test/overviews.test.ts
 *
 * One customer (A) is seeded with a site, three assets (warranty in 10 days,
 * AMC expired, no dates), a contract with a 60% and an exhausted entitlement,
 * three visits (overdue + unassigned, completed today, scheduled tomorrow), a
 * PM occurrence due today, two knowledge articles and a portal user. A second
 * customer (B) owns one asset that must never leak into A's portal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { config } from '@/config';
import { createTicket } from '@/modules/tickets/service';
import { assetsOverview } from '@/modules/assets/overview';
import { customersOverview } from '@/modules/customers/overview';
import { contractsOverview, listEntitlementRows } from '@/modules/contracts/overview';
import { fieldOverview } from '@/modules/field/overview';
import { knowledgeOverview } from '@/modules/knowledge/overview';
import * as portal from '@/modules/portal/service';

const hasDb = !!process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('x');
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** Noon UTC on the civil day `offset` days from today (never crosses a UTC date boundary). */
const noon = (offset: number) => new Date(day(offset) + 'T12:00:00Z');

const ids = { customerA: '', customerB: '', site: '', category: '', a1: '', a2: '', a3: '', b1: '', contract: '', entOk: '', entExhausted: '', v1: '', v2: '', v3: '', program: '', occurrence: '', kbStale: '', kbDraft: '', portalUser: '', adminUser: '', ticket: '', p1: '' };
let admin: Principal;
let portalA: Principal;

const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `overviews-${suffix}`, source: 'api' }, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalA, { requestId: `overviews-${suffix}`, source: 'api' }, fn);

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}

describe.skipIf(!hasDb)('module overviews (database)', () => {
  beforeAll(async () => {
    await withSystem(async (tx) => {
      const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, config.ADMIN_EMAIL.toLowerCase())).limit(1);
      if (!adminUser) throw new Error('admin user missing (seed not applied?)');
      ids.adminUser = adminUser.id;
      ids.category = await optionId(tx, 'asset_category', 'server');
      ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
      const [role] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'customer_admin')).limit(1);
      if (!role) throw new Error('customer_admin role missing (seed not applied?)');

      const [a] = await tx.insert(schema.customers).values({ code: `OVWA${suffix}`.toUpperCase(), name: `Overview Customer A ${suffix}` }).returning();
      const [b] = await tx.insert(schema.customers).values({ code: `OVWB${suffix}`.toUpperCase(), name: `Overview Customer B ${suffix}` }).returning();
      ids.customerA = a.id;
      ids.customerB = b.id;
      const [site] = await tx.insert(schema.sites).values({ customerId: a.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
      ids.site = site.id;

      const assets = await tx
        .insert(schema.assets)
        .values([
          { customerId: a.id, siteId: site.id, tag: `OVW-${suffix}-1`, name: 'Core switch', categoryId: ids.category, warrantyEnd: day(10) },
          { customerId: a.id, siteId: site.id, tag: `OVW-${suffix}-2`, name: 'Old server', categoryId: ids.category, amcEnd: day(-5) },
          { customerId: a.id, tag: `OVW-${suffix}-3`, name: 'Spare laptop' },
          { customerId: b.id, tag: `OVW-${suffix}-B`, name: 'B firewall', warrantyEnd: day(5) },
        ])
        .returning({ id: schema.assets.id, tag: schema.assets.tag });
      ids.a1 = assets.find((x) => x.tag.endsWith('-1'))!.id;
      ids.a2 = assets.find((x) => x.tag.endsWith('-2'))!.id;
      ids.a3 = assets.find((x) => x.tag.endsWith('-3'))!.id;
      ids.b1 = assets.find((x) => x.tag.endsWith('-B'))!.id;

      const [contract] = await tx.insert(schema.contracts).values({ customerId: a.id, number: `OVW-${suffix}`, name: `Overview AMC ${suffix}`, status: 'active', startDate: day(-30), endDate: day(45) }).returning();
      ids.contract = contract.id;
      const [entOk] = await tx.insert(schema.contractEntitlements).values({ contractId: contract.id, customerId: a.id, name: 'Support hours', quantity: '10', unit: 'hours', period: 'contract' }).returning();
      const [entExhausted] = await tx.insert(schema.contractEntitlements).values({ contractId: contract.id, customerId: a.id, name: 'Exhausted visits', quantity: '2', unit: 'visits', period: 'contract' }).returning();
      ids.entOk = entOk.id;
      ids.entExhausted = entExhausted.id;
      await tx.insert(schema.entitlementConsumptions).values([
        { entitlementId: entOk.id, customerId: a.id, quantity: '6', sourceType: 'manual' },
        { entitlementId: entExhausted.id, customerId: a.id, quantity: '2', sourceType: 'manual' },
      ]);

      const visits = await tx
        .insert(schema.fieldVisits)
        .values([
          { number: `OVW-FV-${suffix}-1`, customerId: a.id, siteId: site.id, title: 'Overdue visit', status: 'scheduled', scheduledStart: noon(-1) },
          { number: `OVW-FV-${suffix}-2`, customerId: a.id, siteId: site.id, title: 'Done today', status: 'completed', engineerId: adminUser.id, scheduledStart: noon(0), actualStart: noon(0), actualEnd: noon(0), workMinutes: 60, workSummary: 'All good' },
          { number: `OVW-FV-${suffix}-3`, customerId: a.id, siteId: site.id, title: 'Tomorrow visit', status: 'scheduled', engineerId: adminUser.id, scheduledStart: noon(1) },
        ])
        .returning({ id: schema.fieldVisits.id, number: schema.fieldVisits.number });
      ids.v1 = visits.find((v) => v.number.endsWith('-1'))!.id;
      ids.v2 = visits.find((v) => v.number.endsWith('-2'))!.id;
      ids.v3 = visits.find((v) => v.number.endsWith('-3'))!.id;

      const [program] = await tx.insert(schema.pmPrograms).values({ customerId: a.id, siteId: site.id, contractId: contract.id, name: `Overview PM ${suffix}`, frequency: 'quarterly', startDate: day(-30) }).returning();
      ids.program = program.id;
      const [occ] = await tx.insert(schema.pmOccurrences).values({ programId: program.id, customerId: a.id, plannedDate: day(0), status: 'planned' }).returning();
      ids.occurrence = occ.id;

      const old = new Date(Date.now() - 200 * 86_400_000);
      const [kbStale] = await tx.insert(schema.kbArticles).values({ number: `KB-OVW-${suffix}-1`, title: `Stale runbook ${suffix}`, body: 'old', status: 'published', articleType: 'runbook', visibility: 'internal', publishedAt: old, updatedAt: old, createdAt: old, viewCount: 5 }).returning();
      const [kbDraft] = await tx.insert(schema.kbArticles).values({ number: `KB-OVW-${suffix}-2`, title: `Draft FAQ ${suffix}`, body: 'new', status: 'draft', articleType: 'faq', visibility: 'public' }).returning();
      ids.kbStale = kbStale.id;
      ids.kbDraft = kbDraft.id;

      const [user] = await tx.insert(schema.users).values({ email: `overview.portal.${suffix}@example.test`, name: 'Portal Admin', userType: 'customer', customerId: a.id, status: 'active' }).returning();
      ids.portalUser = user.id;
      await tx.insert(schema.userRoles).values({ userId: user.id, roleId: role.id, customerId: a.id });
    });
    invalidatePrincipal();
    admin = (await loadPrincipal(ids.adminUser))!;
    portalA = (await loadPrincipal(ids.portalUser))!;
    expect(portalA.customerScope).toEqual([ids.customerA]);
    // An open P1 incident puts customer A on the attention list.
    await asAdmin(async (ctx) => {
      const t = await createTicket(ctx, { type: 'incident', customerId: ids.customerA, title: `Overview P1 ${suffix}`, priorityId: ids.p1 });
      ids.ticket = t.id;
    });
  });

  afterAll(async () => {
    await withSystem(async (tx) => {
      const customers = [ids.customerA, ids.customerB].filter(Boolean);
      if (customers.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.customerId, customers));
      const kb = [ids.kbStale, ids.kbDraft].filter(Boolean);
      if (kb.length) await tx.delete(schema.kbArticles).where(inArray(schema.kbArticles.id, kb));
      if (customers.length) await tx.delete(schema.customers).where(inArray(schema.customers.id, customers));
    });
    await closeDb();
  });

  it('assets overview: totals, breakdowns, coverage buckets and the soonest expiries', async () => {
    const o = await asAdmin((ctx) => assetsOverview(ctx, ids.customerA));
    expect(o).toMatchObject({ total: 3, withCi: 0, withoutCi: 3, addedLast30d: 3 });
    expect(o.byLifecycle.map((b) => b.key)).toEqual(['ordered', 'in_stock', 'deployed', 'in_repair', 'retired', 'disposed']);
    expect(o.byLifecycle.find((b) => b.key === 'deployed')).toEqual({ key: 'deployed', label: 'Deployed', count: 3, color: 'green' });
    expect(o.byCategory).toEqual([
      { key: 'server', label: 'Server', count: 2, color: null },
      { key: 'none', label: 'Uncategorised', count: 1, color: null },
    ]);
    expect(o.byCustomer).toEqual([{ key: ids.customerA, label: `Overview Customer A ${suffix}`, count: 3, color: null }]);
    expect(o.bySite).toEqual([
      { key: ids.site, label: 'HQ', count: 2, color: null },
      { key: 'none', label: 'No site', count: 1, color: null },
    ]);
    expect(o.warranty).toEqual({ expired: 0, d30: 1, d90: 0, ok: 0, none: 2 });
    expect(o.amc).toEqual({ expired: 1, d30: 0, d90: 0, ok: 0, none: 2 });
    expect(o.eol).toEqual({ past: 0, d90: 0, d365: 0 });
    expect(o.expiringSoon).toEqual([{ id: ids.a1, tag: `OVW-${suffix}-1`, name: 'Core switch', customerName: `Overview Customer A ${suffix}`, kind: 'warranty', endDate: day(10), daysLeft: 10 }]);
    // Every number is a whole number.
    for (const v of [o.total, o.withCi, o.withoutCi, o.addedLast30d, ...Object.values(o.warranty), ...Object.values(o.amc), ...Object.values(o.eol)]) expect(Number.isInteger(v)).toBe(true);

    const all = await asAdmin((ctx) => assetsOverview(ctx));
    expect(all.total).toBeGreaterThanOrEqual(4);
    // The customer bucket list is the top eight; other suites may hold customers with more assets, in which case A is simply not among them.
    const mine = all.byCustomer.find((b) => b.key === ids.customerA);
    if (mine) expect(mine.count).toBe(3);
    else expect(all.byCustomer.every((b) => b.count >= 3)).toBe(true);
    expect(all.byCustomer.length).toBeLessThanOrEqual(8);
    expect(all.expiringSoon.some((e) => e.id === ids.b1)).toBe(true);
  });

  it('customers overview: base counts, picklist buckets and the attention list', async () => {
    const o = await asAdmin((ctx) => customersOverview(ctx));
    expect(o.total).toBeGreaterThanOrEqual(2);
    expect(o.active).toBeGreaterThanOrEqual(2);
    expect(o.newLast90d).toBeGreaterThanOrEqual(2);
    expect(o.total).toBe(o.active + o.inactive);
    for (const arr of [o.byStatus, o.byType, o.byIndustry]) {
      expect(Array.isArray(arr)).toBe(true);
      expect(arr.reduce((s, b) => s + b.count, 0)).toBe(o.total);
      for (const b of arr) expect(b).toMatchObject({ key: expect.any(String), label: expect.any(String), count: expect.any(Number) });
    }
    expect(o.attention.length).toBeLessThanOrEqual(10);
    const a = o.attention.find((r) => r.id === ids.customerA);
    expect(a).toMatchObject({ name: `Overview Customer A ${suffix}`, code: `OVWA${suffix}`.toUpperCase(), openTickets: 1, openP1: 1, breached: 0, contractsExpiring60d: 1, entitlementsOverThreshold: 1 });
    expect(a!.slaCompliance30d === null || typeof a!.slaCompliance30d === 'number').toBe(true);
    expect(o.attention.some((r) => r.id === ids.customerB)).toBe(false);
    expect(Array.isArray(o.slaByCustomer)).toBe(true);
    for (let i = 1; i < o.slaByCustomer.length; i++) expect((o.slaByCustomer[i - 1].compliancePct ?? 0) <= (o.slaByCustomer[i].compliancePct ?? 0)).toBe(true);
    expect(o.contractsExpiring60d).toBeGreaterThanOrEqual(1);
    expect(o.entitlementsOverThreshold).toBeGreaterThanOrEqual(1);
  });

  it('contracts overview: status / type / expiry timeline / entitlements / scope / health', async () => {
    const o = await asAdmin((ctx) => contractsOverview(ctx, ids.customerA));
    expect(o.total).toBe(1);
    expect(o.byStatus.map((b) => b.key)).toEqual(['draft', 'active', 'expiring', 'expired', 'terminated', 'renewed']);
    expect(o.byStatus.find((b) => b.key === 'active')).toMatchObject({ count: 1, label: 'Active', color: 'green' });
    expect(o.byType).toEqual([{ key: 'none', label: 'Unset', count: 1, color: null }]);
    expect(o.expiring).toEqual({ d30: 0, d60: 1, d90: 0, expired: 0 });
    expect(o.expiryTimeline).toHaveLength(12);
    expect(o.expiryTimeline[0].month).toBe(day(0).slice(0, 7));
    expect(o.expiryTimeline.every((m) => /^\d{4}-\d{2}$/.test(m.month))).toBe(true);
    expect(o.expiryTimeline.find((m) => m.month === day(45).slice(0, 7))?.count).toBe(1);
    expect(o.expiryTimeline.reduce((s, m) => s + m.count, 0)).toBe(1);
    expect(o.entitlements).toEqual({ total: 2, ok: 1, overThreshold: 0, exhausted: 1, byType: [{ key: 'none', label: 'Untyped', count: 2, color: null }] });
    expect(o.scope.contractsWithoutScope).toBe(1);
    expect(Number.isInteger(o.scope.outOfScopeTickets30d)).toBe(true);
    expect(o.health).toEqual({ missingAgreement: 1, noSlaPolicy: 1, noServices: 1 });
    expect(o.expiringSoon).toEqual([{ id: ids.contract, number: `OVW-${suffix}`, name: `Overview AMC ${suffix}`, customerName: `Overview Customer A ${suffix}`, endDate: day(45), daysLeft: 45, status: 'active' }]);

    const all = await asAdmin((ctx) => contractsOverview(ctx));
    expect(all.total).toBeGreaterThanOrEqual(1);
    expect(all.expiringSoon.length).toBeLessThanOrEqual(10);
  });

  it('entitlement list: utilisation rows sorted by consumption, filterable and paged', async () => {
    const list = await asAdmin((ctx) => listEntitlementRows(ctx, { page: 1, pageSize: 50, customerId: ids.customerA }));
    expect(list).toMatchObject({ total: 2, page: 1, pageSize: 50 });
    expect(list.items.map((r) => r.id)).toEqual([ids.entExhausted, ids.entOk]);
    expect(list.items[0]).toMatchObject({ name: 'Exhausted visits', type: null, unit: 'visits', contractId: ids.contract, contractNumber: `OVW-${suffix}`, customerId: ids.customerA, customerName: `Overview Customer A ${suffix}`, period: 'contract', periodStart: day(-30), periodEnd: day(45), quantity: 2, used: 2, remaining: 0, pct: 100, overThreshold: true, exhausted: true });
    expect(list.items[1]).toMatchObject({ name: 'Support hours', quantity: 10, used: 6, remaining: 4, pct: 60, overThreshold: false, exhausted: false });
    expect((await asAdmin((ctx) => listEntitlementRows(ctx, { page: 1, pageSize: 50, customerId: ids.customerA, status: 'exhausted' }))).items.map((r) => r.id)).toEqual([ids.entExhausted]);
    expect((await asAdmin((ctx) => listEntitlementRows(ctx, { page: 1, pageSize: 50, customerId: ids.customerA, status: 'ok' }))).items.map((r) => r.id)).toEqual([ids.entOk]);
    expect((await asAdmin((ctx) => listEntitlementRows(ctx, { page: 1, pageSize: 50, customerId: ids.customerA, status: 'over_threshold' }))).total).toBe(0);
    expect((await asAdmin((ctx) => listEntitlementRows(ctx, { page: 1, pageSize: 50, customerId: ids.customerA, q: 'support' }))).items.map((r) => r.id)).toEqual([ids.entOk]);
    const page2 = await asAdmin((ctx) => listEntitlementRows(ctx, { page: 2, pageSize: 1, customerId: ids.customerA }));
    expect(page2).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(page2.items.map((r) => r.id)).toEqual([ids.entOk]);
    const all = await asAdmin((ctx) => listEntitlementRows(ctx, { page: 1, pageSize: 500 }));
    expect(all.total).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < all.items.length; i++) expect(all.items[i - 1].pct >= all.items[i].pct).toBe(true);
  });

  it('field overview: today / week tiles, pipeline, overdue + unassigned, engineers, PM and the 30-day series', async () => {
    const o = await asAdmin((ctx) => fieldOverview(ctx, ids.customerA));
    expect(o.today).toEqual({ scheduled: 0, inProgress: 0, completed: 1 });
    expect(o.week.completed).toBeGreaterThanOrEqual(1);
    expect(o.byStatus.map((b) => b.key)).toEqual(['requested', 'scheduled', 'in_progress', 'completed', 'cancelled']);
    expect(o.byStatus.find((b) => b.key === 'scheduled')).toEqual({ key: 'scheduled', label: 'Scheduled', count: 1, color: 'blue' });
    expect(o.byStatus.find((b) => b.key === 'completed')?.count).toBe(1);
    expect(o).toMatchObject({ overdue: 1, unassigned: 1, awaitingAcknowledgement: 1 });
    expect(o.byEngineer).toEqual([{ id: ids.adminUser, name: admin.name, scheduled: 1, inProgress: 0 }]);
    expect(o.pm).toMatchObject({ dueThisMonth: 1, overdue: 0, completedThisMonth: 0 });
    expect(o.pm.byStatus.map((b) => b.key)).toEqual(['planned', 'scheduled', 'completed', 'missed', 'rescheduled', 'cancelled']);
    expect(o.pm.byStatus.find((b) => b.key === 'planned')?.count).toBe(1);
    expect(o.series).toHaveLength(30);
    expect(o.series[0].day).toBe(day(-29));
    expect(o.series[29].day).toBe(day(0));
    expect(o.series[29].visitsCompleted).toBeGreaterThanOrEqual(1);
    expect(o.series.every((p) => Number.isInteger(p.visitsCompleted) && Number.isInteger(p.pmCompleted))).toBe(true);
    expect(o.upcoming.map((v) => v.id)).toEqual([ids.v3]);
    expect(o.upcoming[0]).toMatchObject({ number: `OVW-FV-${suffix}-3`, title: 'Tomorrow visit', customerName: `Overview Customer A ${suffix}`, siteName: 'HQ', engineerName: admin.name, scheduledStart: noon(1).toISOString(), status: 'scheduled' });

    const all = await asAdmin((ctx) => fieldOverview(ctx));
    expect(all.overdue).toBeGreaterThanOrEqual(1);
    expect(all.upcoming.length).toBeLessThanOrEqual(10);
    // A customer user may not call the MSP field overview with another customer's id.
    await expect(asPortal((ctx) => fieldOverview(ctx, ids.customerB))).rejects.toThrow(/access|permission/i);
  });

  it('knowledge overview: library breakdowns, drafts, stale articles and recent updates (MSP only)', async () => {
    const o = await asAdmin((ctx) => knowledgeOverview(ctx));
    expect(o.total).toBeGreaterThanOrEqual(2);
    expect(o.byStatus.map((b) => b.key)).toEqual(['draft', 'published', 'archived']);
    expect(o.byStatus.reduce((s, b) => s + b.count, 0)).toBe(o.total);
    expect(o.byType.map((b) => b.key)).toEqual(['sop', 'runbook', 'troubleshooting', 'faq', 'known_error', 'resolution', 'procedure']);
    expect(o.byType.find((b) => b.key === 'runbook')?.count).toBeGreaterThanOrEqual(1);
    expect(o.byVisibility.map((b) => b.key)).toEqual(['internal', 'customer', 'public']);
    expect(o.byCategory.find((b) => b.key === 'none')?.count).toBeGreaterThanOrEqual(2);
    expect(o.drafts).toBeGreaterThanOrEqual(1);
    expect(o.stale).toBeGreaterThanOrEqual(1);
    expect(o.withoutCategory).toBeGreaterThanOrEqual(2);
    expect(o.viewsLast30d).toBeGreaterThanOrEqual(5);
    expect(o.topViewed.length).toBeLessThanOrEqual(10);
    const top = o.topViewed.find((t) => t.id === ids.kbStale);
    if (top) expect(top).toEqual({ id: ids.kbStale, number: `KB-OVW-${suffix}-1`, title: `Stale runbook ${suffix}`, viewCount: 5, visibility: 'internal' });
    expect(o.recentlyUpdated.length).toBeLessThanOrEqual(10);
    expect(o.recentlyUpdated.find((r) => r.id === ids.kbDraft)).toMatchObject({ number: `KB-OVW-${suffix}-2`, status: 'draft', updatedAt: expect.any(String) });
    await expect(asPortal((ctx) => knowledgeOverview(ctx))).rejects.toThrow(/MSP users|permission/i);
  });

  it('portal assets overview: pinned to the portal user\'s own customer', async () => {
    const o = await asPortal((ctx) => portal.portalAssetsOverview(ctx, ids.customerB));
    expect(o.total).toBe(3);
    expect(o.preview).toBe(false);
    expect(o.byLifecycle.find((b) => b.key === 'deployed')?.count).toBe(3);
    expect(o.byCategory).toEqual([
      { key: 'server', label: 'Server', count: 2, color: null },
      { key: 'none', label: 'Uncategorised', count: 1, color: null },
    ]);
    expect(o.bySite).toEqual([
      { key: ids.site, label: 'HQ', count: 2, color: null },
      { key: 'none', label: 'No site', count: 1, color: null },
    ]);
    expect(o.warranty).toEqual({ expired: 0, d30: 1, d90: 0, ok: 0, none: 2 });
    expect(o.amc).toEqual({ expired: 1, d30: 0, d90: 0, ok: 0, none: 2 });
    expect(o.expiringSoon).toEqual([{ id: ids.a1, tag: `OVW-${suffix}-1`, name: 'Core switch', siteName: 'HQ', kind: 'warranty', endDate: day(10), daysLeft: 10 }]);
    expect(o.expiringSoon.some((e) => e.id === ids.b1)).toBe(false);
    expect(Object.keys(o)).not.toContain('byCustomer');
    // MSP preview of the same customer.
    const preview = await asAdmin((ctx) => portal.portalAssetsOverview(ctx, ids.customerA));
    expect(preview).toMatchObject({ total: 3, preview: true });
  });

  it('portal asset list: coverage chips, lifecycle, category, site, search and sort', async () => {
    const list = (q: Partial<Parameters<typeof portal.portalAssets>[1]>) => asPortal((ctx) => portal.portalAssets(ctx, { page: 1, pageSize: 50, ...q }));
    expect((await list({})).total).toBe(3);
    expect((await list({ expiring: 'warranty30' })).items.map((a) => a.id)).toEqual([ids.a1]);
    expect((await list({ expiring: 'warranty90' })).items.map((a) => a.id)).toEqual([ids.a1]);
    expect((await list({ expiring: 'amc30' })).total).toBe(0);
    expect((await list({ expiring: 'amc90' })).total).toBe(0);
    expect((await list({ expiring: 'expired' })).items.map((a) => a.id)).toEqual([ids.a2]);
    expect((await list({ lifecycleStage: 'deployed' })).total).toBe(3);
    expect((await list({ lifecycleStage: 'retired' })).total).toBe(0);
    expect((await list({ categoryId: ids.category })).total).toBe(2);
    expect((await list({ siteId: ids.site })).total).toBe(2);
    expect((await list({ q: `OVW-${suffix}-3` })).items.map((a) => a.id)).toEqual([ids.a3]);
    const sorted = await list({ sort: 'warrantyEnd', order: 'asc' });
    expect(sorted.items[0].id).toBe(ids.a1);
    expect(sorted.items.every((a) => a.id !== ids.b1)).toBe(true);
    // A foreign customerId is ignored for customer users.
    expect((await list({ customerId: ids.customerB })).items.every((a) => a.id !== ids.b1)).toBe(true);
  });
});
