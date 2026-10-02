import { pgTable, text, boolean, uuid, jsonb, index, uniqueIndex, integer, numeric, date, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { id, timestamps, scopeStatusEnum } from './_common';
import { customers, sites } from './customers';
import { configOptions } from './config';
import { services } from './services';
import { teams, users } from './iam';

export const contracts = pgTable('contracts', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  name: text('name').notNull(),
  typeId: uuid('type_id').references(() => configOptions.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('draft'),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  renewalDate: date('renewal_date'),
  noticePeriodDays: integer('notice_period_days'),
  autoRenew: boolean('auto_renew').notNull().default(false),
  supportHoursCalendarId: uuid('support_hours_calendar_id'),
  holidayCalendarId: uuid('holiday_calendar_id'),
  slaPolicyId: uuid('sla_policy_id'),
  /** [{ level, name, contactId?, userId?, afterMinutes }] */
  escalationMatrix: jsonb('escalation_matrix').$type<Record<string, unknown>[]>().notNull().default([]),
  responseCommitment: text('response_commitment'),
  resolutionCommitment: text('resolution_commitment'),
  exclusions: text('exclusions'),
  description: text('description'),
  signedAt: date('signed_at'),
  parentContractId: uuid('parent_contract_id'),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => [
  uniqueIndex('contracts_number_idx').on(t.number),
  index('contracts_customer_idx').on(t.customerId),
  index('contracts_end_date_idx').on(t.endDate),
  index('contracts_status_idx').on(t.status),
]);

export const contractServices = pgTable('contract_services', {
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  slaPolicyId: uuid('sla_policy_id'),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  supportHoursCalendarId: uuid('support_hours_calendar_id'),
  notes: text('notes'),
}, (t) => [primaryKey({ columns: [t.contractId, t.serviceId] })]);

export const contractSites = pgTable('contract_sites', {
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.contractId, t.siteId] })]);

/** Configurable entitlements (AMC visits, engineering hours, PM visits, ...). */
export const contractEntitlements = pgTable('contract_entitlements', {
  id: id(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  typeId: uuid('type_id').references(() => configOptions.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
  unit: text('unit').notNull().default('count'),
  period: text('period').notNull().default('contract'),
  /** When consumption exceeds this percentage a notification is raised. */
  warnThresholdPct: integer('warn_threshold_pct').notNull().default(80),
  overageAllowed: boolean('overage_allowed').notNull().default(true),
  notes: text('notes'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [index('entitlements_contract_idx').on(t.contractId), index('entitlements_customer_idx').on(t.customerId)]);

export const entitlementConsumptions = pgTable('entitlement_consumptions', {
  id: id(),
  entitlementId: uuid('entitlement_id').notNull().references(() => contractEntitlements.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }).defaultNow().notNull(),
  sourceType: text('source_type').notNull().default('manual'),
  sourceId: uuid('source_id'),
  ticketId: uuid('ticket_id'),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('consumptions_entitlement_idx').on(t.entitlementId), index('consumptions_customer_idx').on(t.customerId)]);

/** Tracks which contract milestone notifications have been sent. */
export const contractNotifications = pgTable('contract_notifications', {
  id: id(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  milestone: text('milestone').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('contract_notifications_unique_idx').on(t.contractId, t.milestone)]);

/**
 * Scope definitions: what a contract covers (or explicitly excludes) for a
 * service. Scope informs coverage governance; it never blocks operations.
 */
export const scopeItems = pgTable('scope_items', {
  id: id(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'cascade' }),
  headerId: uuid('header_id').references(() => configOptions.id, { onDelete: 'set null' }),
  categoryId: uuid('category_id').references(() => configOptions.id, { onDelete: 'set null' }),
  typeId: uuid('type_id').references(() => configOptions.id, { onDelete: 'set null' }),
  statusId: uuid('status_id').references(() => configOptions.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  classification: scopeStatusEnum('classification').notNull().default('in_scope'),
  siteId: uuid('site_id').references(() => sites.id, { onDelete: 'cascade' }),
  ciTypeKey: text('ci_type_key'),
  assetCategoryId: uuid('asset_category_id').references(() => configOptions.id, { onDelete: 'set null' }),
  ticketCategoryId: uuid('ticket_category_id').references(() => configOptions.id, { onDelete: 'set null' }),
  attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
}, (t) => [index('scope_items_contract_idx').on(t.contractId), index('scope_items_customer_idx').on(t.customerId)]);
