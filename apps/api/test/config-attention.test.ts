import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { schema, withSystem, closeDb } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, type Principal } from '../src/core/principal';
import * as config from '../src/modules/config/service';

/**
 * DB-backed test for the admin "needs attention" feed behind GET /admin/attention.
 * Requires the dev environment (DATABASE_URL etc.) with migrations + seed.
 */
const hasDb = !!process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('x');

describe.skipIf(!hasDb)('admin attention feed (database)', () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  let admin: Principal;
  const outboxIds: string[] = [];
  const keyIds: string[] = [];
  const as = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `test-${suffix}`, source: 'api' }, fn);

  beforeAll(async () => {
    await withSystem(async (tx) => {
      const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
      if (!adminUser) throw new Error('admin user missing (seed not applied?)');
      const p = await loadPrincipal(adminUser.id);
      if (!p) throw new Error('could not load admin principal');
      admin = p;
      const [failed] = await tx.insert(schema.notificationOutbox).values({ channel: 'email', event: `test.${suffix}`, recipient: `nobody-${suffix}@example.invalid`, subject: 'attention test', body: 'x', status: 'failed', attempts: 3, lastError: 'smtp refused' }).returning({ id: schema.notificationOutbox.id });
      outboxIds.push(failed.id);
      const keys = await tx
        .insert(schema.apiKeys)
        .values([
          { name: `expiring-${suffix}`, keyPrefix: `tk_${suffix}a`, keyHash: `hash-${suffix}-a`, permissions: ['tickets:read'], expiresAt: new Date(Date.now() + 3 * 86_400_000) },
          { name: `expired-${suffix}`, keyPrefix: `tk_${suffix}b`, keyHash: `hash-${suffix}-b`, permissions: ['tickets:read'], expiresAt: new Date(Date.now() - 86_400_000) },
          { name: `far-${suffix}`, keyPrefix: `tk_${suffix}c`, keyHash: `hash-${suffix}-c`, permissions: ['tickets:read'], expiresAt: new Date(Date.now() + 90 * 86_400_000) },
          { name: `revoked-${suffix}`, keyPrefix: `tk_${suffix}d`, keyHash: `hash-${suffix}-d`, permissions: ['tickets:read'], expiresAt: new Date(Date.now() - 86_400_000), revokedAt: new Date() },
        ])
        .returning({ id: schema.apiKeys.id });
      keyIds.push(...keys.map((k) => k.id));
    });
  });

  afterAll(async () => {
    await withSystem(async (tx) => {
      if (outboxIds.length) await tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.id, outboxIds));
      if (keyIds.length) await tx.delete(schema.apiKeys).where(inArray(schema.apiKeys.id, keyIds));
    });
    await closeDb();
  });

  it('returns only actionable items, each with key, label, count, tone and a link', async () => {
    const res = await as((ctx) => config.attention(ctx));
    expect(Array.isArray(res.items)).toBe(true);
    const keys = res.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const item of res.items) {
      expect(item).toMatchObject({ key: expect.any(String), label: expect.any(String), count: expect.any(Number), to: expect.stringMatching(/^\//) });
      expect(['bad', 'warn', 'info']).toContain(item.tone);
      expect(item.count).toBeGreaterThan(0);
    }
  });

  it('counts failed deliveries from the last 24 hours and keys expired or expiring within 14 days', async () => {
    const res = await as((ctx) => config.attention(ctx));
    const outbox = res.items.find((i) => i.key === 'outbox_failed');
    expect(outbox).toMatchObject({ tone: 'bad', to: expect.stringContaining('/admin/outbox') });
    expect(outbox!.count).toBeGreaterThanOrEqual(1);
    const keys = res.items.find((i) => i.key === 'api_keys_expiring');
    expect(keys).toMatchObject({ tone: 'warn', to: '/admin/api-keys' });
    // the far-future and the revoked key do not count; the expiring + expired ones do
    expect(keys!.count).toBeGreaterThanOrEqual(2);

    await withSystem((tx) => tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.id, outboxIds)));
    outboxIds.length = 0;
    const after = await as((ctx) => config.attention(ctx));
    const outboxAfter = after.items.find((i) => i.key === 'outbox_failed');
    expect(outboxAfter?.count ?? 0).toBe(outbox!.count - 1);
  });
});
