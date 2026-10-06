import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema, withSystem } from '@/db/client';
import type { Ctx } from '@/core/context';
import { config } from '@/config';
import { decryptSecret } from '@/lib/crypto';
import { logger } from '@/core/logger';
import { ValidationError } from '@/core/errors';
import { normalizePhone, templateParam, sendWhatsAppTemplate, PermanentChannelError, getPhoneNumberInfo, listMessageTemplates, getSubscribedApps, templatePlaceholders, type TemplateRef, type WhatsAppConfig } from '@/lib/channels';
import { NotFoundError } from '@/core/errors';

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
  /** Webhook URL override (blank: derived from APP_URL). Set to a tunnel such as ngrok when the platform runs on localhost. */
  webhookUrl: string;
}

const KEYS = ['whatsapp.enabled', 'whatsapp.phone_number_id', 'whatsapp.business_account_id', 'whatsapp.access_token.secret', 'whatsapp.app.secret', 'whatsapp.verify_token.secret', 'whatsapp.api_version', 'whatsapp.default_country_code', 'whatsapp.templates', 'whatsapp.webhook_url'];

/** The route Meta posts delivery callbacks to, relative to the public origin of the API. */
export const WHATSAPP_WEBHOOK_PATH = '/api/webhooks/whatsapp';

export const defaultWebhookUrl = () => `${config.APP_URL.replace(/\/$/, '')}${WHATSAPP_WEBHOOK_PATH}`;

/**
 * The URL to register in Meta: the override when one is set, otherwise the platform URL.
 * An override that names only an origin (`https://abcd.ngrok-free.app`) gets the webhook
 * path appended so what the admin copies is always the full route.
 */
export function resolveWebhookUrl(override: string): string {
  const raw = override.trim();
  if (!raw) return defaultWebhookUrl();
  try {
    const u = new URL(raw);
    if (u.pathname === '/' || u.pathname === '') u.pathname = WHATSAPP_WEBHOOK_PATH;
    return u.toString();
  } catch {
    return raw;
  }
}

/** Only http(s) URLs are accepted as the webhook override; anything else is a typo Meta would reject. */
export function assertWebhookUrl(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value);
  if (!raw) return;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ValidationError('Webhook URL must be a full URL such as https://abcd.ngrok-free.app/api/webhooks/whatsapp');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ValidationError('Webhook URL must start with https:// (Meta only calls HTTPS endpoints)');
}

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
    webhookUrl: str(get('whatsapp.webhook_url')),
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
  // an explicit empty list means a template without placeholders (Meta's hello_world, for example)
  const order = def.params ?? ['subject', 'text', 'link'];
  const source: Record<string, string> = { subject: fields.subject, text: fields.text, link: fields.link, event, platform: 'Progression' };
  return { name: def.name, language: def.language || 'en', params: order.map((k) => templateParam(source[k] ?? k)) };
}

/** What the admin page shows: configured or not, what is missing, the webhook URL to register in Meta. */
/**
 * Active notification rules whose event has a WhatsApp template but whose
 * channels leave WhatsApp out. Those rules never produce a WhatsApp message,
 * however many people opted in: the rule decides the channels, the opt-in only
 * decides who. Rules seeded before the channel existed look like this.
 */
export async function rulesWithoutWhatsApp(tx: Tx): Promise<{ id: string; event: string; name: string }[]> {
  const templates = await tx
    .select({ event: schema.notificationTemplates.event })
    .from(schema.notificationTemplates)
    .where(and(eq(schema.notificationTemplates.channel, 'whatsapp'), eq(schema.notificationTemplates.isActive, true)));
  const events = [...new Set(templates.map((t) => t.event))];
  if (!events.length) return [];
  const rules = await tx
    .select({ id: schema.notificationRules.id, event: schema.notificationRules.event, name: schema.notificationRules.name, channels: schema.notificationRules.channels })
    .from(schema.notificationRules)
    .where(and(inArray(schema.notificationRules.event, events), eq(schema.notificationRules.isActive, true)));
  return rules.filter((r) => !(r.channels ?? []).includes('whatsapp')).map((r) => ({ id: r.id, event: r.event, name: r.name })).sort((a, b) => a.event.localeCompare(b.event));
}

