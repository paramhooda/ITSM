import { eq } from 'drizzle-orm';
import { schema, withSystem } from '@/db/client';
import { logger } from '@/core/logger';
import { normalizePhone } from '@/lib/channels';
import { enqueue } from '@/jobs/queues';
import { sanitizeText } from '@/modules/ai/untrusted';
import { applyWhatsAppStatuses, type WhatsAppSettings } from '@/modules/notifications/channels';
import type { InboundKind } from '@/db/schema/whatsapp';

/**
 * The webhook intake for inbound messages. Meta retries anything that is not
 * answered quickly, so the handler only parses, deduplicates on Meta's message
 * id and queues one job per message; the model never runs in the request.
 * Nothing is queued while the app secret is empty, because the signature check
 * accepts every request in that case.
 */

export const INBOUND_TEXT_MAX = 8000;
export const WHATSAPP_CHAT_JOB = 'whatsapp-chat';
/** A redelivered message whose row has waited this long without its job running gets the job again. */
export const REQUEUE_AFTER_MS = 60_000;

/** The queue's id for a message (BullMQ refuses ':' in a custom id, so the wamid is prefixed with a dash); `n` numbers a requeue. */
export const whatsappJobId = (providerMessageId: string, n = 0) => `whatsapp-${providerMessageId.replace(/:/g, '_')}${n ? `-${n}` : ''}`;

export interface MetaContact {
  profile?: { name?: string };
  wa_id?: string;
}
export interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
  context?: { from?: string; id?: string };
}
interface MetaValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: unknown[];
}
type MetaPayload = { entry?: { changes?: { value?: MetaValue }[] }[] };

export interface ParsedInbound {
  providerMessageId: string;
  phone: string;
  kind: InboundKind;
  text: string | null;
  displayName: string | null;
  receivedAt: Date;
  contextMessageId: string | null;
}

const kindOf = (type: string | undefined): InboundKind => (type === 'text' || type === 'button' || type === 'interactive' || type === 'reaction' ? type : 'unsupported');

/** One Meta message as a row: the sender normalised to E.164, the text by kind (null for anything the assistant cannot read), the profile name for display only. */
export function parseInbound(m: MetaMessage, contacts: MetaContact[], defaultCountryCode: string): ParsedInbound | null {
  if (!m.id || !m.from) return null;
  const phone = normalizePhone(m.from, defaultCountryCode);
  if (!phone) return null;
  const kind = kindOf(m.type);
  let raw: string | null = null;
  if (kind === 'text') raw = m.text?.body ?? '';
  else if (kind === 'button') raw = m.button?.text ?? m.button?.payload ?? '';
  else if (kind === 'interactive') raw = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
  const text = raw === null ? null : sanitizeText(raw, INBOUND_TEXT_MAX).trim() || null;
  const contact = contacts.find((c) => c.wa_id === m.from) ?? contacts[0];
  const displayName = contact?.profile?.name ? sanitizeText(String(contact.profile.name), 200).trim() || null : null;
  const ts = Number(m.timestamp);
  const receivedAt = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date();
  return { providerMessageId: m.id, phone, kind, text, displayName, receivedAt, contextMessageId: m.context?.id ?? null };
}

let warnedAt = 0;
const WARN_EVERY_MS = 3_600_000;

/** Writes one whatsapp_inbound row per new message and queues the job; returns how many were queued. */
export async function intakeInboundMessages(payload: unknown, settings: WhatsAppSettings): Promise<number> {
  const entries = (payload as MetaPayload | null | undefined)?.entry ?? [];
  let queued = 0;
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      if (!value.messages?.length) continue;
      if (value.metadata?.phone_number_id !== settings.phoneNumberId) {
        logger.info({ phoneNumberId: value.metadata?.phone_number_id ?? null, count: value.messages.length }, 'whatsapp inbound for another number ignored');
        continue;
      }
      if (!settings.appSecret) {
        if (Date.now() - warnedAt > WARN_EVERY_MS) {
          warnedAt = Date.now();
          logger.warn('inbound WhatsApp ignored: set the app secret so messages can be verified');
        }
        continue;
      }
      for (const m of value.messages) {
        const parsed = parseInbound(m, value.contacts ?? [], settings.defaultCountryCode);
        if (!parsed) continue;
        const reaction = parsed.kind === 'reaction';
        const inserted = await withSystem((tx) =>
          tx
            .insert(schema.whatsappInbound)
            .values({
              providerMessageId: parsed.providerMessageId,
              phone: parsed.phone,
              displayName: parsed.displayName,
              kind: parsed.kind,
              text: parsed.text,
              contextMessageId: parsed.contextMessageId,
              receivedAt: parsed.receivedAt,
              ...(reaction ? { status: 'ignored' as const, outcome: 'ignored', handledAt: new Date() } : {}),
            })
            .onConflictDoNothing({ target: schema.whatsappInbound.providerMessageId })
            .returning({ id: schema.whatsappInbound.id }),
        );
        if (reaction) continue; // nothing to answer
        let row = inserted[0];
        if (!row) {
          // A redelivery (Meta retries what it did not get an answer to). When the first job never ran, ask for it again with the same id: a job that still exists makes this a no-op.
          const [existing] = await withSystem((tx) => tx.select({ id: schema.whatsappInbound.id, status: schema.whatsappInbound.status, createdAt: schema.whatsappInbound.createdAt }).from(schema.whatsappInbound).where(eq(schema.whatsappInbound.providerMessageId, parsed.providerMessageId)).limit(1));
          if (!existing || existing.status !== 'received' || existing.createdAt.getTime() > Date.now() - REQUEUE_AFTER_MS) continue;
          row = existing;
        }
        // attempts: 1 is explicit (the queue default is 3); the jobId makes a second enqueue for the same wamid a no-op even if the insert raced.
        const job = await enqueue('ai', WHATSAPP_CHAT_JOB, { inboundId: row.id }, { jobId: whatsappJobId(parsed.providerMessageId), attempts: 1, removeOnComplete: 500 });
        if (job) queued++;
        else logger.warn({ inboundId: row.id }, 'inbound WhatsApp message stored but not queued: the queue refused the job');
      }
    }
  }
  return queued;
}

/** The webhook body: delivery statuses are applied as before, then inbound messages are taken in. */
export async function handleWhatsAppWebhook(payload: unknown, settings: WhatsAppSettings): Promise<{ ok: true; updated: number; queued: number }> {
  const updated = await applyWhatsAppStatuses(payload);
  const queued = await intakeInboundMessages(payload, settings);
  return { ok: true, updated, queued };
}
