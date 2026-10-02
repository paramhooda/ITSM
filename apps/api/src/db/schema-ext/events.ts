import { pgTable, text, uuid, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Monitoring / security events received from integrations (PRTG, FortiSIEM, ...).
 * Range-partitioned by month (created by drizzle/0001_platform_sql.sql).
 */
export const integrationEvents = pgTable('integration_events', {
  id: uuid('id').defaultRandom().notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  integrationId: uuid('integration_id').notNull(),
  integrationType: text('integration_type').notNull(),
  customerId: uuid('customer_id'),
  externalId: text('external_id'),
  eventType: text('event_type'),
  severity: text('severity'),
  status: text('status'),
  host: text('host'),
  ipAddress: text('ip_address'),
  sensor: text('sensor'),
  message: text('message'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  matchedCiId: uuid('matched_ci_id'),
  ticketId: uuid('ticket_id'),
  /** received | correlated | ticket_created | deduplicated | ignored | error */
  processingStatus: text('processing_status').notNull().default('received'),
  processingNote: text('processing_note'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.id, t.receivedAt] })]);
