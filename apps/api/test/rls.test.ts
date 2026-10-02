import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { withSystem, withTenant, schema, closeDb } from '../src/db/client';

/**
 * Defense-in-depth: PostgreSQL row-level security must hide other customers'
 * rows even when application code forgets to filter.
 */
describe('tenant row-level security', () => {
  let a: string;
  let b: string;
  let statusId: string;

  beforeAll(async () => {
    await withSystem(async (tx) => {
      const [ca] = await tx.insert(schema.customers).values({ code: `RLS-A-${Date.now()}`, name: 'RLS Customer A' }).returning();
      const [cb] = await tx.insert(schema.customers).values({ code: `RLS-B-${Date.now()}`, name: 'RLS Customer B' }).returning();
      a = ca.id;
      b = cb.id;
      const [st] = await tx.select().from(schema.configOptions).where(sql`${schema.configOptions.type} = 'ticket_status' and ${schema.configOptions.key} = 'new'`).limit(1);
      statusId = st.id;
      await tx.insert(schema.tickets).values([
        { number: `RLS-A-${Date.now()}`, type: 'incident', customerId: a, title: 'A ticket', statusId },
        { number: `RLS-B-${Date.now()}`, type: 'incident', customerId: b, title: 'B ticket', statusId },
      ]);
      await tx.insert(schema.assets).values([
        { customerId: a, tag: `RLS-A-${Date.now()}`, name: 'asset a' },
        { customerId: b, tag: `RLS-B-${Date.now()}`, name: 'asset b' },
      ]);
    });
  });

  afterAll(async () => {
    await withSystem(async (tx) => {
      await tx.delete(schema.tickets).where(sql`${schema.tickets.customerId} in (${a}, ${b})`);
      await tx.delete(schema.assets).where(sql`${schema.assets.customerId} in (${a}, ${b})`);
      await tx.delete(schema.customers).where(eq(schema.customers.id, a));
      await tx.delete(schema.customers).where(eq(schema.customers.id, b));
    });
    await closeDb();
  });

  it('a principal scoped to customer A cannot see customer B rows even with unfiltered queries', async () => {
    await withTenant({ userId: null, allCustomers: false, customerIds: [a] }, async (tx) => {
      const customers = await tx.select().from(schema.customers).where(sql`${schema.customers.id} in (${a}, ${b})`);
      expect(customers.map((c) => c.id)).toEqual([a]);
      const tickets = await tx.select().from(schema.tickets).where(sql`${schema.tickets.customerId} in (${a}, ${b})`);
      expect(tickets.every((t) => t.customerId === a)).toBe(true);
      expect(tickets.length).toBe(1);
      const assets = await tx.select().from(schema.assets).where(sql`${schema.assets.customerId} in (${a}, ${b})`);
      expect(assets.length).toBe(1);
      // Raw SQL goes through the same policy.
      const raw = await tx.execute(sql`select count(*)::int as n from tickets where customer_id = ${b}`);
      expect((raw.rows[0] as { n: number }).n).toBe(0);
    });
  });

  it('writes for another customer are rejected by the policy', async () => {
    let caught: unknown;
    try {
      await withTenant({ userId: null, allCustomers: false, customerIds: [a] }, async (tx) => {
        await tx.insert(schema.tickets).values({ number: `RLS-X-${Date.now()}`, type: 'incident', customerId: b, title: 'leak attempt', statusId });
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    const cause = (caught as { cause?: { code?: string; message?: string } }).cause ?? (caught as { code?: string; message?: string });
    expect(cause.code).toBe('42501');
    expect(String(cause.message)).toMatch(/row-level security/);
  });

  it('no context means no customer data (fail closed)', async () => {
    await withTenant({ userId: null, allCustomers: false, customerIds: [] }, async (tx) => {
      const rows = await tx.select().from(schema.tickets).where(sql`${schema.tickets.customerId} in (${a}, ${b})`);
      expect(rows.length).toBe(0);
    });
  });

  it('system context sees everything', async () => {
    const n = await withSystem(async (tx) => (await tx.select().from(schema.tickets).where(sql`${schema.tickets.customerId} in (${a}, ${b})`)).length);
    expect(n).toBe(2);
  });
});
