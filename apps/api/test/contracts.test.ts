/**
 * Contracts / scope / entitlements integration tests (DB-backed).
 * Run with the dev environment sourced (DATABASE_URL etc.):
 *   npx vitest run test/contracts.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withSystem, schema, closeDb } from '@/db/client';
import { runAs } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { config } from '@/config';
import * as customers from '@/modules/customers/service';
import * as sites from '@/modules/customers/sites';
import * as services from '@/modules/services/service';
import * as contracts from '@/modules/contracts/service';
import * as ent from '@/modules/contracts/entitlements';
import { evaluateScope, selectContractForTicket } from '@/modules/contracts/scope';
import { periodWindow } from '@/modules/contracts/entitlements';
import { addDays, todayStr } from '@/modules/contracts/common';
import { runContractsDaily } from '@/jobs/processors/contracts';

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let admin: Principal;
const ids = { customer: '', customer2: '', site1: '', site2: '', serviceA: '', serviceB: '', contract: '', inScopeItem: '', outScopeItem: '', categoryX: '', quarterly: '', slaPolicy: '' };
const as = <T>(fn: Parameters<typeof runAs<T>>[2]) => runAs(admin, { requestId: 'test', source: 'api' }, fn);
const today = todayStr();

describe('contracts, scope and entitlements', () => {
  beforeAll(async () => {
    const [user] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, config.ADMIN_EMAIL.toLowerCase())).limit(1));
    expect(user, 'admin user must exist (run the seed)').toBeTruthy();
    invalidatePrincipal(user.id);
    admin = (await loadPrincipal(user.id))!;
    const [category] = await withSystem((tx) => tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(eq(schema.configOptions.type, 'ticket_category')).limit(1));
    ids.categoryX = category.id;
    const [policy] = await withSystem((tx) => tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).limit(1));
    ids.slaPolicy = policy?.id ?? '';

    await as(async (ctx) => {
      const customer = await customers.createCustomer(ctx, { name: `Test Co ${suffix}`, accountManagerId: admin.id });
      ids.customer = customer.id;
      const other = await customers.createCustomer(ctx, { name: `Other Co ${suffix}` });
      ids.customer2 = other.id;
      ids.site1 = (await sites.createSite(ctx, customer.id, { name: 'Site One', code: 'S1' })).id;
      ids.site2 = (await sites.createSite(ctx, customer.id, { name: 'Site Two', code: 'S2' })).id;
      ids.serviceA = (await services.createService(ctx, { name: `Service A ${suffix}` })).id;
      ids.serviceB = (await services.createService(ctx, { name: `Service B ${suffix}` })).id;
      const contract = await contracts.createContract(ctx, {
        customerId: customer.id,
        name: 'AMC',
        status: 'active',
        startDate: addDays(today, -30),
        endDate: addDays(today, 335),
        slaPolicyId: ids.slaPolicy || undefined,
        services: [{ serviceId: ids.serviceA }],
        siteIds: [ids.site1],
        scopeItems: [
          { name: 'Service A coverage', classification: 'in_scope', serviceId: ids.serviceA },
          { name: 'Category X excluded', classification: 'out_of_scope', ticketCategoryId: ids.categoryX },
        ],
        entitlements: [{ name: 'Quarterly visits', quantity: 4, unit: 'visits', period: 'quarterly', warnThresholdPct: 50 }],
      });
      ids.contract = contract.id;
      ids.inScopeItem = contract.scopeItems.find((s) => s.classification === 'in_scope')!.id;
      ids.outScopeItem = contract.scopeItems.find((s) => s.classification === 'out_of_scope')!.id;
      ids.quarterly = contract.entitlements[0].id;
    });
  });

  afterAll(async () => {
    await withSystem(async (tx) => {
      if (ids.customer || ids.customer2) await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.customer, ids.customer2].filter(Boolean)));
      if (ids.serviceA || ids.serviceB) await tx.delete(schema.services).where(inArray(schema.services.id, [ids.serviceA, ids.serviceB].filter(Boolean)));
    });
    await closeDb();
  });

  describe('no commercial terms', () => {
    const MONEY_KEYS = ['value', 'currency', 'billingCycle', 'commercial', 'poNumber', 'canViewCommercial'];

    it('list items and the detail view carry no money fields', async () => {
      const list = await as((ctx) => contracts.listContracts(ctx, { page: 1, pageSize: 500, customerId: ids.customer }));
      const item = list.items.find((c) => c.id === ids.contract)!;
      expect(item).toBeTruthy();
      for (const k of MONEY_KEYS) expect(Object.keys(item)).not.toContain(k);
      const detail = await as((ctx) => contracts.getContract(ctx, ids.contract));
      for (const k of MONEY_KEYS) expect(Object.keys(detail)).not.toContain(k);
      expect(Object.keys(detail.documents)).not.toContain('purchaseOrder');
      expect(detail).toHaveProperty('signedAt');
    });

    it('entitlements carry no overage rate', async () => {
      const detail = await as((ctx) => contracts.getContract(ctx, ids.contract));
      expect(detail.entitlements.length).toBeGreaterThan(0);
      for (const e of detail.entitlements) expect(Object.keys(e)).not.toContain('overageRate');
      const list = await as((ctx) => contracts.listContracts(ctx, { page: 1, pageSize: 500, customerId: ids.customer }));
      expect(list.items.find((c) => c.id === ids.contract)!.entitlements.count).toBeGreaterThan(0);
    });

    it('the customer view carries no commercial block', async () => {
      const cust = await as((ctx) => customers.getCustomer(ctx, ids.customer));
      expect(Object.keys(cust)).not.toContain('commercial');
      expect(Object.keys(cust)).not.toContain('canViewCommercial');
    });
  });

  describe('evaluateScope', () => {
    it('service A at covered site 1 is in scope via the explicit scope item', async () => {
      const r = await withSystem((tx) => evaluateScope(tx, { customerId: ids.customer, serviceId: ids.serviceA, siteId: ids.site1 }));
      expect(r.status).toBe('in_scope');
      expect(r.contractId).toBe(ids.contract);
      expect(r.scopeItemId).toBe(ids.inScopeItem);
    });

    it('service A at uncovered site 2 is out of scope (contract restricts sites)', async () => {
      // Rule: a contract with explicit contract_sites rows covers only those sites; a covered service at another site is out of scope.
      const r = await withSystem((tx) => evaluateScope(tx, { customerId: ids.customer, serviceId: ids.serviceA, siteId: ids.site2 }));
      expect(r.status).toBe('out_of_scope');
      expect(r.contractId).toBeNull();
      expect(r.reason).toMatch(/Site not covered/);
    });

    it('service B is not covered by any contract', async () => {
      const r = await withSystem((tx) => evaluateScope(tx, { customerId: ids.customer, serviceId: ids.serviceB, siteId: ids.site1 }));
      expect(r.status).toBe('out_of_scope');
      expect(r.reason).toBe('Service not covered by any active contract');
    });

    it('explicit out_of_scope ticket category wins over the in_scope service rule', async () => {
      const r = await withSystem((tx) => evaluateScope(tx, { customerId: ids.customer, serviceId: ids.serviceA, siteId: ids.site1, ticketCategoryId: ids.categoryX }));
      expect(r.status).toBe('out_of_scope');
      expect(r.scopeItemId).toBe(ids.outScopeItem);
    });

    it('a covered service with no matching scope item is in scope by contract coverage', async () => {
      await withSystem((tx) => tx.delete(schema.scopeItems).where(eq(schema.scopeItems.id, ids.inScopeItem)));
      const r = await withSystem((tx) => evaluateScope(tx, { customerId: ids.customer, serviceId: ids.serviceA, siteId: ids.site1 }));
      expect(r.status).toBe('in_scope');
      expect(r.scopeItemId).toBeNull();
      expect(r.reason).toMatch(/Service covered by contract/);
    });

    it('without a service the result is unknown unless a scope rule matches', async () => {
      const r = await withSystem((tx) => evaluateScope(tx, { customerId: ids.customer, siteId: ids.site1 }));
      expect(r.status).toBe('unknown');
      const excluded = await withSystem((tx) => evaluateScope(tx, { customerId: ids.customer, siteId: ids.site1, ticketCategoryId: ids.categoryX }));
      expect(excluded.status).toBe('out_of_scope');
    });

    it('returns unknown when there is no active contract', async () => {
      const none = await withSystem((tx) => evaluateScope(tx, { customerId: ids.customer2, serviceId: ids.serviceA }));
      expect(none).toEqual({ status: 'unknown', contractId: null, scopeItemId: null, reason: 'No active contract' });
      const beforeStart = await withSystem((tx) => evaluateScope(tx, { customerId: ids.customer, serviceId: ids.serviceA, siteId: ids.site1, at: new Date(Date.now() - 60 * 86_400_000) }));
      expect(beforeStart.status).toBe('unknown');
    });
  });

  describe('selectContractForTicket', () => {
    it('returns the covering contract with its SLA policy / calendar / team defaults', async () => {
      const r = await withSystem((tx) => selectContractForTicket(tx, { customerId: ids.customer, serviceId: ids.serviceA, siteId: ids.site1 }));
      expect(r?.contractId).toBe(ids.contract);
      expect(r?.slaPolicyId).toBe(ids.slaPolicy || null);
      expect(r?.teamId).toBeNull();
      const none = await withSystem((tx) => selectContractForTicket(tx, { customerId: ids.customer, serviceId: ids.serviceB, siteId: ids.site1 }));
      expect(none).toBeNull();
    });
  });

  describe('entitlement windows', () => {
    it('computes quarterly windows anchored on the contract start and clipped to its end', () => {
      expect(periodWindow('quarterly', '2026-01-15', '2027-01-14', '2026-02-01')).toEqual({ periodStart: '2026-01-15', periodEnd: '2026-04-14', nextStart: '2026-04-15' });
      expect(periodWindow('quarterly', '2026-01-15', '2027-01-14', '2026-04-14')).toEqual({ periodStart: '2026-01-15', periodEnd: '2026-04-14', nextStart: '2026-04-15' });
      expect(periodWindow('quarterly', '2026-01-15', '2027-01-14', '2026-04-15')).toEqual({ periodStart: '2026-04-15', periodEnd: '2026-07-14', nextStart: '2026-07-15' });
      expect(periodWindow('quarterly', '2026-01-15', '2026-11-30', '2026-11-01')).toEqual({ periodStart: '2026-10-15', periodEnd: '2026-11-30', nextStart: '2026-12-01' });
      expect(periodWindow('contract', '2026-01-15', '2027-01-14', '2026-06-01')).toEqual({ periodStart: '2026-01-15', periodEnd: '2027-01-14', nextStart: '2027-01-15' });
      expect(periodWindow('monthly', '2026-01-31', '2026-12-31', '2026-03-01')).toEqual({ periodStart: '2026-02-28', periodEnd: '2026-03-30', nextStart: '2026-03-31' });
      expect(periodWindow('yearly', '2024-02-29', '2027-02-27', '2026-03-01')).toEqual({ periodStart: '2026-02-28', periodEnd: '2027-02-27', nextStart: '2027-02-28' });
    });

    it('only counts consumption inside the current window', async () => {
      const [row] = await withSystem((tx) => tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, ids.quarterly)));
      const [contract] = await withSystem((tx) => tx.select().from(schema.contracts).where(eq(schema.contracts.id, ids.contract)));
      const windowStart = periodWindow('quarterly', contract.startDate, contract.endDate, today).periodStart;
      await withSystem((tx) =>
        tx.insert(schema.entitlementConsumptions).values({ entitlementId: row.id, customerId: row.customerId, quantity: '1', consumedAt: new Date(`${addDays(windowStart, -1)}T12:00:00Z`), sourceType: 'test', notes: 'previous window' }),
      );
      const u = await withSystem((tx) => ent.entitlementUtilization(tx, row));
      expect(u.used).toBe(0);
      expect(u.periodStart).toBe(windowStart);
      await withSystem((tx) => tx.delete(schema.entitlementConsumptions).where(eq(schema.entitlementConsumptions.entitlementId, row.id)));
    });
  });

  describe('consumption and threshold notifications', () => {
    // One row per recipient: count the administrator's own, so users other suites create cannot change the figure.
    const outboxCount = (event: string) => withSystem(async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(and(eq(schema.notifications.event, event), eq(schema.notifications.entityId, ids.quarterly), eq(schema.notifications.userId, admin.id))))[0].n);

    it('queues the threshold notification once per window and the exhausted one once', async () => {
      const first = await as((ctx) => ent.recordConsumption(ctx, ids.quarterly, { quantity: 2, notes: 'two visits' }));
      expect(first.utilization.pct).toBe(50);
      expect(first.notification).toBe('threshold');
      expect(await outboxCount('entitlement.threshold')).toBe(1);

      const second = await as((ctx) => ent.recordConsumption(ctx, ids.quarterly, { quantity: 1 }));
      expect(second.notification).toBeNull();
      expect(await outboxCount('entitlement.threshold')).toBe(1);

      const third = await as((ctx) => ent.recordConsumption(ctx, ids.quarterly, { quantity: 1 }));
      expect(third.utilization.exhausted).toBe(true);
      expect(third.notification).toBe('exhausted');
      expect(await outboxCount('entitlement.exhausted')).toBe(1);

      const fourth = await as((ctx) => ent.recordConsumption(ctx, ids.quarterly, { quantity: 1 }));
      expect(fourth.overage).toBe(true);
      expect(fourth.notification).toBeNull();
      expect(await outboxCount('entitlement.exhausted')).toBe(1);

      // the daily check does not resend either
      await runContractsDaily();
      expect(await outboxCount('entitlement.threshold')).toBe(1);
      expect(await outboxCount('entitlement.exhausted')).toBe(1);
    });

    it('refuses to exceed an entitlement that does not allow overage', async () => {
      const strict = await as((ctx) => ent.createEntitlement(ctx, ids.contract, { name: 'Strict', quantity: 1, unit: 'count', overageAllowed: false }));
      await as((ctx) => ent.recordConsumption(ctx, strict.id, { quantity: 1 }));
      await expect(as((ctx) => ent.recordConsumption(ctx, strict.id, { quantity: 1 }))).rejects.toThrow(/overage is not allowed/);
    });
  });

  describe('daily job', () => {
    it('flags contracts inside the notice window as expiring and notifies once', async () => {
      const soon = await as((ctx) => contracts.createContract(ctx, { customerId: ids.customer, name: 'Expiring soon', status: 'active', startDate: addDays(today, -300), endDate: addDays(today, 5) }));
      const stats = await runContractsDaily();
      expect(stats.expiring).toBeGreaterThanOrEqual(1);
      const [row] = await withSystem((tx) => tx.select().from(schema.contracts).where(eq(schema.contracts.id, soon.id)));
      expect(row.status).toBe('expiring');
      const milestones = await withSystem((tx) => tx.select({ m: schema.contractNotifications.milestone }).from(schema.contractNotifications).where(eq(schema.contractNotifications.contractId, soon.id)));
      expect(milestones.map((m) => m.m)).toEqual(expect.arrayContaining(['expiring:90', 'expiring:7', 'missing_documents']));
      const count = () => withSystem(async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(and(eq(schema.notifications.event, 'contract.expiring'), eq(schema.notifications.entityId, soon.id), eq(schema.notifications.userId, admin.id))))[0].n);
      expect(await count()).toBe(1);
      await runContractsDaily();
      expect(await count()).toBe(1);
    });

    it('expires contracts past their end date', async () => {
      const past = await as((ctx) => contracts.createContract(ctx, { customerId: ids.customer, name: 'Past', status: 'active', startDate: addDays(today, -400), endDate: addDays(today, -1) }));
      await runContractsDaily();
      const [row] = await withSystem((tx) => tx.select().from(schema.contracts).where(eq(schema.contracts.id, past.id)));
      expect(row.status).toBe('expired');
      const milestones = await withSystem((tx) => tx.select({ m: schema.contractNotifications.milestone }).from(schema.contractNotifications).where(eq(schema.contractNotifications.contractId, past.id)));
      expect(milestones.map((m) => m.m)).toContain('expired');
    });
  });

  describe('lifecycle', () => {
    it('renews into a draft successor carrying coverage, scope and entitlements', async () => {
      const renewed = await as((ctx) => contracts.renewContract(ctx, ids.contract, { startDate: addDays(today, 336), endDate: addDays(today, 700), carryEntitlements: true }));
      expect(renewed.status).toBe('draft');
      expect(renewed.parentContractId).toBe(ids.contract);
      expect(renewed.services.map((s) => s.serviceId)).toEqual([ids.serviceA]);
      expect(renewed.sites.map((s) => s.id)).toEqual([ids.site1]);
      expect(renewed.entitlements.length).toBeGreaterThanOrEqual(1);
      const [old] = await withSystem((tx) => tx.select().from(schema.contracts).where(eq(schema.contracts.id, ids.contract)));
      expect(old.status).toBe('renewed');
      const history = await as((ctx) => contracts.contractHistory(ctx, ids.contract));
      expect(history.items.map((h) => h.action)).toEqual(expect.arrayContaining(['create', 'renew']));
    });
  });

  describe('summary', () => {
    it('counts visible contracts by status/type and narrows by customer', async () => {
      const all = await as((ctx) => contracts.contractSummary(ctx, {}));
      const allList = await as((ctx) => contracts.listContracts(ctx, { page: 1, pageSize: 500 }));
      expect(all.total).toBe(allList.total);
      expect(Array.isArray(all.byStatus)).toBe(true);
      expect(all.byStatus.reduce((n, s) => n + s.count, 0)).toBe(all.total);
      expect(all.byType.reduce((n, s) => n + s.count, 0)).toBe(all.total);

      // This customer by now: the renewed AMC, its draft successor, 'Expiring soon' (ends in 5 days) and 'Past' (expired).
      const mine = await as((ctx) => contracts.contractSummary(ctx, { customerId: ids.customer }));
      const mineList = await as((ctx) => contracts.listContracts(ctx, { page: 1, pageSize: 500, customerId: ids.customer }));
      expect(mine.total).toBe(mineList.total);
      expect(mine.total).toBe(4);
      expect(mine.total).toBeLessThanOrEqual(all.total);
      expect(mine.byStatus.map((s) => [s.key, s.count])).toEqual([
        ['draft', 1],
        ['expiring', 1],
        ['expired', 1],
        ['renewed', 1],
      ]);
      expect(mine.byStatus.find((s) => s.key === 'expired')?.label).toBe('Expired');
      expect(mine.active).toBe(1);
      expect(mine.expiring30).toBe(1);
      expect(mine.expiring90).toBe(1);
      expect(mine.expired).toBe(1);
      expect(mine.byType).toEqual([{ id: null, key: null, label: 'Unset', count: 4 }]);
      expect(mine.entitlementsOverThreshold).toBe(0);
      expect(mine.entitlementsExhausted).toBe(0);

      const none = await as((ctx) => contracts.contractSummary(ctx, { customerId: ids.customer2 }));
      expect(none).toMatchObject({ total: 0, active: 0, expiring30: 0, expiring90: 0, expired: 0, byStatus: [], byType: [] });
    });
  });
});
