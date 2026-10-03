import { pgTable, text, boolean, timestamp, uuid, jsonb, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { users } from './iam';
import { customers } from './customers';
import { tickets } from './tickets';
import { cis } from './cmdb';

/**
 * Status page and announcements. Announcements are shared rows (no customer
 * column): who may read one depends on its audience and its customer list, so
 * platform.sql carries a hand-written policy for the table. Status-page
 * tokens and health snapshots carry the customer and get the usual tenant
 * policy.
 */

export type AnnouncementType = 'info' | 'maintenance' | 'outage';
export type AnnouncementAudience = 'all' | 'customers' | 'staff';
export type ServiceHealth = 'good' | 'degraded' | 'down' | 'maintenance';

/** Why a service is not healthy right now. */
export interface HealthReason {
  kind: 'major_incident' | 'event' | 'maintenance' | 'change';
  /** Ticket or event id, or PM occurrence / change ticket id. */
  ref: string;
  /** Short label: the ticket number, the event source, the visit number. */
  label: string;
  text: string;
  until?: string | null;
}

export const announcements = pgTable('announcements', {
  id: id(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  /** info | maintenance | outage */
  type: text('type').notNull().default('info'),
  /** all | customers | staff */
  audience: text('audience').notNull().default('all'),
  /** Customer organisations the announcement is for; empty = every customer (within the audience). */
  customerIds: uuid('customer_ids').array().notNull().default([]),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  pinned: boolean('pinned').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  /** The incident, change or maintenance the announcement is about, when there is one. */
  sourceTicketId: uuid('source_ticket_id').references((): AnyPgColumn => tickets.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [index('announcements_active_idx').on(t.isActive, t.startsAt), index('announcements_source_idx').on(t.sourceTicketId)]);

/** A customer's public status page: the token is the only credential, stored hashed. */
export const statusPageTokens = pgTable('status_page_tokens', {
  id: id(),
  customerId: uuid('customer_id').notNull().references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull(),
  /** The first characters of the token, so the list can say which one this is. */
  tokenPrefix: text('token_prefix').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [uniqueIndex('status_page_tokens_hash_uniq').on(t.tokenHash), index('status_page_tokens_customer_idx').on(t.customerId)]);

/** The computed health of one business service (a CI), rewritten by the status-health job. */
export const serviceHealthSnapshots = pgTable('service_health_snapshots', {
  ciId: uuid('ci_id').primaryKey().references((): AnyPgColumn => cis.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  /** good | degraded | down | maintenance */
  health: text('health').notNull().default('good'),
  reasons: jsonb('reasons').$type<HealthReason[]>().notNull().default([]),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('service_health_customer_idx').on(t.customerId, t.health)]);
