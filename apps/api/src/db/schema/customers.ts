import { pgTable, text, boolean, uuid, jsonb, index, uniqueIndex, primaryKey, integer, timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps, tsvector, searchExpr } from './_common';
import { configOptions } from './config';
import { teams, users } from './iam';

export const customers = pgTable('customers', {
  id: id(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  industryId: uuid('industry_id').references((): AnyPgColumn => configOptions.id, { onDelete: 'set null' }),
  typeId: uuid('type_id').references((): AnyPgColumn => configOptions.id, { onDelete: 'set null' }),
  statusId: uuid('status_id').references((): AnyPgColumn => configOptions.id, { onDelete: 'set null' }),
  accountManagerId: uuid('account_manager_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  website: text('website'),
  phone: text('phone'),
  email: text('email'),
  address: jsonb('address').$type<Record<string, string>>().notNull().default({}),
  timezone: text('timezone').notNull().default('UTC'),
  notes: text('notes'),
  tags: text('tags').array().notNull().default([]),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  searchVector: tsvector('search_vector').generatedAlwaysAs(searchExpr('code', 'name', 'legal_name', 'email')),
  ...timestamps,
}, (t) => [
  uniqueIndex('customers_code_idx').on(t.code),
  index('customers_name_idx').on(t.name),
  index('customers_search_idx').using('gin', t.searchVector),
]);

export const sites = pgTable('sites', {
  id: id(),
  customerId: uuid('customer_id').notNull().references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  typeId: uuid('type_id').references((): AnyPgColumn => configOptions.id, { onDelete: 'set null' }),
  address: jsonb('address').$type<Record<string, string>>().notNull().default({}),
  timezone: text('timezone'),
  phone: text('phone'),
  isPrimary: boolean('is_primary').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  businessHoursCalendarId: uuid('business_hours_calendar_id'),
  notes: text('notes'),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => [
  uniqueIndex('sites_customer_code_idx').on(t.customerId, t.code),
  index('sites_customer_idx').on(t.customerId),
]);

export const contacts = pgTable('contacts', {
  id: id(),
  customerId: uuid('customer_id').notNull().references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').references((): AnyPgColumn => sites.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  mobile: text('mobile'),
  whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(false),
  whatsappOptedInAt: timestamp('whatsapp_opted_in_at', { withTimezone: true }),
  title: text('title'),
  department: text('department'),
  isPrimary: boolean('is_primary').notNull().default(false),
  isEscalation: boolean('is_escalation').notNull().default(false),
  escalationLevel: integer('escalation_level'),
  notes: text('notes'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [index('contacts_customer_idx').on(t.customerId), index('contacts_email_idx').on(t.email)]);

/** MSP teams serving a customer (also drives visibility for team members). */
export const customerTeams = pgTable('customer_teams', {
  customerId: uuid('customer_id').notNull().references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').notNull().references((): AnyPgColumn => teams.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.customerId, t.teamId] })]);
