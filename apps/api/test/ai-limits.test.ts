import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { buildApp } from '../src/core/app';
import { closeDb, withSystem, schema } from '../src/db/client';
import { runAs } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket } from '../src/modules/tickets/service';
import { toolByName } from '../src/modules/ai/tools';
import * as ai from '../src/modules/ai/service';
import type { AiProvider, ChatOptions, ChatResponse } from '../src/lib/ai';

/** The limits around the assistant, through the HTTP surface: the per-person rate limit, the daily budget, feature switches, protected settings. */

const S = Math.random().toString(36).slice(2, 8);
const quick: AiProvider = { name: 'quick', model: 'quick', async chat(_o: ChatOptions): Promise<ChatResponse> { return { text: 'ok', toolCalls: [], stopReason: 'end', usage: { inputTokens: 5, outputTokens: 5 } }; } };
let app: Awaited<ReturnType<typeof buildApp>>;
let token = '';
let admin: Principal;
let customerId = '';
let ticketId = '';
const H = () => ({ authorization: `Bearer ${token}` });
const setSettings = (body: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/ai/admin/settings', headers: H(), payload: body });

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  token = ((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@msp.local', password: 'Admin@12345' } })).json() as { accessToken: string }).accessToken;
  const [u] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1));
  invalidatePrincipal(u!.id);
  admin = (await loadPrincipal(u!.id))!;
  await withSystem(async (tx) => {
    const [c] = await tx.insert(schema.customers).values({ code: `LIM${S.toUpperCase()}`, name: `Limits Co ${S}` }).returning();
    customerId = c!.id;
  });
  ticketId = (await runAs(admin, { requestId: `t-${S}` }, (ctx) => createTicket(ctx, { type: 'incident', customerId, title: `Limits ticket ${S}`, description: 'probe' } as never))).id;
  ai.setProviderForTests(quick);
});
afterAll(async () => {
  ai.setProviderForTests(null);
  await setSettings({ assistantEnabled: true, dailyTokenBudget: 250000, disabledFeatures: [] });
  await withSystem(async (tx) => {
    await tx.delete(schema.aiConversations).where(eq(schema.aiConversations.userId, admin.id));
    await tx.delete(schema.tickets).where(eq(schema.tickets.customerId, customerId));
    await tx.delete(schema.customers).where(eq(schema.customers.id, customerId));
    await tx.delete(schema.systemSettings).where(like(schema.systemSettings.key, `%probe_${S}%`));
  });
  await app.close();
  await closeDb();
});

describe('limits', () => {
  it('allows 30 chat messages a minute per person and answers 429 on the 31st', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await app.inject({ method: 'POST', url: '/api/ai/chat', headers: H(), payload: { message: `ping ${i}` } })).statusCode);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('stops a person at their daily token budget with a clear code', async () => {
    expect((await setSettings({ dailyTokenBudget: 1 })).statusCode).toBe(200);
    const res = await app.inject({ method: 'POST', url: '/api/ai/chat', headers: { ...H(), 'x-forwarded-for': '10.9.9.9' }, payload: { message: 'over budget?' } });
    // 429 from the budget (the rate limiter is per person too; either way the person is stopped with a 429)
    expect(res.statusCode).toBe(429);
    const direct = await runAs(admin, { requestId: `b-${S}` }, (ctx) => ai.chat(ctx, { message: 'over budget?' })).catch((e: Error & { code?: string }) => ({ code: e.code }));
    expect((direct as { code?: string }).code).toBe('ai_budget_exceeded');
    await setSettings({ dailyTokenBudget: 250000 });
  });

  it('a feature switched off makes its suggestion route unavailable while the others keep working', async () => {
    await setSettings({ disabledFeatures: ['summarize'] });
    const off = await app.inject({ method: 'POST', url: `/api/ai/tickets/${ticketId}/summarize`, headers: H(), payload: {} });
    expect(off.statusCode).toBe(503);
    expect((off.json() as { error: string }).error).toBe('ai_feature_disabled');
    const on = await app.inject({ method: 'POST', url: `/api/ai/tickets/${ticketId}/duplicate-check`, headers: H(), payload: {} });
    expect(on.statusCode).toBe(200);
    await setSettings({ disabledFeatures: [] });
  });

  it('get_settings never returns protected keys, and update_setting refuses them and anything outside the allowlist', async () => {
    await withSystem((tx) => tx.insert(schema.systemSettings).values([
      { key: `smtp.probe_${S}.host`, value: 'mail.example' as never },
      { key: `security.probe_${S}`, value: 'x' as never },
      { key: `ai.probe_${S}.api_key`, value: 'k' as never },
      { key: `platform.probe_${S}`, value: 'visible' as never },
    ]));
    const read = toolByName('get_settings')!;
    const out = (await runAs(admin, { requestId: `s-${S}` }, (ctx) => read.run(ctx, { prefix: '' }))) as { settings: Record<string, unknown> };
    const keys = Object.keys(out.settings);
    expect(keys).toContain(`platform.probe_${S}`);
    expect(keys.some((k) => k.startsWith('smtp.') || k.startsWith('security.') || /api_key|secret|password|token/i.test(k))).toBe(false);
    const write = toolByName('update_setting')!;
    for (const key of [`smtp.probe_${S}.host`, `security.probe_${S}`, `ai.probe_${S}.api_key`, `users.probe_${S}`]) {
      await expect(runAs(admin, { requestId: `w-${S}` }, (ctx) => write.preview!(ctx, { key, value: 'x' }))).rejects.toThrow();
    }
    await expect(runAs(admin, { requestId: `w-${S}` }, (ctx) => write.preview!(ctx, { key: 'ai.autonomy', value: 'sometimes' }))).rejects.toThrow(/confirm_all or auto_low/);
    const ok = await runAs(admin, { requestId: `w-${S}` }, (ctx) => write.preview!(ctx, { key: 'ai.autonomy', value: 'auto_low' }));
    expect(String(typeof ok === 'string' ? ok : ok.text)).toContain('ai.autonomy');
  });
});
