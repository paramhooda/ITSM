import { pgTable, text, boolean, uuid, jsonb, index, uniqueIndex, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { id, timestamps, tsvector, searchExpr } from './_common';
import { customers, sites } from './customers';
import { services } from './services';
import { teams } from './iam';
import { assets } from './assets';

export const ciTypes = pgTable('ci_types', {
  id: id(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  parentKey: text('parent_key'),
  icon: text('icon'),
  color: text('color'),
  /** [{ key, label, type, required, options }] */
  attributeSchema: jsonb('attribute_schema').$type<Record<string, unknown>[]>().notNull().default([]),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
});

export const ciRelationshipTypes = pgTable('ci_relationship_types', {
  id: id(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  inverseName: text('inverse_name').notNull(),
  description: text('description'),
  /** downstream | upstream | none — see IMPACT_DIRECTIONS in @itsm/shared. */
  impactDirection: text('impact_direction').notNull().default('none'),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const cis = pgTable('cis', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
  typeId: uuid('type_id').notNull().references(() => ciTypes.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  hostname: text('hostname'),
  fqdn: text('fqdn'),
  ipAddress: text('ip_address'),
  macAddress: text('mac_address'),
  serialNumber: text('serial_number'),
  manufacturer: text('manufacturer'),
  model: text('model'),
  osName: text('os_name'),
  osVersion: text('os_version'),
  firmwareVersion: text('firmware_version'),
  environment: text('environment').notNull().default('production'),
  criticality: text('criticality').notNull().default('medium'),
  status: text('status').notNull().default('active'),
  description: text('description'),
  ownerTeamId: uuid('owner_team_id').references(() => teams.id, { onDelete: 'set null' }),
  assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
  attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
  discoverySource: text('discovery_source'),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  monitoringRef: text('monitoring_ref'),
  siemRef: text('siem_ref'),
  tags: text('tags').array().notNull().default([]),
  searchVector: tsvector('search_vector').generatedAlwaysAs(searchExpr('name', 'hostname', 'fqdn', 'ip_address', 'serial_number', 'model', 'manufacturer', 'mac_address')),
  ...timestamps,
}, (t) => [
  index('cis_customer_idx').on(t.customerId),
  index('cis_type_idx').on(t.typeId),
  index('cis_hostname_idx').on(t.hostname),
  index('cis_ip_idx').on(t.ipAddress),
  index('cis_serial_idx').on(t.serialNumber),
  index('cis_monitoring_ref_idx').on(t.monitoringRef),
  index('cis_search_idx').using('gin', t.searchVector),
]);

export const ciRelationships = pgTable('ci_relationships', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  sourceCiId: uuid('source_ci_id').notNull().references(() => cis.id, { onDelete: 'cascade' }),
  targetCiId: uuid('target_ci_id').notNull().references(() => cis.id, { onDelete: 'cascade' }),
  typeId: uuid('type_id').notNull().references(() => ciRelationshipTypes.id, { onDelete: 'restrict' }),
  description: text('description'),
  source: text('source').notNull().default('manual'),
  attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ci_relationships_unique_idx').on(t.sourceCiId, t.targetCiId, t.typeId),
  index('ci_relationships_target_idx').on(t.targetCiId),
]);

export const ciInterfaces = pgTable('ci_interfaces', {
  id: id(),
  ciId: uuid('ci_id').notNull().references(() => cis.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  name: text('name').notNull(),
  ifIndex: integer('if_index'),
  description: text('description'),
  macAddress: text('mac_address'),
  ipAddress: text('ip_address'),
  speedMbps: integer('speed_mbps'),
  adminStatus: text('admin_status'),
  operStatus: text('oper_status'),
  vlan: text('vlan'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('ci_interfaces_ci_idx').on(t.ciId)]);

export const ciServices = pgTable('ci_services', {
  ciId: uuid('ci_id').notNull().references(() => cis.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
}, (t) => [primaryKey({ columns: [t.ciId, t.serviceId] })]);

/** Discovery sources (network scans today; agents, cloud, monitoring imports later). */
export const discoverySources = pgTable('discovery_sources', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  sourceType: text('source_type').notNull().default('network_scan'),
  /** { subnets: [], snmpCommunities: [], snmpVersion, ports: [], dnsResolve, timeoutMs, concurrency } (secrets encrypted) */
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  scheduleCron: text('schedule_cron'),
  autoApply: boolean('auto_apply').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  ...timestamps,
}, (t) => [index('discovery_sources_customer_idx').on(t.customerId)]);

export const discoveryRuns = pgTable('discovery_runs', {
  id: id(),
  sourceId: uuid('source_id').notNull().references(() => discoverySources.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  status: text('status').notNull().default('queued'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  stats: jsonb('stats').$type<Record<string, number>>().notNull().default({}),
  log: text('log'),
  error: text('error'),
  triggeredBy: uuid('triggered_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('discovery_runs_source_idx').on(t.sourceId, t.createdAt)]);

export const discoveryFindings = pgTable('discovery_findings', {
  id: id(),
  runId: uuid('run_id').notNull().references(() => discoveryRuns.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  siteId: uuid('site_id'),
  ipAddress: text('ip_address').notNull(),
  hostname: text('hostname'),
  fqdn: text('fqdn'),
  macAddress: text('mac_address'),
  manufacturer: text('manufacturer'),
  model: text('model'),
  serialNumber: text('serial_number'),
  sysDescr: text('sys_descr'),
  sysObjectId: text('sys_object_id'),
  suggestedTypeKey: text('suggested_type_key'),
  openPorts: integer('open_ports').array().notNull().default([]),
  interfaces: jsonb('interfaces').$type<Record<string, unknown>[]>().notNull().default([]),
  neighbors: jsonb('neighbors').$type<Record<string, unknown>[]>().notNull().default([]),
  raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
  matchedCiId: uuid('matched_ci_id'),
  /** new | changed | unchanged */
  diffStatus: text('diff_status').notNull().default('new'),
  /** pending | applied | ignored */
  status: text('status').notNull().default('pending'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  appliedBy: uuid('applied_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('discovery_findings_run_idx').on(t.runId), index('discovery_findings_customer_idx').on(t.customerId, t.status)]);
