import { pgTable, text, boolean, uuid, integer, numeric, date, timestamp, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps, tsvector, searchExpr } from './_common';
import { customers } from './customers';
import { configOptions } from './config';
import { contracts } from './contracts';
import { cis } from './cmdb';
import { assets } from './assets';
import { users } from './iam';

/**
 * Software asset management: a shared catalogue of titles, the installations
 * of those titles on a customer's hosts, the licences a customer bought and
 * the once-only notification milestones. The compliance position (installed
 * against entitled) is computed live from installations on live hosts and
 * licences in term; it is never stored.
 */

/** Software catalogue: one row per title (publisher + product + version family). customer_id NULL = shared catalogue. */
export const softwareProducts = pgTable('software_products', {
  id: id(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  /** Normalised `publisher/name[/version-family]` slug, unique across the catalogue (see productKey in the service). */
  key: text('key').notNull(),
  publisher: text('publisher').notNull(),
  name: text('name').notNull(),
  versionFamily: text('version_family'),
  categoryId: uuid('category_id').references(() => configOptions.id, { onDelete: 'set null' }),
  /** LICENCE_MODELS: per_device | per_user | per_core | subscription | perpetual (how the publisher sells it). */
  licenceModel: text('licence_model').notNull().default('per_device'),
  description: text('description'),
  website: text('website'),
  eolDate: date('eol_date'),
  isActive: boolean('is_active').notNull().default(true),
  tags: text('tags').array().notNull().default([]),
  searchVector: tsvector('search_vector').generatedAlwaysAs(searchExpr('publisher', 'name', 'version_family')),
  ...timestamps,
}, (t) => [
  uniqueIndex('software_products_key_idx').on(t.key),
  index('software_products_customer_idx').on(t.customerId),
  index('software_products_publisher_idx').on(t.publisher),
  index('software_products_search_idx').using('gin', t.searchVector),
]);

/** One title installed on one host (a CI, an asset, or an unmatched host name) for one customer. */
export const softwareInstallations = pgTable('software_installations', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => softwareProducts.id, { onDelete: 'restrict' }),
  ciId: uuid('ci_id').references(() => cis.id, { onDelete: 'set null' }),
  assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
  /** Host name as imported, kept even when a CI matched (display and re-matching). */
  hostName: text('host_name'),
  /** The person the install is for (the per_user metric counts distinct users). */
  assignedUser: text('assigned_user'),
  version: text('version'),
  edition: text('edition'),
  /** Licensed cores on this host (the per_core metric sums them; null counts as 1). */
  cores: integer('cores'),
  installPath: text('install_path'),
  installedAt: date('installed_at'),
  /** INSTALL_SOURCES: manual | csv | discovery | agent. */
  source: text('source').notNull().default('manual'),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  index('software_installs_customer_product_idx').on(t.customerId, t.productId),
  index('software_installs_ci_idx').on(t.ciId),
  index('software_installs_asset_idx').on(t.assetId),
  index('software_installs_last_seen_idx').on(t.lastSeenAt),
]);

/** A licence entitlement: seats of one title bought by one customer for a term. */
export const softwareLicences = pgTable('software_licences', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => softwareProducts.id, { onDelete: 'restrict' }),
  contractId: uuid('contract_id').references(() => contracts.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  /** LICENCE_METRICS: per_device | per_user | per_core | site (site = unlimited). */
  metric: text('metric').notNull().default('per_device'),
  /** LICENCE_TERMS: subscription | perpetual. */
  term: text('term').notNull().default('perpetual'),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
  startDate: date('start_date'),
  endDate: date('end_date'),
  renewalDate: date('renewal_date'),
  autoRenew: boolean('auto_renew').notNull().default(false),
  cost: numeric('cost', { precision: 14, scale: 2 }),
  currency: text('currency').default('INR'),
  vendor: text('vendor'),
  poNumber: text('po_number'),
  invoiceNumber: text('invoice_number'),
  licenceKey: text('licence_key'),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  notes: text('notes'),
  isActive: boolean('is_active').notNull().default(true),
  /** Set by renewLicence: the licence that continues this one. This row stays in force until its own end date (status 'renewed'); renewals and notifications skip it. */
  successorId: uuid('successor_id').references((): AnyPgColumn => softwareLicences.id, { onDelete: 'set null' }),
  renewedAt: timestamp('renewed_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  index('software_licences_customer_idx').on(t.customerId),
  index('software_licences_product_idx').on(t.productId),
  index('software_licences_contract_idx').on(t.contractId),
  index('software_licences_end_idx').on(t.endDate),
  index('software_licences_renewal_idx').on(t.renewalDate),
]);

/** Once-only notification milestones (mirrors contract_notifications). scope_type 'licence' → licence id; 'product' → product id. */
export const softwareNotifications = pgTable('software_notifications', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  scopeType: text('scope_type').notNull(),
  scopeId: uuid('scope_id').notNull(),
  milestone: text('milestone').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('software_notifications_uniq').on(t.scopeType, t.scopeId, t.milestone), index('software_notifications_customer_idx').on(t.customerId)]);
