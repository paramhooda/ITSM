import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/core/app';
import { closeDb, withSystem, schema } from '../src/db/client';
import { purgeConversations } from '../src/jobs/processors/ai';

/** The administrator's control surface: settings round trip with validation, the usage report, the retention job. */

let app: Awaited<ReturnType<typeof buildApp>>;
let admin = '';
let portal = '';
const login = async (email: string, password: string) => ((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).json() as { accessToken: string }).accessToken;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  admin = await login('admin@msp.local', 'Admin@12345');
  const [u] = await withSystem((tx) => tx.select({ email: schema.users.email }).from(schema.users).where(sql`${schema.users.userType} = 'customer' AND ${schema.users.status} = 'active'`).limit(1));
  if (u) {
    await withSystem((tx) => tx.execute(sql`UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = 'admin@msp.local') WHERE email = ${u.email}`));
    portal = await login(u.email, 'Admin@12345');
  }
});
afterAll(async () => {
  await app.inject({ method: 'PUT', url: '/api/ai/admin/settings', headers: { authorization: `Bearer ${admin}` }, payload: { assistantEnabled: true, autonomy: 'confirm_all', dailyTokenBudget: 250000, retentionDays: 90, disabledFeatures: [] } });
  await app.close();
  await closeDb();
});

describe('AI administration', () => {
  it('reads and writes the assistant settings with validation, and the kill switch takes effect at once', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/ai/admin/settings', headers: { authorization: `Bearer ${admin}` } });
    expect(before.statusCode).toBe(200);
    const s = before.json() as { assistantEnabled: boolean; features: string[]; rateLimitPerMinute: number };
    expect(s.features).toContain('summarize');
    expect(s.rateLimitPerMinute).toBe(30);

    const bad = await app.inject({ method: 'PUT', url: '/api/ai/admin/settings', headers: { authorization: `Bearer ${admin}` }, payload: { retentionDays: 3 } });
    expect(bad.statusCode).toBe(400);
    const bad2 = await app.inject({ method: 'PUT', url: '/api/ai/admin/settings', headers: { authorization: `Bearer ${admin}` }, payload: { autonomy: 'yolo' } });
    expect(bad2.statusCode).toBe(400);

    const off = await app.inject({ method: 'PUT', url: '/api/ai/admin/settings', headers: { authorization: `Bearer ${admin}` }, payload: { assistantEnabled: false, autonomy: 'auto_low', disabledFeatures: ['summarize'], dailyTokenBudget: 1000, retentionDays: 0 } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ assistantEnabled: false, autonomy: 'auto_low', disabledFeatures: ['summarize'], dailyTokenBudget: 1000, retentionDays: 0 });
    const status = (await app.inject({ method: 'GET', url: '/api/ai/status', headers: { authorization: `Bearer ${admin}` } })).json() as { enabled: boolean; assistantEnabled: boolean; features: string[] };
    expect(status.assistantEnabled).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.features).not.toContain('summarize');
    const chat = await app.inject({ method: 'POST', url: '/api/ai/chat', headers: { authorization: `Bearer ${admin}` }, payload: { message: 'hello' } });
    expect(chat.statusCode).toBe(503);
    expect((chat.json() as { error: string }).error).toBe('ai_disabled');
  });

  it('is closed to portal users and to staff without the admin permissions', async () => {
    if (portal) {
      expect((await app.inject({ method: 'GET', url: '/api/ai/admin/usage', headers: { authorization: `Bearer ${portal}` } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url: '/api/ai/admin/settings', headers: { authorization: `Bearer ${portal}` }, payload: { assistantEnabled: true } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/ai/admin/usage' })).statusCode).toBe(401);
  });

  it('reports usage with a day series, per-tool counts and guardrail events', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ai/admin/usage?days=7', headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(200);
    const u = res.json() as { days: number; totals: Record<string, number>; series: { day: string }[]; byTool: unknown[]; guardrails: { tenantFence: number; outcomes: Record<string, number> } };
    expect(u.days).toBe(7);
    for (const k of ['turns', 'users', 'conversations', 'inputTokens', 'outputTokens', 'cacheHitPct', 'toolCalls', 'up', 'down']) expect(typeof u.totals[k]).toBe('number');
    expect(Array.isArray(u.series)).toBe(true);
    expect(Array.isArray(u.byTool)).toBe(true);
    expect(typeof u.guardrails.tenantFence).toBe('number');
    expect((await app.inject({ method: 'GET', url: '/api/ai/admin/usage?days=9999', headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(400);
  });

  it('the retention job deletes conversations older than the setting, keeps everything at 0, and never goes below 7 days', async () => {
    const [u] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(sql`${schema.users.email} = 'admin@msp.local'`).limit(1));
    const insert = (daysOld: number) => withSystem(async (tx) => {
      const [c] = await tx.insert(schema.aiConversations).values({ userId: u!.id, customerId: null, title: `purge test ${daysOld}`, context: {}, createdAt: new Date(Date.now() - daysOld * 86_400_000), updatedAt: new Date(Date.now() - daysOld * 86_400_000) }).returning({ id: schema.aiConversations.id });
      await tx.insert(schema.aiMessages).values({ conversationId: c!.id, customerId: null, role: 'user', content: 'old', createdAt: new Date(Date.now() - daysOld * 86_400_000) });
      return c!.id;
    });
    const old = await insert(40);
    const fresh = await insert(2);
    const setRetention = (v: number) => withSystem((tx) => tx.execute(sql`INSERT INTO system_settings (key, value) VALUES ('ai.conversation_retention_days', ${JSON.stringify(v)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`));
    await setRetention(0);
    expect(await withSystem(purgeConversations)).toEqual({ days: 0, deleted: 0 });
    await setRetention(3);
    const r = await withSystem(purgeConversations);
    expect(r.days).toBe(7);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    await setRetention(30);
    const r2 = await withSystem(purgeConversations);
    expect(r2.days).toBe(30);
    expect(r2.deleted).toBe(0);
    const left = await withSystem((tx) => tx.select({ id: schema.aiConversations.id }).from(schema.aiConversations).where(sql`${schema.aiConversations.id} IN (${old}, ${fresh})`));
    expect(left.map((x) => x.id)).toEqual([fresh]);
    const msgs = await withSystem((tx) => tx.select({ id: schema.aiMessages.id }).from(schema.aiMessages).where(sql`${schema.aiMessages.conversationId} = ${old}`));
    expect(msgs).toHaveLength(0);
    await setRetention(90);
  });
});
