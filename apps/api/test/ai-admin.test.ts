import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/core/app';
import { closeDb, withSystem, schema } from '../src/db/client';
import { purgeConversations } from '../src/jobs/processors/ai';
import { runAs } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal } from '../src/core/principal';
import { toolByName } from '../src/modules/ai/tools';
import { getPolicy } from '../src/modules/sla/policies';
import { withPolicyPause } from './_settings';

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
    expect(s.features).toContain('whatsapp_assistant');
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
    for (const k of ['turns', 'users', 'conversations', 'inputTokens', 'outputTokens', 'cacheHitPct', 'toolCalls', 'up', 'down', 'whatsappTurns']) expect(typeof u.totals[k]).toBe('number');
    expect(Array.isArray(u.series)).toBe(true);
    expect(Array.isArray(u.byTool)).toBe(true);
    expect(typeof u.guardrails.tenantFence).toBe('number');
    expect((await app.inject({ method: 'GET', url: '/api/ai/admin/usage?days=9999', headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(400);
  });

  it('upsert_config on sla-policies accepts the clocks and the waits that pause and refuses an unknown value', async () => {
    const [u] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(sql`${schema.users.email} = 'admin@msp.local'`).limit(1));
    invalidatePrincipal(u!.id);
    const principal = (await loadPrincipal(u!.id))!;
    const [policy] = await withSystem((tx) => tx.select({ id: schema.slaPolicies.id, name: schema.slaPolicies.name }).from(schema.slaPolicies).where(sql`${schema.slaPolicies.isDefault} = true`).limit(1));
    const tool = toolByName('upsert_config')!;
    const meta = { requestId: 'test-ai-admin' };
    await withPolicyPause(policy!.id, {}, async () => {
      const preview = await runAs(principal, meta, (ctx) => tool.preview!(ctx, { kind: 'sla-policies', record: policy!.name, fields: { pauseMetrics: ['resolution'], pauseWaitingOn: ['customer', 'internal'] } }));
      expect(typeof preview === 'string' ? preview : preview.text).toContain('pauseMetrics');
      await runAs(principal, meta, (ctx) => tool.run(ctx, { kind: 'sla-policies', record: policy!.name, fields: { pauseMetrics: ['resolution'], pauseWaitingOn: ['customer', 'internal'] } }));
      const after = await runAs(principal, meta, (ctx) => getPolicy(ctx, policy!.id));
      expect(after.pauseMetrics).toEqual(['resolution']);
      expect(after.pauseWaitingOn).toEqual(['customer', 'internal']);
      await expect(runAs(principal, meta, (ctx) => tool.run(ctx, { kind: 'sla-policies', record: policy!.name, fields: { pauseMetrics: ['speed'] } }))).rejects.toThrow(/Unknown clock/);
      await expect(runAs(principal, meta, (ctx) => tool.preview!(ctx, { kind: 'sla-policies', record: policy!.name, fields: { pauseSomething: ['x'] } }))).rejects.toThrow(/Unknown or protected field/);
    });
    const restored = await runAs(principal, meta, (ctx) => getPolicy(ctx, policy!.id));
    expect(restored.pauseMetrics).toEqual(['resolution', 'restoration']);
    // The six lifecycle settings are validated for the assistant.
    const setting = toolByName('update_setting')!;
    await expect(runAs(principal, meta, (ctx) => setting.preview!(ctx, { key: 'tickets.transition_rules', value: 'anything' }))).rejects.toThrow(/must be strict, standard or loose/);
    await expect(runAs(principal, meta, (ctx) => setting.preview!(ctx, { key: 'tickets.pending_reason_required', value: 'sometimes' }))).rejects.toThrow(/must be customer, always or never/);
    await expect(runAs(principal, meta, (ctx) => setting.preview!(ctx, { key: 'tickets.cancel_comment_required', value: 'yes' }))).rejects.toThrow(/must be true or false/);
    await expect(runAs(principal, meta, (ctx) => setting.preview!(ctx, { key: 'tickets.reopen_comment_required', value: 1 }))).rejects.toThrow(/must be true or false/);
    await expect(runAs(principal, meta, (ctx) => setting.preview!(ctx, { key: 'approvals.rejected_change', value: 'draft' }))).rejects.toThrow(/must be return or rejected/);
    await expect(runAs(principal, meta, (ctx) => setting.preview!(ctx, { key: 'approvals.rejection_note_required', value: 'staff' }))).rejects.toThrow(/must be none, portal or all/);
    expect(await runAs(principal, meta, (ctx) => setting.preview!(ctx, { key: 'tickets.transition_rules', value: 'strict' }))).toMatch(/from "standard" to "strict"/);
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
