import { pgTable, text, boolean, uuid, integer, index, uniqueIndex, timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { users } from './iam';

/**
 * System-level notification defaults, one row per category of
 * NOTIFICATION_CATEGORIES (packages/shared): the default per channel and whether
 * the channel may be switched off by the person. Labels, audience and the
 * events of a category live in code; rows are seeded and never created or
 * deleted through the API.
 */
export const notificationCategories = pgTable('notification_categories', {
  id: id(),
  key: text('key').notNull(),
  emailDefault: boolean('email_default').notNull().default(true),
  emailLocked: boolean('email_locked').notNull().default(false),
  whatsappDefault: boolean('whatsapp_default').notNull().default(true),
  whatsappLocked: boolean('whatsapp_locked').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  isSystem: boolean('is_system').notNull().default(true),
  ...timestamps,
}, (t) => [uniqueIndex('notification_categories_key_idx').on(t.key)]);

/** One-time codes proving a person controls the mobile number on their profile; the code is stored hashed. */
export const phoneVerifications = pgTable('phone_verifications', {
  id: id(),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  /** The number the code was issued for, E.164. */
  phone: text('phone').notNull(),
  /** `sent`: the code went to the phone over WhatsApp. `typed`: the person sends the code to the business number (the WhatsApp assistant). */
  method: text('method').notNull().default('sent'),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('phone_verifications_user_idx').on(t.userId, t.createdAt), index('phone_verifications_phone_idx').on(t.phone, t.expiresAt)]);
