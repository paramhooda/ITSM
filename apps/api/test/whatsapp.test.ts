/**
 * WhatsApp notifications: opt-in fan-out, delivery through a stubbed Meta Cloud API,
 * delivery callbacks and secret masking. Run with the dev environment sourced:
 *   npx vitest run test/whatsapp.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { encryptSecret } from '../src/lib/crypto';
import { queueNotification } from '../src/modules/notifications/dispatch';
import { resetWhatsAppSettingsCache, applyWhatsAppStatuses, verifyWebhookSignature, templateForEvent, loadWhatsAppSettings, whatsappStatus, resolveWebhookUrl, sendWhatsAppTest, explainWhatsAppError, expectedParamCount, whatsappMessageStatus, whatsappDiagnostics, rulesWithoutWhatsApp, enableWhatsAppOnRules } from '../src/modules/notifications/channels';
import { PermanentChannelError } from '../src/lib/channels';
import { deliverOutbox } from '../src/jobs/processors/notifications';
import { listSettings, updateSettings } from '../src/modules/config/service';
import { config } from '../src/config';
import { normalizePhone } from '../src/lib/channels';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-whatsapp-${S}`, ip: '127.0.0.1' };
let admin: Principal;
const ids = { customer: '', optedIn: '', optedOut: '' };
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);

async function setSettings(values: Record<string, unknown>) {
  await withSystem(async (tx) => {
    for (const [key, value] of Object.entries(values)) {
      await tx.insert(schema.systemSettings).values({ key, value: value as never }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: value as never, updatedAt: new Date() } });
    }
  });
  resetWhatsAppSettingsCache();
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [c] = await tx.insert(schema.customers).values({ code: `WA${S.toUpperCase()}`, name: `WhatsApp Customer ${S}` }).returning();
    ids.customer = c!.id;
    const [u1] = await tx.insert(schema.users).values({ email: `wa-in-${S}@example.test`, name: 'Opted In', userType: 'customer', customerId: c!.id, phone: '+919876543210', whatsappOptIn: true, whatsappOptedInAt: new Date() }).returning();
    const [u2] = await tx.insert(schema.users).values({ email: `wa-out-${S}@example.test`, name: 'Opted Out', userType: 'customer', customerId: c!.id, phone: '+919876543211', whatsappOptIn: false }).returning();
    ids.optedIn = u1!.id;
    ids.optedOut = u2!.id;
    const [a] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    invalidatePrincipal(a!.id);
    admin = (await loadPrincipal(a!.id))!;
  });
  await setSettings({
    'whatsapp.enabled': true,
    'whatsapp.phone_number_id': '100200300',
    'whatsapp.access_token.secret': encryptSecret('test-token'),
    'whatsapp.app.secret': encryptSecret('app-secret'),
    'whatsapp.verify_token.secret': encryptSecret('verify-me'),
    'whatsapp.templates': { default: { name: 'progression_update', language: 'en', params: ['subject', 'text', 'link'] } },
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await withSystem(async (tx) => {
    await tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.recipient, ['+919876543210', '+919876543211', `wa-in-${S}@example.test`, `wa-out-${S}@example.test`]));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.optedIn, ids.optedOut]));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
  });
  await setSettings({ 'whatsapp.enabled': false });
  await closeDb();
});

const ticketData = { ticket: { number: `INC-${S}`, title: 'Printer offline', typeLabel: 'Incident', customerName: 'WhatsApp Customer', priority: 'P3 - Medium', status: 'New', link: 'http://localhost/portal/tickets/x', resolutionNotes: '', service: '', assignee: '' }, actor: 'Service Desk', comment: '', previousStatus: '', level: 0, reason: '', sla: { metric: '', dueAt: '', pct: 0 }, reopenDays: 14 };

describe('phone numbers', () => {
  it('normalises Indian and international numbers to E.164', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('098765 43210')).toBe('+919876543210');
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});

describe('templates', () => {
  it('maps an event to its group, then the default, with parameters in template order', async () => {
    const settings = await withSystem((tx) => loadWhatsAppSettings(tx));
    const t = templateForEvent({ ...settings, templates: { default: { name: 'd', params: ['text', 'subject'] }, sla: { name: 's', language: 'en_US' } } }, 'sla.breached', { subject: 'Subj', text: 'Line one\nline two', link: 'http://x' });
    expect(t).toEqual({ name: 's', language: 'en_US', params: ['Subj', 'Line one · line two', 'http://x'] });
    const d = templateForEvent({ ...settings, templates: { default: { name: 'd', params: ['text', 'subject'] } } }, 'ticket.created', { subject: 'Subj', text: 'Body', link: 'http://x' });
    expect(d).toEqual({ name: 'd', language: 'en', params: ['Body', 'Subj'] });
    expect(templateForEvent({ ...settings, templates: {} }, 'ticket.created', { subject: 'a', text: 'b', link: 'c' })).toBeNull();
    // an explicit empty list is a template without placeholders; a missing list takes the default order
    expect(templateForEvent({ ...settings, templates: { default: { name: 'hello_world', language: 'en_US', params: [] } } }, 'ticket.created', { subject: 'a', text: 'b', link: 'c' })).toEqual({ name: 'hello_world', language: 'en_US', params: [] });
    expect(templateForEvent({ ...settings, templates: { default: { name: 'd' } } }, 'ticket.created', { subject: 'a', text: 'b', link: 'c' })!.params).toEqual(['a', 'b', 'c']);
  });

  it('explains a parameter-count rejection and the other permanent refusals in terms of the mapping', () => {
    const msg = 'WhatsApp 400 (code 132000): (#132000) Number of parameters does not match the expected number of params (body: number of localizable_params (3) does not match the expected number of params (0))';
    expect(expectedParamCount(msg)).toBe(0);
    expect(expectedParamCount('something else')).toBeNull();
    const tpl = { name: 'hello_world', language: 'en_US', params: ['a', 'b', 'c'] };
    const text = explainWhatsAppError(new PermanentChannelError(msg, 132000), tpl);
    expect(text).toContain('"hello_world" (en_US)');
    expect(text).toContain('0 body placeholders');
    expect(text).toContain('sends 3 parameters');
    expect(text).toContain('leave the list empty');
    expect(explainWhatsAppError(new PermanentChannelError('WhatsApp 400 (code 132001): Template name does not exist', 132001), tpl)).toContain('does not exist for language en_US');
    expect(explainWhatsAppError(new Error('boom'), tpl)).toBe('WhatsApp refused the message: boom');
  });

  it('the test message retries once without parameters when Meta says the template has no placeholders', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      bodies.push(body);
      const components = (body.template as { components: unknown[] }).components;
      if (components.length) return new Response(JSON.stringify({ error: { message: '(#132000) Number of parameters does not match the expected number of params', code: 132000, error_data: { details: 'body: number of localizable_params (3) does not match the expected number of params (0)' } } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.test.${S}` }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    try {
      const r = await asAdmin((ctx) => sendWhatsAppTest(ctx, '9876543210'));
      expect(r).toMatchObject({ ok: true, to: '+919876543210', template: 'progression_update', providerMessageId: `wamid.test.${S}` });
      expect(r.note).toContain('no placeholders');
      expect(bodies.length).toBe(2);
      expect((bodies[1]!.template as { components: unknown[] }).components).toEqual([]);
      // the test is an outbox row, so the status callback can mark it delivered or failed with the reason
      const row = await asAdmin((ctx) => whatsappMessageStatus(ctx, r.outboxId));
      expect(row).toMatchObject({ recipient: '+919876543210', status: 'sent', deliveryStatus: 'accepted', providerMessageId: `wamid.test.${S}` });
      await applyWhatsAppStatuses({ entry: [{ changes: [{ value: { statuses: [{ id: `wamid.test.${S}`, status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }] } }] }] });
      const failed = await asAdmin((ctx) => whatsappMessageStatus(ctx, r.outboxId));
      expect(failed.deliveryStatus).toBe('failed');
      expect(failed.lastError).toContain('131026 Message undeliverable');
      expect(failed.lastError).toContain('no WhatsApp account');
      // any other refusal comes back as a validation error with the explanation, not a 500
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Template name does not exist in the translation', code: 132001 } }), { status: 400, headers: { 'Content-Type': 'application/json' } })));
      await expect(asAdmin((ctx) => sendWhatsAppTest(ctx, '9876543210'))).rejects.toThrow(/does not exist for language en/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('connection check', () => {
  it('reads the number, the templates and the webhook subscription from Meta and compares them with the mapping', async () => {
    await setSettings({ 'whatsapp.business_account_id': '555666777', 'whatsapp.templates': { default: { name: 'progression_update', language: 'en', params: ['subject', 'text', 'link'] }, sla: { name: 'hello_world', language: 'en_US', params: ['subject'] }, page: { name: 'missing_one', language: 'en', params: [] } } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/100200300?')) return json({ display_phone_number: '+91 11 4000 0000', verified_name: 'Progression', quality_rating: 'GREEN', status: 'CONNECTED', code_verification_status: 'VERIFIED', name_status: 'APPROVED', messaging_limit_tier: 'TIER_1K' });
      if (u.includes('/555666777/message_templates')) return json({ data: [{ name: 'progression_update', status: 'PENDING', category: 'UTILITY', language: 'en', components: [{ type: 'BODY', text: '{{1}}: {{2}} {{3}}' }] }, { name: 'hello_world', status: 'APPROVED', category: 'MARKETING', language: 'en_US', components: [{ type: 'BODY', text: 'Welcome and congratulations!' }] }] });
      if (u.includes('/555666777/subscribed_apps')) return json({ data: [] });
      return new Response(JSON.stringify({ error: { message: 'unexpected', code: 100 } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }));
    try {
      const d = await asAdmin((ctx) => whatsappDiagnostics(ctx));
      const texts = d.findings.map((f) => `${f.level}: ${f.text}`);
      expect(texts.some((t) => t.startsWith('ok: Token and phone number id work: +91 11 4000 0000'))).toBe(true);
      expect(texts.some((t) => t.startsWith('error: Template "progression_update" (en) is PENDING'))).toBe(true);
      expect(texts.some((t) => t.includes('Template "hello_world" has 0 body placeholders but the sla mapping sends 1 parameter'))).toBe(true);
      expect(texts.some((t) => t.includes('"hello_world" is a MARKETING template'))).toBe(true);
      expect(texts.some((t) => t.startsWith('error: Template "missing_one" (page) does not exist'))).toBe(true);
      expect(texts.some((t) => t.startsWith('error: No app is subscribed'))).toBe(true);
      expect(d.phone).toMatchObject({ status: 'CONNECTED' });
    } finally {
      vi.unstubAllGlobals();
      await setSettings({ 'whatsapp.business_account_id': '', 'whatsapp.templates': { default: { name: 'progression_update', language: 'en', params: ['subject', 'text', 'link'] } } });
    }
  });
});

describe('rules', () => {
  it('lists active rules whose event has a WhatsApp text but no WhatsApp channel, and adds the channel on request', async () => {
    const name = `Resolved without WhatsApp ${S}`;
    const [rule] = await withSystem((tx) => tx.insert(schema.notificationRules).values({ event: 'ticket.resolved', name, recipients: { requester: true }, channels: ['email', 'in_app'], isActive: true }).returning({ id: schema.notificationRules.id }));
    try {
      const before = await asAdmin((ctx) => whatsappStatus(ctx));
      expect(before.rulesWithoutWhatsApp.some((r) => r.id === rule!.id && r.event === 'ticket.resolved')).toBe(true);
      const res = await asAdmin((ctx) => enableWhatsAppOnRules(ctx));
      expect(res.updated).toBeGreaterThanOrEqual(1);
      expect(res.rules.some((r) => r.id === rule!.id)).toBe(true);
      const [after] = await withSystem((tx) => tx.select({ channels: schema.notificationRules.channels }).from(schema.notificationRules).where(eq(schema.notificationRules.id, rule!.id)));
      expect(after!.channels).toEqual(['email', 'in_app', 'whatsapp']);
      const again = await withSystem((tx) => rulesWithoutWhatsApp(tx));
      expect(again.some((r) => r.id === rule!.id)).toBe(false);
      // an inactive rule is never reported
      await withSystem((tx) => tx.update(schema.notificationRules).set({ channels: ['email'], isActive: false }).where(eq(schema.notificationRules.id, rule!.id)));
      expect((await withSystem((tx) => rulesWithoutWhatsApp(tx))).some((r) => r.id === rule!.id)).toBe(false);
    } finally {
      await withSystem((tx) => tx.delete(schema.notificationRules).where(eq(schema.notificationRules.id, rule!.id)));
    }
  });
});

describe('fan-out and delivery', () => {
  it('writes one WhatsApp row for the opted-in recipient and none for the other', async () => {
    const queued = await withSystem((tx) =>
      queueNotification(tx, {
        event: 'ticket.created',
        recipients: [
          { userId: ids.optedIn, email: `wa-in-${S}@example.test`, name: 'Opted In', phone: '+919876543210', whatsappOptIn: true },
          { userId: ids.optedOut, email: `wa-out-${S}@example.test`, name: 'Opted Out', phone: '+919876543211', whatsappOptIn: false },
        ],
        data: ticketData,
        customerId: ids.customer,
        channels: ['email', 'whatsapp'],
        link: '/portal/tickets/x',
      }),
    );
    expect(queued).toBe(3); // two emails, one WhatsApp
    const rows = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.channel, 'whatsapp')));
    const mine = rows.filter((r) => r.recipient === '+919876543210' && r.event === 'ticket.created' && (r.subject ?? '').includes(S));
    expect(mine).toHaveLength(1);
    const payload = mine[0]!.payload as { template: { name: string; params: string[] }; link: string };
    expect(payload.template.name).toBe('progression_update');
    expect(payload.template.params[0]).toBe(`INC-${S} logged`);
    expect(payload.template.params[1]).toContain('Printer offline');
    expect(payload.template.params[2]).toMatch(/\/portal\/tickets\/x$/);
    expect(rows.some((r) => r.recipient === '+919876543211' && (r.subject ?? '').includes(S))).toBe(false);
  });

  it('skips WhatsApp for an opted-in person who switched the category off on their profile, and still writes the email', async () => {
    await withSystem((tx) => tx.update(schema.users).set({ preferences: { notifications: { tickets: { whatsapp: false } } } }).where(eq(schema.users.id, ids.optedIn)));
    try {
      const queued = await withSystem((tx) =>
        queueNotification(tx, {
          event: 'ticket.created',
          recipients: [{ userId: ids.optedIn, email: `wa-in-${S}@example.test`, name: 'Opted In', phone: '+919876543210', whatsappOptIn: true }],
          data: { ...ticketData, ticket: { ...ticketData.ticket, number: `INC-${S}-veto` } },
          customerId: ids.customer,
          channels: ['email', 'whatsapp'],
          link: '/portal/tickets/x',
        }),
      );
      expect(queued).toBe(1); // the email only
      const rows = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.recipient, '+919876543210'), eq(schema.notificationOutbox.channel, 'whatsapp'))));
      expect(rows.some((r) => (r.subject ?? '').includes(`INC-${S}-veto`))).toBe(false);
      const emails = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.recipient, `wa-in-${S}@example.test`), eq(schema.notificationOutbox.channel, 'email'))));
      expect(emails.some((r) => (r.subject ?? '').includes(`INC-${S}-veto`))).toBe(true);
    } finally {
      await withSystem((tx) => tx.update(schema.users).set({ preferences: {} }).where(eq(schema.users.id, ids.optedIn)));
    }
  });

  /** The outbox job takes the oldest pending rows first; dating this test's rows back keeps them ahead of whatever other suites queued in parallel. */
  const deliverFirst = () => withSystem((tx) => tx.update(schema.notificationOutbox).set({ scheduledAt: new Date(Date.now() - 3_600_000) }).where(and(eq(schema.notificationOutbox.recipient, '+919876543210'), eq(schema.notificationOutbox.status, 'pending'))));

  it('delivers through the Cloud API and records the provider message id', async () => {
    await deliverFirst();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${S}` }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    await deliverOutbox(200);
    const [row] = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.providerMessageId, `wamid.${S}`)));
    expect(row).toBeTruthy();
    expect(row!.status).toBe('sent');
    expect(row!.deliveryStatus).toBe('accepted');
    const call = calls.find((c) => c.url.includes('/100200300/messages'));
    expect(call).toBeTruthy();
    expect(call!.body).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'template' });
    expect((call!.body.template as { name: string }).name).toBe('progression_update');
  });

  it('applies delivery callbacks and verifies the signature', async () => {
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: `wamid.${S}`, status: 'delivered' }] } }] }] };
    expect(await applyWhatsAppStatuses(payload)).toBe(1);
    const [row] = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.providerMessageId, `wamid.${S}`)));
    expect(row!.deliveryStatus).toBe('delivered');
    const raw = JSON.stringify(payload);
    const good = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
    expect(verifyWebhookSignature(raw, good, 'app-secret')).toBe(true);
    expect(verifyWebhookSignature(raw, 'sha256=00', 'app-secret')).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, '')).toBe(true);
  });

  it('gives up immediately on a permanent provider error', async () => {
    await withSystem((tx) =>
      queueNotification(tx, { event: 'ticket.closed', recipients: [{ userId: ids.optedIn, phone: '+919876543210', whatsappOptIn: true }], data: ticketData, customerId: ids.customer, channels: ['whatsapp'] }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Template name does not exist', code: 132001 } }), { status: 400, headers: { 'Content-Type': 'application/json' } })));
    await deliverFirst();
    await deliverOutbox(200);
    const rows = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.event, 'ticket.closed')));
    const mine = rows.find((r) => r.recipient === '+919876543210' && (r.subject ?? '').includes(S));
    expect(mine!.status).toBe('failed');
    expect(mine!.attempts).toBe(1);
    expect(mine!.lastError).toContain('132001');
  });

  it('masks the access token in the settings list', async () => {
    const rows = await asAdmin((ctx) => listSettings(ctx));
    expect(rows.find((r) => r.key === 'whatsapp.access_token.secret')!.value).toBe('********');
    expect(String(rows.find((r) => r.key === 'whatsapp.phone_number_id')!.value)).toBe('100200300');
  });
});

describe('webhook url', () => {
  const expectedDefault = `${config.APP_URL.replace(/\/$/, '')}/api/webhooks/whatsapp`;

  it('derives the default from APP_URL and appends the route to an origin-only override', () => {
    expect(resolveWebhookUrl('')).toBe(expectedDefault);
    expect(resolveWebhookUrl('https://abcd.ngrok-free.app')).toBe('https://abcd.ngrok-free.app/api/webhooks/whatsapp');
    expect(resolveWebhookUrl('https://abcd.ngrok-free.app/')).toBe('https://abcd.ngrok-free.app/api/webhooks/whatsapp');
    expect(resolveWebhookUrl('https://abcd.ngrok-free.app/hooks/wa')).toBe('https://abcd.ngrok-free.app/hooks/wa');
  });

  it('reports the override through the status and goes back to the default when cleared', async () => {
    await asAdmin((ctx) => updateSettings(ctx, { 'whatsapp.webhook_url': 'https://abcd.ngrok-free.app' }));
    const custom = await asAdmin((ctx) => whatsappStatus(ctx));
    expect(custom.webhookUrl).toBe('https://abcd.ngrok-free.app/api/webhooks/whatsapp');
    expect(custom.webhookUrlIsCustom).toBe(true);
    expect(custom.webhookUrlDefault).toBe(expectedDefault);
    expect(custom.missing.some((m) => m.includes('public webhook URL'))).toBe(false);

    await asAdmin((ctx) => updateSettings(ctx, { 'whatsapp.webhook_url': '' }));
    const plain = await asAdmin((ctx) => whatsappStatus(ctx));
    expect(plain.webhookUrl).toBe(expectedDefault);
    expect(plain.webhookUrlIsCustom).toBe(false);
    // the test APP_URL is local, which the page flags as still needed
    expect(plain.missing.some((m) => m.includes('public webhook URL'))).toBe(/localhost|127\.0\.0\.1/.test(expectedDefault));
  });

  it('rejects an override that is not an http(s) URL', async () => {
    await expect(asAdmin((ctx) => updateSettings(ctx, { 'whatsapp.webhook_url': 'abcd.ngrok-free.app' }))).rejects.toThrow(/full URL/);
    await expect(asAdmin((ctx) => updateSettings(ctx, { 'whatsapp.webhook_url': 'ftp://abcd.ngrok-free.app' }))).rejects.toThrow(/https/);
    const after = await asAdmin((ctx) => whatsappStatus(ctx));
    expect(after.webhookUrlIsCustom).toBe(false);
  });
});
