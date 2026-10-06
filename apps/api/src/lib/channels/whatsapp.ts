import { PermanentChannelError, type ChannelProvider, type OutboundMessage, type SendResult } from './provider';

/** Connection to one WhatsApp Business phone number through Meta's Cloud API. */
export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Graph API version, e.g. "v21.0". */
  apiVersion?: string;
  /** Overridable for tests and proxies. */
  baseUrl?: string;
}

/** Error codes Meta documents as not retryable for the same request. */
const PERMANENT_CODES = new Set([100, 131008, 131009, 131021, 131026, 131047, 131051, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 190]);

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
}

/** Fetches through the global fetch so tests can stub it. */
async function graphPost(cfg: WhatsAppConfig, body: Record<string, unknown>): Promise<{ id: string | null }> {
  const base = (cfg.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
  const url = `${base}/${cfg.apiVersion ?? 'v21.0'}/${cfg.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as GraphError & { messages?: { id: string }[] };
  if (!res.ok) {
    const code = json.error?.code;
    const detail = json.error?.error_data?.details ? ` (${json.error.error_data.details})` : '';
    const message = `WhatsApp ${res.status}${code !== undefined ? ` (code ${code})` : ''}: ${json.error?.message ?? res.statusText}${detail}`;
    if (code !== undefined && PERMANENT_CODES.has(code)) throw new PermanentChannelError(message, code);
    throw new Error(message);
  }
  return { id: json.messages?.[0]?.id ?? null };
}

/** Meta wants the number without the leading plus. */
const waNumber = (to: string) => to.replace(/^\+/, '');

export async function sendTemplate(cfg: WhatsAppConfig, to: string, template: { name: string; language: string; params: string[] }): Promise<SendResult> {
  const components = template.params.length ? [{ type: 'body', parameters: template.params.map((text) => ({ type: 'text', text })) }] : [];
  const { id } = await graphPost(cfg, { to: waNumber(to), type: 'template', template: { name: template.name, language: { code: template.language }, components } });
  return { providerMessageId: id };
}

/** Free text is only delivered inside a 24-hour customer-service window; the outbox uses templates. */
export async function sendText(cfg: WhatsAppConfig, to: string, text: string): Promise<SendResult> {
  const { id } = await graphPost(cfg, { to: waNumber(to), type: 'text', text: { preview_url: true, body: text } });
  return { providerMessageId: id };
}

/**
 * Marks an inbound message as read (the person sees blue ticks). Meta's read
 * receipt takes exactly `messaging_product`, `status` and `message_id`, so this
 * does not go through graphPost (which always adds `recipient_type`). Failures
 * are reported as plain errors; callers treat the receipt as best effort.
 */
export async function markRead(cfg: WhatsAppConfig, messageId: string): Promise<void> {
  const base = (cfg.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
  const url = `${base}/${cfg.apiVersion ?? 'v21.0'}/${cfg.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as GraphError;
    throw new Error(`WhatsApp ${res.status}${json.error?.code !== undefined ? ` (code ${json.error.code})` : ''}: ${json.error?.message ?? res.statusText}`);
  }
}

export const whatsappProvider: ChannelProvider<WhatsAppConfig> = {
  kind: 'whatsapp',
  async send(cfg, message: OutboundMessage) {
    if (!message.template) throw new PermanentChannelError('WhatsApp messages need an approved template');
    return sendTemplate(cfg, message.to, message.template);
  },
};

// ---------------------------------------------------------------- reads for the connection check

async function graphGet<T>(cfg: WhatsAppConfig, path: string, params: Record<string, string> = {}): Promise<T> {
  const base = (cfg.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${base}/${cfg.apiVersion ?? 'v21.0'}/${path}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${cfg.accessToken}` } });
  const json = (await res.json().catch(() => ({}))) as GraphError & T;
  if (!res.ok) throw new Error(`WhatsApp ${res.status}${json.error?.code !== undefined ? ` (code ${json.error.code})` : ''}: ${json.error?.message ?? res.statusText}`);
  return json;
}

export interface PhoneNumberInfo {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  status?: string;
  code_verification_status?: string;
  name_status?: string;
  messaging_limit_tier?: string;
  platform_type?: string;
  is_official_business_account?: boolean;
}
/** The business phone number as Meta sees it: display number, verified name, quality, registration status, messaging tier. */
export const getPhoneNumberInfo = (cfg: WhatsAppConfig) => graphGet<PhoneNumberInfo>(cfg, cfg.phoneNumberId, { fields: 'display_phone_number,verified_name,quality_rating,status,code_verification_status,name_status,messaging_limit_tier,platform_type,is_official_business_account' });

export interface TemplateInfo {
  id?: string;
  name: string;
  status?: string;
  category?: string;
  language?: string;
  components?: { type?: string; text?: string; format?: string }[];
}
/** The templates of the business account (name, approval status, category, language, components). */
export const listMessageTemplates = async (cfg: WhatsAppConfig, businessAccountId: string, name?: string) => (await graphGet<{ data?: TemplateInfo[] }>(cfg, `${businessAccountId}/message_templates`, { fields: 'name,status,category,language,components', limit: '200', ...(name ? { name } : {}) })).data ?? [];

/** The apps subscribed to the business account's webhooks (statuses only arrive when ours is listed). */
export const getSubscribedApps = async (cfg: WhatsAppConfig, businessAccountId: string) => (await graphGet<{ data?: { whatsapp_business_api_data?: { id?: string; name?: string; link?: string } }[] }>(cfg, `${businessAccountId}/subscribed_apps`)).data ?? [];

/** How many body placeholders ({{1}}…{{n}}) a template has. */
export const templatePlaceholders = (t: TemplateInfo) => {
  const body = t.components?.find((c) => (c.type ?? '').toUpperCase() === 'BODY')?.text ?? '';
  const ns = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return ns.length ? Math.max(...ns) : 0;
};
