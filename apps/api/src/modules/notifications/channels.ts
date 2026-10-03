import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema, withSystem } from '@/db/client';
import type { Ctx } from '@/core/context';
import { config } from '@/config';
import { decryptSecret } from '@/lib/crypto';
import { logger } from '@/core/logger';
import { ValidationError } from '@/core/errors';
import { normalizePhone, templateParam, sendWhatsAppTemplate, type TemplateRef, type WhatsAppConfig } from '@/lib/channels';

/**
 * WhatsApp is configured once by an administrator in system settings; everyone
 * else only adds a phone number and opts in. This module reads that configuration,
 * resolves the approved template for an event, sends test messages and records
 * delivery callbacks from Meta.
 */

export interface WhatsAppTemplateMap {
  [group: string]: { name: string; language?: string; params?: string[] } | undefined;
}

export interface WhatsAppSettings {
  enabled: boolean;
  configured: boolean;
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  apiVersion: string;
  defaultCountryCode: string;
  templates: WhatsAppTemplateMap;
}

const KEYS = ['whatsapp.enabled', 'whatsapp.phone_number_id', 'whatsapp.business_account_id', 'whatsapp.access_token.secret', 'whatsapp.app.secret', 'whatsapp.verify_token.secret', 'whatsapp.api_version', 'whatsapp.default_country_code', 'whatsapp.templates'];

let cache: { at: number; value: WhatsAppSettings } | null = null;
const CACHE_MS = 30_000;

/** Forget the cached settings (after an admin saves them, and in tests). */
export function resetWhatsAppSettingsCache() {
  cache = null;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v));
const secret = (v: unknown) => {
  const s = str(v);
  return s ? decryptSecret(s) : '';
};

export async function loadWhatsAppSettings(tx: Tx): Promise<WhatsAppSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, KEYS));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const templates = (get('whatsapp.templates') ?? {}) as WhatsAppTemplateMap;
  const value: WhatsAppSettings = {
    enabled: get('whatsapp.enabled') === true,
    configured: false,
    phoneNumberId: str(get('whatsapp.phone_number_id')),
    businessAccountId: str(get('whatsapp.business_account_id')),
    accessToken: secret(get('whatsapp.access_token.secret')),
    appSecret: secret(get('whatsapp.app.secret')),
    verifyToken: secret(get('whatsapp.verify_token.secret')),
    apiVersion: str(get('whatsapp.api_version')) || 'v21.0',
    defaultCountryCode: str(get('whatsapp.default_country_code')) || '91',
    templates: typeof templates === 'object' && templates ? templates : {},
  };
  value.configured = !!(value.phoneNumberId && value.accessToken);
  cache = { at: Date.now(), value };
  return value;
}

export const whatsappClientConfig = (s: WhatsAppSettings): WhatsAppConfig => ({ phoneNumberId: s.phoneNumberId, accessToken: s.accessToken, apiVersion: s.apiVersion, baseUrl: config.WHATSAPP_API_BASE });

/** The approved template for an event: exact event, then its group (the part before the dot), then `default`. */
export function templateForEvent(settings: WhatsAppSettings, event: string, fields: { subject: string; text: string; link: string }): TemplateRef | null {
  const group = event.split('.')[0] ?? event;
  const def = settings.templates[event] ?? settings.templates[group] ?? settings.templates.default;
  if (!def?.name) return null;
  const order = def.params?.length ? def.params : ['subject', 'text', 'link'];
  const source: Record<string, string> = { subject: fields.subject, text: fields.text, link: fields.link, event, platform: 'Progression' };
  return { name: def.name, language: def.language || 'en', params: order.map((k) => templateParam(source[k] ?? k)) };
}

/** What the admin page shows: configured or not, what is missing, the webhook URL to register in Meta. */
export async function whatsappStatus(ctx: Ctx) {
  resetWhatsAppSettingsCache(); // the admin page must see what was just saved
  const s = await loadWhatsAppSettings(ctx.tx);
  const missing: string[] = [];
  if (!s.phoneNumberId) missing.push('phone number id');
  if (!s.accessToken) missing.push('access token');
  if (!s.templates.default?.name) missing.push('default template');
  if (!s.appSecret) missing.push('app secret (delivery callbacks are not verified)');
  if (!s.verifyToken) missing.push('verify token (webhook subscription)');
  const [optedIn] = await ctx.tx.select({ n: schema.users.id }).from(schema.users).where(eq(schema.users.whatsappOptIn, true));
  return {
    enabled: s.enabled,
    configured: s.configured,
    phoneNumberId: s.phoneNumberId,
    businessAccountId: s.businessAccountId,
    apiVersion: s.apiVersion,
    defaultCountryCode: s.defaultCountryCode,
    templates: s.templates,
    missing,
    webhookUrl: `${config.APP_URL.replace(/\/$/, '')}/api/webhooks/whatsapp`,
    hasOptIns: !!optedIn,
  };
}

/** Sends the default template (or Meta's sample `hello_world`) to one number so the admin can see it arrive. */
export async function sendWhatsAppTest(ctx: Ctx, rawTo: string) {
  resetWhatsAppSettingsCache();
  const s = await loadWhatsAppSettings(ctx.tx);
  if (!s.configured) throw new ValidationError('Enter the phone number id and access token first');
  const to = normalizePhone(rawTo, s.defaultCountryCode);
  if (!to) throw new ValidationError('Enter a valid mobile number with country code');
  const template = templateForEvent(s, 'test.message', { subject: 'Progression test message', text: `Sent by ${ctx.user.name} to check the WhatsApp connection.`, link: config.APP_URL }) ?? { name: 'hello_world', language: 'en_US', params: [] };
  const res = await sendWhatsAppTemplate(whatsappClientConfig(s), to, template);
  await ctx.audit({ entityType: 'system_settings', action: 'whatsapp.test', metadata: { to, template: template.name, providerMessageId: res.providerMessageId } });
  return { ok: true, to, template: template.name, providerMessageId: res.providerMessageId ?? null };
}

// ---------------------------------------------------------------- webhook

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!appSecret) return true; // not configured: accepted, the admin page says callbacks are unverified
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const given = signatureHeader.slice(7);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

interface StatusChange {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

/** Applies Meta status callbacks (sent, delivered, read, failed) to the outbox rows they belong to. Returns how many rows changed. */
export async function applyWhatsAppStatuses(payload: unknown): Promise<number> {
  const entries = ((payload as { entry?: { changes?: { value?: { statuses?: StatusChange[]; messages?: unknown[] } }[] }[] })?.entry ?? []);
  let updated = 0;
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      if (value.messages?.length) logger.info({ count: value.messages.length }, 'whatsapp inbound messages received (not handled)');
      for (const st of value.statuses ?? []) {
        const providerMessageId = st.id;
        const status = st.status;
        if (!providerMessageId || !status) continue;
        const error = st.errors?.[0];
        const detail = error ? `${error.code ?? ''} ${error.title ?? error.message ?? ''}${error.error_data?.details ? ` (${error.error_data.details})` : ''}`.trim() : null;
        const res = await withSystem((tx) =>
          tx
            .update(schema.notificationOutbox)
            .set({ deliveryStatus: status, ...(status === 'failed' ? { status: 'failed', lastError: detail ?? 'WhatsApp reported the message as failed' } : {}) })
            .where(eq(schema.notificationOutbox.providerMessageId, providerMessageId))
            .returning({ id: schema.notificationOutbox.id }),
        );
        updated += res.length;
      }
    }
  }
  return updated;
}