/** Adds the WhatsApp channel to every rule `rulesWithoutWhatsApp` lists; idempotent. */
export async function enableWhatsAppOnRules(ctx: Ctx) {
  ctx.require('admin:config');
  const missing = await rulesWithoutWhatsApp(ctx.tx);
  for (const rule of missing) {
    const [row] = await ctx.tx.select({ channels: schema.notificationRules.channels }).from(schema.notificationRules).where(eq(schema.notificationRules.id, rule.id)).limit(1);
    const channels = [...(row?.channels ?? []), 'whatsapp'];
    await ctx.tx.update(schema.notificationRules).set({ channels }).where(eq(schema.notificationRules.id, rule.id));
    await ctx.audit({ entityType: 'notification_rule', entityId: rule.id, entityLabel: rule.name, action: 'update', changes: { channels: { old: row?.channels ?? [], new: channels } }, metadata: { source: 'whatsapp.enable_rules' } });
  }
  return { updated: missing.length, rules: missing };
}

export async function whatsappStatus(ctx: Ctx) {
  resetWhatsAppSettingsCache(); // the admin page must see what was just saved
  const s = await loadWhatsAppSettings(ctx.tx);
  const missing: string[] = [];
  if (!s.phoneNumberId) missing.push('phone number id');
  if (!s.accessToken) missing.push('access token');
  if (!s.templates.default?.name) missing.push('default template');
  if (!s.appSecret) missing.push('app secret (delivery callbacks are not verified)');
  if (!s.verifyToken) missing.push('verify token (webhook subscription)');
  const webhookUrl = resolveWebhookUrl(s.webhookUrl);
  if (isLocalUrl(webhookUrl)) missing.push('a public webhook URL (the platform URL is local; enter a tunnel URL such as ngrok so Meta can reach the webhook)');
  const [optedIn] = await ctx.tx.select({ n: schema.users.id }).from(schema.users).where(eq(schema.users.whatsappOptIn, true));
  const rulesMissingWhatsApp = await rulesWithoutWhatsApp(ctx.tx);
  return {
    enabled: s.enabled,
    configured: s.configured,
    phoneNumberId: s.phoneNumberId,
    businessAccountId: s.businessAccountId,
    apiVersion: s.apiVersion,
    defaultCountryCode: s.defaultCountryCode,
    templates: s.templates,
    missing,
    webhookUrl,
    webhookUrlDefault: defaultWebhookUrl(),
    webhookUrlIsCustom: !!s.webhookUrl.trim(),
    hasOptIns: !!optedIn,
    /** Rules that would carry a WhatsApp text but do not list the channel. */
    rulesWithoutWhatsApp: rulesMissingWhatsApp,
  };
}

/** True for localhost-style hosts Meta can never reach (the readiness checks say so). */
export const isLocalUrl = (value: string) => {
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.localhost');
  } catch {
    return false;
  }
};

/** The number of body parameters Meta says the template takes, from error 132000's message; null when it does not say. */
export function expectedParamCount(message: string): number | null {
  const m = /expected number of params \((\d+)\)/i.exec(message);
  return m ? Number(m[1]) : null;
}

/** Turns a Cloud API refusal into a message that says what to change on the WhatsApp page. */
export function explainWhatsAppError(err: unknown, template: TemplateRef): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof PermanentChannelError ? err.code : null;
  const where = 'Under Administration → WhatsApp';
  if (code === 132000) {
    const expected = expectedParamCount(message);
    const sent = template.params.length;
    return `Meta rejected template "${template.name}" (${template.language}): it has ${expected === null ? 'a different number of' : expected} body placeholder${expected === 1 ? '' : 's'} but the mapping sends ${sent} parameter${sent === 1 ? '' : 's'}. ${where}, set the template's parameters to match its {{1}}…{{n}} placeholders${expected === 0 ? ' (leave the list empty for a template without placeholders such as hello_world)' : ''}.`;
  }
  if (code === 132001) return `Template "${template.name}" does not exist for language ${template.language} in this WhatsApp Business account, or is not approved yet. ${where}, enter the exact template name and language code from Meta.`;
  if (code === 190) return `Meta refused the access token (expired or invalid). ${where}, paste a current permanent system-user token.`;
  if (code === 131030 || /not in allowed list/i.test(message)) return `Meta only delivers to numbers on the test allow-list while the app is in development mode; add the recipient in Meta or move the app to live. (${message})`;
  return `WhatsApp refused the message: ${message}`;
}

