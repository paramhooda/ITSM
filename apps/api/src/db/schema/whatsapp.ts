import { pgTable, text, uuid, timestamp, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id } from './_common';
import { users } from './iam';
import { aiConversations } from './ai';
import { notificationOutbox } from './notifications';

export type InboundKind = 'text' | 'button' | 'interactive' | 'reaction' | 'unsupported';
export type InboundStatus = 'received' | 'processing' | 'handled' | 'ignored' | 'failed';
/** linked · unverified · chat_off · stopped · started · feature_off · audience · unsupported · throttled · cap · inactive · replied · failed · ignored (duplicate is a job result only, never stored). */
export type InboundOutcome = string;

/**
 * Every message Meta delivered to the business number: deduplicated by Meta's
 * id, resolved to a person, handled by the assistant job. Staff-only rows
 * (see platform.sql); the job reads and writes them with the system context.
 */
export const whatsappInbound = pgTable('whatsapp_inbound', {
  id: id(),
  providerMessageId: text('provider_message_id').notNull(),
  /** E.164 of the sender. */
  phone: text('phone').notNull(),
  /** The sender's WhatsApp profile name as Meta reports it: untrusted, display only, never put in a prompt. */
  displayName: text('display_name'),
  userId: uuid('user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  kind: text('kind').$type<InboundKind>().notNull().default('text'),
  /** Sanitised text (sanitizeText, 8000 characters); null for unsupported kinds. */
  text: text('text'),
  /** Meta id of the outbound message the person replied to, when they used "reply". */
  contextMessageId: text('context_message_id'),
  status: text('status').$type<InboundStatus>().notNull().default('received'),
  outcome: text('outcome'),
  conversationId: uuid('conversation_id').references((): AnyPgColumn => aiConversations.id, { onDelete: 'set null' }),
  /** First outbox row of the reply (further parts reference the inbound row through payload.inboundId). */
  replyOutboxId: uuid('reply_outbox_id').references((): AnyPgColumn => notificationOutbox.id, { onDelete: 'set null' }),
  error: text('error'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  /** When the job took the row; a claim older than the turn timeout belongs to a worker that died mid-turn and may be taken over. */
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  handledAt: timestamp('handled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('whatsapp_inbound_provider_idx').on(t.providerMessageId),
  index('whatsapp_inbound_phone_idx').on(t.phone, t.receivedAt),
  index('whatsapp_inbound_user_idx').on(t.userId, t.receivedAt),
  index('whatsapp_inbound_status_idx').on(t.status, t.createdAt),
]);
