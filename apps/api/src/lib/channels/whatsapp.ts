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

export const whatsappProvider: ChannelProvider<WhatsAppConfig> = {
  kind: 'whatsapp',
  async send(cfg, message: OutboundMessage) {
    if (!message.template) throw new PermanentChannelError('WhatsApp messages need an approved template');
    return sendTemplate(cfg, message.to, message.template);
  },
};