/**
 * Sends the mapped default template (or Meta's sample `hello_world`) to one
 * number so the admin can see it arrive. A refusal comes back as a 422 with
 * what to change; a template that turns out to have no placeholders is retried
 * once without parameters so the admin still gets the message.
 */
export async function sendWhatsAppTest(ctx: Ctx, rawTo: string) {
  resetWhatsAppSettingsCache();
  const s = await loadWhatsAppSettings(ctx.tx);
  if (!s.configured) throw new ValidationError('Enter the phone number id and access token first');
  const to = normalizePhone(rawTo, s.defaultCountryCode);
  if (!to) throw new ValidationError('Enter a valid mobile number with country code');
  const template = templateForEvent(s, 'test.message', { subject: 'Progression test message', text: `Sent by ${ctx.user.name} to check the WhatsApp connection.`, link: config.APP_URL }) ?? { name: 'hello_world', language: 'en_US', params: [] };
  let sent = template;
  let note: string | null = null;
  let res;
  try {
    res = await sendWhatsAppTemplate(whatsappClientConfig(s), to, template);
  } catch (err) {
    const expected = err instanceof PermanentChannelError && err.code === 132000 ? expectedParamCount(err.message) : null;
    if (expected !== 0 || !template.params.length) throw new ValidationError(explainWhatsAppError(err, template));
    sent = { ...template, params: [] };
    try {
      res = await sendWhatsAppTemplate(whatsappClientConfig(s), to, sent);
    } catch (again) {
      throw new ValidationError(explainWhatsAppError(again, sent));
    }
    note = `Template "${template.name}" has no placeholders, so it was sent without parameters. Under Administration → WhatsApp, clear the parameters of this template (or map a template with {{1}}…{{n}} placeholders) so notifications carry their text.`;
  }
  // an outbox row, so Meta's delivery callbacks (sent, delivered, read, failed with a reason) land somewhere visible
  const [row] = await ctx.tx
    .insert(schema.notificationOutbox)
    .values({ channel: 'whatsapp', event: 'test.message', recipient: to, subject: `Test: ${sent.name}`, body: `Test message sent by ${ctx.user.name}`, bodyText: `Test message sent by ${ctx.user.name}`, payload: { template: sent }, providerMessageId: res.providerMessageId ?? null, deliveryStatus: 'accepted', status: 'sent', attempts: 1, sentAt: new Date() })
    .returning({ id: schema.notificationOutbox.id });
  await ctx.audit({ entityType: 'system_settings', action: 'whatsapp.test', metadata: { to, template: sent.name, params: sent.params.length, providerMessageId: res.providerMessageId, outboxId: row.id, note } });
  return { ok: true, to, template: sent.name, providerMessageId: res.providerMessageId ?? null, outboxId: row.id, note };
}

/** The delivery state of one outbox row (the admin page polls it after a test). */
export async function whatsappMessageStatus(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select({ id: schema.notificationOutbox.id, recipient: schema.notificationOutbox.recipient, status: schema.notificationOutbox.status, deliveryStatus: schema.notificationOutbox.deliveryStatus, lastError: schema.notificationOutbox.lastError, providerMessageId: schema.notificationOutbox.providerMessageId, sentAt: schema.notificationOutbox.sentAt }).from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.id, id), eq(schema.notificationOutbox.channel, 'whatsapp'))).limit(1);
  if (!row) throw new NotFoundError('Message');
  return row;
}

export interface Finding {
  level: 'ok' | 'warn' | 'error';
  text: string;
}

/** Meta's own names for what the status callback reports, with the usual reason behind each code. */
export const WHATSAPP_FAILURE_HINTS: Record<number, string> = {
  130472: "the recipient's number is in a Meta experiment that withholds marketing templates; use a UTILITY template or another number",
  131026: 'the message is undeliverable: the number has no WhatsApp account, has not accepted the latest terms, or blocked the business',
  131047: 'more than 24 hours since the person last wrote to the business, so only an approved template can be sent',
  131049: 'Meta held the message back to keep the user experience healthy (frequency or quality limits)',
  131053: 'the media could not be uploaded',
  132015: 'the template is paused after quality complaints',
  132016: 'the template is disabled',
  133010: 'the phone number is not registered with the Cloud API; register it under WhatsApp Manager → Phone numbers',
  131030: 'the recipient is not on the test allow-list of a number that is still in development mode',
};

