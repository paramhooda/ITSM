/**
 * GET /customers/summary (DB-backed). Run with the dev environment sourced:
 *   npx vitest run test/customers-summary.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { withSystem, schema, closeDb } from '@/db/client';
import { runAs } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { config } from '@/config';
import * as customers from '@/modules/customers/service';
import * as contracts from '@/modules/contracts/service';
import { createTicket } from '@/modules/tickets/service';
import { addDays, todayStr } from '@/modules/contracts/common';

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let admin: Principal;
const ids = { alpha: '', beta: '' };
const createdTickets: string[] = [];
const as = <T>(fn: Parameters<typeof runAs<T>>[2]) => runAs(admin, { requestId: 'test', source: 'api' }, fn);
const today = todayStr();

describe('customers summary', () => {
  beforeAll(async () => {
    const [user] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, config.ADMIN_EMAIL.toLowerCase())).limit(1));
    expect(user, 'admin user must exist (run the seed)').toBeTruthy();
    invalidatePrincipal(user.id);
    admin = (await loadPrincipal(user.id))!;
    await as(async (ctx) => {
      const alpha = await customers.createCustomer(ctx, { name: `Summary Alpha ${suffix}` });
      const beta = await customers.createCustomer(ctx, { name: `Summary Beta ${suffix}`, isActive: false });
      ids.alpha = alpha.id;
      ids.beta = beta.id;
      await contracts.createContract(ctx, { customerId: alpha.id, name: 'Short AMC', status: 'active', startDate: addDays(today, -10), endDate: addDays(today, 30) });
      await contracts.createContract(ctx, { customerId: alpha.id, name: 'Long AMC', status: 'active', startDate: addDays(today, -10), endDate: addDays(today, 300) });
      const t = await createTicket(ctx, { type: 'incident', customerId: alpha.id, title: `Summary incident ${suffix}` });
      createdTickets.push(t.id);
    });
  });

  afterAll(async () => {
    await withSystem(async (tx) => {
      if (createdTickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, createdTickets));
      const customerIds = [ids.alpha, ids.beta].filter(Boolean);
      if (customerIds.length) await tx.delete(schema.customers).where(inArray(schema.customers.id, customerIds));
    });
    await closeDb();
  });

  it('matches the list totals for the default (active only) filter', async () => {
    const s = await as((ctx) => customers.customerSummary(ctx, {}));
    const list = await as((ctx) => customers.listCustomers(ctx, { page: 1, pageSize: 1 }));
    expect(s.total).toBe(list.total);
    expect(s.total).toBeGreaterThanOrEqual(1);
    expect(s.active).toBe(s.total);
    expect(s.inactive).toBe(0);
    expect(Array.isArray(s.byType)).toBe(true);
    expect(Array.isArray(s.byStatus)).toBe(true);
    expect(s.byType.reduce((n, b) => n + b.count, 0)).toBe(s.total);
    expect(s.byStatus.reduce((n, b) => n + b.count, 0)).toBe(s.total);
    for (const k of ['openTickets', 'breachedTickets', 'contractsExpiring60'] as const) expect(typeof s[k]).toBe('number');
  });

  it('counts inactive customers with isActive=all', async () => {
    const s = await as((ctx) => customers.customerSummary(ctx, { isActive: 'all' }));
    const list = await as((ctx) => customers.listCustomers(ctx, { page: 1, pageSize: 1, isActive: 'all' }));
    expect(s.total).toBe(list.total);
    expect(s.total).toBe(s.active + s.inactive);
    expect(s.inactive).toBeGreaterThanOrEqual(1);
    const inactiveOnly = await as((ctx) => customers.customerSummary(ctx, { isActive: 'false' }));
    expect(inactiveOnly.active).toBe(0);
    expect(inactiveOnly.total).toBe(inactiveOnly.inactive);
  });

  it('q narrows the total and aggregates the matching customers\' tickets and contracts', async () => {
    const s = await as((ctx) => customers.customerSummary(ctx, { q: `Summary Alpha ${suffix}` }));
    expect(s.total).toBe(1);
    expect(s.active).toBe(1);
    expect(s.inactive).toBe(0);
    expect(s.openTickets).toBe(1);
    expect(s.breachedTickets).toBe(0);
    expect(s.contractsExpiring60).toBe(1);
    expect(s.byType).toHaveLength(1);
    expect(s.byType[0]).toMatchObject({ count: 1 });
    expect(typeof s.byType[0]?.label).toBe('string');
    expect(s.byStatus).toHaveLength(1);

    const both = await as((ctx) => customers.customerSummary(ctx, { q: suffix, isActive: 'all' }));
    expect(both.total).toBe(2);
    expect(both.active).toBe(1);
    expect(both.inactive).toBe(1);
    const none = await as((ctx) => customers.customerSummary(ctx, { q: `no-such-customer-${suffix}` }));
    expect(none).toMatchObject({ total: 0, active: 0, inactive: 0, byType: [], byStatus: [], openTickets: 0, breachedTickets: 0, contractsExpiring60: 0 });
  });
});
