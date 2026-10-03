/**
 * WhatsApp notifications: opt-in fan-out, delivery through a stubbed Meta Cloud API,
 * delivery callbacks and secret masking. Run with the dev environment sourced:
 *   npx vitest run test/whatsapp.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { encryptSecret } from '../src/lib/crypto';
import { queueNotification } from '../src/modules/notifications/dispatch';
import { resetWhatsAppSettingsCache, applyWhatsAppStatuses, verifyWebhookSignature, templateForEvent, loadWhatsAppSettings, whatsappStatus, resolveWebhookUrl } from '../src/modules/notifications/channels';
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

  it('delivers through the Cloud API and records the provider message id', async () => {
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