/**
 * The connection check: asks Meta about the phone number, every mapped
 * template and the webhook subscription, and compares the answers with the
 * mapping. Every row is a plain sentence with what to change.
 */
export async function whatsappDiagnostics(ctx: Ctx): Promise<{ checkedAt: string; findings: Finding[]; phone: Record<string, unknown> | null }> {
  resetWhatsAppSettingsCache();
  const s = await loadWhatsAppSettings(ctx.tx);
  if (!s.configured) throw new ValidationError('Enter the phone number id and access token first');
  const cfg = whatsappClientConfig(s);
  const findings: Finding[] = [];
  let phone: Record<string, unknown> | null = null;
  try {
    const p = await getPhoneNumberInfo(cfg);
    phone = p as Record<string, unknown>;
    findings.push({ level: 'ok', text: `Token and phone number id work: ${p.display_phone_number ?? 'number'}${p.verified_name ? ` (“${p.verified_name}”)` : ''}.` });
    if (p.status && p.status.toUpperCase() !== 'CONNECTED') findings.push({ level: 'error', text: `Meta reports the number as ${p.status}; it must be CONNECTED to deliver. Register or re-verify it under WhatsApp Manager → Phone numbers.` });
    if (p.code_verification_status && p.code_verification_status.toUpperCase() !== 'VERIFIED') findings.push({ level: 'warn', text: `The number's verification is ${p.code_verification_status}; finish the SMS or voice verification in WhatsApp Manager.` });
    if (p.name_status && !['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(p.name_status.toUpperCase())) findings.push({ level: 'warn', text: `The display name is ${p.name_status}; until it is approved Meta may hold messages back.` });
    if (p.quality_rating && ['RED', 'YELLOW'].includes(p.quality_rating.toUpperCase())) findings.push({ level: 'warn', text: `The number's quality rating is ${p.quality_rating}; Meta throttles or pauses templates on low-quality numbers.` });
    if (p.messaging_limit_tier) findings.push({ level: 'ok', text: `Messaging limit tier: ${p.messaging_limit_tier.replace(/^TIER_/, 'tier ')}.` });
  } catch (err) {
    findings.push({ level: 'error', text: `Meta refused the phone number id or the token: ${(err as Error).message}. Check both under Administration → WhatsApp; a temporary token expires after 24 hours, use a permanent system-user token.` });
    return { checkedAt: new Date().toISOString(), findings, phone };
  }
  if (!s.businessAccountId) {
    findings.push({ level: 'warn', text: 'No WhatsApp Business Account id is saved, so the templates and the webhook subscription cannot be checked. Copy it from WhatsApp Manager into the settings.' });
    return { checkedAt: new Date().toISOString(), findings, phone };
  }
  try {
    const templates = await listMessageTemplates(cfg, s.businessAccountId);
    const mapped = Object.entries(s.templates).filter(([, t]) => t?.name).map(([group, t]) => ({ group, name: t!.name, language: t!.language || 'en', params: t!.params ?? ['subject', 'text', 'link'] }));
    if (!mapped.length) findings.push({ level: 'error', text: 'No template is mapped; map at least the default one.' });
    for (const m of mapped) {
      const candidates = templates.filter((t) => t.name === m.name);
      const t = candidates.find((c) => (c.language ?? '').toLowerCase() === m.language.toLowerCase()) ?? null;
      if (!candidates.length) {
        findings.push({ level: 'error', text: `Template "${m.name}" (${m.group}) does not exist in the business account. Create it in WhatsApp Manager or map an existing one.` });
        continue;
      }
      if (!t) {
        findings.push({ level: 'error', text: `Template "${m.name}" (${m.group}) exists in ${candidates.map((c) => c.language).join(', ')} but not in "${m.language}"; set the mapping's language to one of those codes.` });
        continue;
      }
      const status = (t.status ?? '').toUpperCase();
      if (status !== 'APPROVED') findings.push({ level: 'error', text: `Template "${m.name}" (${m.language}) is ${status || 'unknown'}: only APPROVED templates are delivered. Wait for the review or fix the rejection in WhatsApp Manager.` });
      const placeholders = templatePlaceholders(t);
      if (placeholders !== m.params.length) findings.push({ level: 'error', text: `Template "${m.name}" has ${placeholders} body placeholder${placeholders === 1 ? '' : 's'} but the ${m.group} mapping sends ${m.params.length} parameter${m.params.length === 1 ? '' : 's'}; make them match (empty list for no placeholders).` });
      if ((t.category ?? '').toUpperCase() === 'MARKETING') findings.push({ level: 'warn', text: `Template "${m.name}" is a MARKETING template: Meta limits those (opt-outs, per-user frequency caps, experiments in some countries). Use a UTILITY template for operational notifications.` });
      if (status === 'APPROVED' && placeholders === m.params.length) findings.push({ level: 'ok', text: `Template "${m.name}" (${m.group}, ${m.language}) is approved${t.category ? `, ${t.category.toLowerCase()}` : ''}, ${placeholders} placeholder${placeholders === 1 ? '' : 's'}.` });
    }
  } catch (err) {
    findings.push({ level: 'warn', text: `Could not read the templates of business account ${s.businessAccountId}: ${(err as Error).message}. Check the id, and that the token's system user has access to this account.` });
  }
  try {
    const apps = await getSubscribedApps(cfg, s.businessAccountId);
    if (!apps.length) findings.push({ level: 'error', text: 'No app is subscribed to this business account\'s webhooks, so delivery states (sent, delivered, read, failed) never reach the platform. In the Meta app go to WhatsApp → Configuration, set the callback URL and verify token, subscribe to the "messages" field, and make sure the app is subscribed to the account (POST /<waba-id>/subscribed_apps).' });
    else findings.push({ level: 'ok', text: `Webhook subscribed: ${apps.map((a) => a.whatsapp_business_api_data?.name ?? a.whatsapp_business_api_data?.id ?? 'app').join(', ')}. Delivery states will arrive at ${resolveWebhookUrl(s.webhookUrl)} once that URL is the one set in Meta.` });
  } catch (err) {
    findings.push({ level: 'warn', text: `Could not read the webhook subscription: ${(err as Error).message}.` });
  }
  if (isLocalUrl(resolveWebhookUrl(s.webhookUrl))) findings.push({ level: 'warn', text: 'The webhook URL is local; Meta cannot reach it, so delivery states will not arrive. Use a tunnel URL on a laptop.' });
  const missingRules = await rulesWithoutWhatsApp(ctx.tx);
  if (missingRules.length) findings.push({ level: 'error', text: `${missingRules.length} notification rule${missingRules.length === 1 ? '' : 's'} (${[...new Set(missingRules.map((r) => r.event))].slice(0, 6).join(', ')}${missingRules.length > 6 ? ', …' : ''}) deliver by email and in-app only, so nobody receives WhatsApp for those events however many people opted in. Use "Add WhatsApp to these rules" above, or tick WhatsApp on each rule under Administration → Notification rules.` });
  else findings.push({ level: 'ok', text: 'Every rule for an event with a WhatsApp text lists the WhatsApp channel; opted-in people with a mobile number receive those events.' });
  await ctx.audit({ entityType: 'system_settings', action: 'whatsapp.check', metadata: { findings: findings.map((f) => f.level) } });
  return { checkedAt: new Date().toISOString(), findings, phone };
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
      for (const st of value.statuses ?? []) {
        const providerMessageId = st.id;
        const status = st.status;
        if (!providerMessageId || !status) continue;
        const error = st.errors?.[0];
        const hint = error?.code && WHATSAPP_FAILURE_HINTS[error.code] ? ` — ${WHATSAPP_FAILURE_HINTS[error.code]}` : '';
        const detail = error ? `${error.code ?? ''} ${error.title ?? error.message ?? ''}${error.error_data?.details ? ` (${error.error_data.details})` : ''}${hint}`.trim() : null;
        const res = await withSystem((tx) =>
          tx
            .update(schema.notificationOutbox)
            .set({ deliveryStatus: status, ...(status === 'failed' ? { status: 'failed', lastError: detail ?? 'WhatsApp reported the message as failed' } : {}) })
            .where(eq(schema.notificationOutbox.providerMessageId, providerMessageId))
            .returning({ id: schema.notificationOutbox.id }),
        );
        updated += res.length;
        if (!res.length) logger.info({ providerMessageId, status, detail }, 'whatsapp status for a message not in the outbox');
        else if (status === 'failed') logger.warn({ providerMessageId, detail }, 'whatsapp message failed');
      }
    }
  }
  return updated;
}
