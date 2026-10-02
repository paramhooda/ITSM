import { pgTable, text, boolean, uuid, jsonb, index, timestamp } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { customers } from './customers';
import { apiKeys } from './iam';

/**
 * External system integrations. PRTG and FortiSIEM are modelled as event
 * sources whose events are stored, correlated to customers/CIs and optionally
 * turned into tickets according to configurable rules.
 */
export const integrations = pgTable('integrations', {
  id: id(),
  /** prtg | fortisiem | email | webhook | custom */
  integrationType: text('integration_type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  /** { autoCreateTickets, ticketType, defaultCategoryId, defaultPriorityId, severityMap, dedupeWindowMinutes, assignTeamId, domain } */
  rules: jsonb('rules').$type<Record<string, unknown>>().notNull().default({}),
  autoCreateTickets: boolean('auto_create_tickets').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [index('integrations_type_idx').on(t.integrationType)]);
