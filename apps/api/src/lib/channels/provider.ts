/**
 * Outbound channel providers. The outbox stores one row per recipient and channel;
 * the worker hands each row to the provider of its channel. Only WhatsApp is
 * implemented today; Teams, Slack or SMS would plug into the same interface.
 */
export type ChannelKind = 'email' | 'in_app' | 'whatsapp';

export interface TemplateRef {
  name: string;
  language: string;
  /** Body parameters in template order ({{1}}, {{2}}, …). */
  params: string[];
}

export interface OutboundMessage {
  /** Channel address: an E.164 phone number for WhatsApp. */
  to: string;
  subject?: string | null;
  /** Plain-text body (used when the provider can send free text, and as the fallback). */
  text: string;
  /** Pre-approved template, required for business-initiated WhatsApp messages. */
  template?: TemplateRef | null;
  link?: string | null;
}

export interface SendResult {
  providerMessageId?: string | null;
}

export interface ChannelProvider<C = Record<string, unknown>> {
  kind: ChannelKind;
  send(config: C, message: OutboundMessage): Promise<SendResult>;
}

/** An error the provider reports as final: retrying will not help (bad number, unknown template, rejected content). */
export class PermanentChannelError extends Error {
  constructor(
    message: string,
    public code?: string | number,
  ) {
    super(message);
    this.name = 'PermanentChannelError';
  }
}

/** Template parameters may not contain newlines, tabs or long runs of spaces; keep them short. */
export function templateParam(value: unknown, max = 1024): string {
  const s = String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\r\n\t]+/g, ' · ')
    .replace(/ {5,}/g, '    ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s || '-';
}

/**
 * Normalises a phone number to E.164 ("+919876543210"). Ten-digit numbers get the
 * default country code (India by default); returns null when it cannot be a number.
 */
export function normalizePhone(raw: string | null | undefined, defaultCountryCode = '91'): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  digits = digits.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = defaultCountryCode + digits.slice(1);
  if (digits.length === 10) digits = defaultCountryCode + digits;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}
