import { pgTable, text, uuid, jsonb, index, integer, timestamp } from 'drizzle-orm/pg-core';
import { id } from './_common';
import { users } from './iam';

/** In-app notifications. */
export const notifications = pgTable('notifications', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id'),
  event: text('event').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt)]);

/** Transactional outbox for outbound channels (email and WhatsApp; the worker dispatches by channel). */
export const notificationOutbox = pgTable('notification_outbox', {
  id: id(),
  channel: text('channel').notNull().default('email'),
  event: text('event'),
  customerId: uuid('customer_id'),
  recipient: text('recipient').notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  bodyText: text('body_text'),
  attachments: jsonb('attachments').$type<{ attachmentId?: string; filename: string; contentType?: string }[]>().notNull().default([]),
  /** Channel-specific payload (WhatsApp: the template and its parameters). */
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  /** Message id returned by the provider (WhatsApp wamid), used to match delivery callbacks. */
  providerMessageId: text('provider_message_id'),
  /** Provider delivery state after sending: accepted, sent, delivered, read, failed. */
  deliveryStatus: text('delivery_status'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('notification_outbox_status_idx').on(t.status, t.scheduledAt), index('notification_outbox_channel_idx').on(t.channel, t.status), index('notification_outbox_provider_idx').on(t.providerMessageId)]);
