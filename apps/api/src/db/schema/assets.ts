import { pgTable, text, uuid, jsonb, index, uniqueIndex, numeric, date } from 'drizzle-orm/pg-core';
import { id, timestamps, tsvector, searchExpr } from './_common';
import { customers, sites, contacts } from './customers';
import { configOptions } from './config';
import { contracts } from './contracts';

/** Asset register: financial / lifecycle view of physical and licensed items. */
export const assets = pgTable('assets', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
  tag: text('tag').notNull(),
  name: text('name').notNull(),
  categoryId: uuid('category_id').references(() => configOptions.id, { onDelete: 'set null' }),
  statusId: uuid('status_id').references(() => configOptions.id, { onDelete: 'set null' }),
  lifecycleStage: text('lifecycle_stage').notNull().default('deployed'),
  manufacturer: text('manufacturer'),
  model: text('model'),
  serialNumber: text('serial_number'),
  partNumber: text('part_number'),
  description: text('description'),
  location: text('location'),
  rackPosition: text('rack_position'),
  vendor: text('vendor'),
  purchaseDate: date('purchase_date'),
  purchaseCost: numeric('purchase_cost', { precision: 14, scale: 2 }),
  currency: text('currency').default('INR'),
  poNumber: text('po_number'),
  invoiceNumber: text('invoice_number'),
  warrantyStart: date('warranty_start'),
  warrantyEnd: date('warranty_end'),
  warrantyProvider: text('warranty_provider'),
  amcContractId: uuid('amc_contract_id').references(() => contracts.id, { onDelete: 'set null' }),
  amcStart: date('amc_start'),
  amcEnd: date('amc_end'),
  eolDate: date('eol_date'),
  eosDate: date('eos_date'),
  ownerContactId: uuid('owner_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  assignedContactId: uuid('assigned_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  ciId: uuid('ci_id'),
  notes: text('notes'),
  tags: text('tags').array().notNull().default([]),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
  searchVector: tsvector('search_vector').generatedAlwaysAs(searchExpr('tag', 'name', 'serial_number', 'model', 'manufacturer', 'location')),
  ...timestamps,
}, (t) => [
  uniqueIndex('assets_customer_tag_idx').on(t.customerId, t.tag),
  index('assets_customer_idx').on(t.customerId),
  index('assets_serial_idx').on(t.serialNumber),
  index('assets_site_idx').on(t.siteId),
  index('assets_warranty_idx').on(t.warrantyEnd),
  index('assets_search_idx').using('gin', t.searchVector),
]);
