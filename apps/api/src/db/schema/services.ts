import { pgTable, text, boolean, uuid, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps, domainEnum } from './_common';
import { configOptions } from './config';
import { teams } from './iam';

/** Service catalog (first-class services the MSP delivers). */
export const services = pgTable('services', {
  id: id(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  categoryId: uuid('category_id').references(() => configOptions.id, { onDelete: 'set null' }),
  /** Second catalog level (a `service_subcategory` option whose parent is `categoryId`). */
  subcategoryId: uuid('subcategory_id').references(() => configOptions.id, { onDelete: 'set null' }),
  statusId: uuid('status_id').references(() => configOptions.id, { onDelete: 'set null' }),
  domain: domainEnum('domain').notNull().default('general'),
  defaultTeamId: uuid('default_team_id').references(() => teams.id, { onDelete: 'set null' }),
  defaultSlaPolicyId: uuid('default_sla_policy_id'),
  defaultTicketCategoryId: uuid('default_ticket_category_id').references(() => configOptions.id, { onDelete: 'set null' }),
  /** CI types typically covered by this service. */
  ciTypeKeys: text('ci_type_keys').array().notNull().default([]),
  ownerUserId: uuid('owner_user_id'),
  isActive: boolean('is_active').notNull().default(true),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => [uniqueIndex('services_key_idx').on(t.key), index('services_category_idx').on(t.categoryId), index('services_subcategory_idx').on(t.subcategoryId)]);
