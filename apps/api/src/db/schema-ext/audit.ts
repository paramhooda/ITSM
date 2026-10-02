import { pgTable, text, uuid, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Audit log. Declared here for typed queries; the physical table is created by
 * a hand-written migration because it is range-partitioned by month
 * (see drizzle/0001_platform_sql.sql).
 */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').defaultRandom().notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  userId: uuid('user_id'),
  userName: text('user_name'),
  customerId: uuid('customer_id'),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  entityLabel: text('entity_label'),
  action: text('action').notNull(),
  changes: jsonb('changes').$type<Record<string, { old: unknown; new: unknown }>>().notNull().default({}),
  source: text('source').notNull().default('ui'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [primaryKey({ columns: [t.id, t.occurredAt] })]);
