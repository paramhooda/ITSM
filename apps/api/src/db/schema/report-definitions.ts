import { pgTable, text, boolean, uuid, jsonb, integer, timestamp, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { customers } from './customers';
import { users } from './iam';

/** One filter row of a custom report; values are typed by the catalogue field. */
export interface ReportFilter {
  field: string;
  op: string;
  value?: unknown;
}
export interface ReportAggregate {
  fn: 'count' | 'sum' | 'avg' | 'min' | 'max';
  field?: string;
  label?: string;
}
export interface ReportChartSpec {
  type: 'bar' | 'line';
  y: string[];
}
/** The whole whitelisted specification compiled by reports/builder/compile.ts; nothing in it is SQL. */
export interface ReportSpec {
  columns: string[];
  filters: ReportFilter[];
  match: 'all' | 'any';
  groupBy: string[];
  aggregates: ReportAggregate[];
  sort: { key: string; order: 'asc' | 'desc' } | null;
  dateField: string | null;
  rowLimit: number | null;
  chart: ReportChartSpec | null;
}

/**
 * Custom report definitions built in the browser. The row is an MSP artefact, not
 * customer data: it carries `scope_customer_id` (not `customer_id`) on purpose so the
 * automatic tenant policy does not apply; platform.sql has an explicit policy that
 * lets staff read and write every row and portal users read only the rows published
 * to the portal for their organisation (or for every customer).
 */
export const reportDefinitions = pgTable('report_definitions', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  category: text('category').notNull().default('custom'),
  /** Catalogue entity key (tickets, changes, problems, sla_clocks, time_entries, visits, assets, cis, contracts, entitlements, surveys, software). */
  entity: text('entity').notNull(),
  spec: jsonb('spec').$type<ReportSpec>().notNull(),
  defaultDateRange: text('default_date_range').notNull().default('last_30_days'),
  /** NULL = the customer is chosen at run time; set = always this customer. */
  scopeCustomerId: uuid('scope_customer_id').references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  /** private | shared */
  visibility: text('visibility').notNull().default('private'),
  sharedRoleKeys: text('shared_role_keys').array().notNull().default([]),
  sharedTeamIds: uuid('shared_team_ids').array().notNull().default([]),
  portalVisible: boolean('portal_visible').notNull().default(false),
  cover: boolean('cover').notNull().default(false),
  /** false = retired: gone from the catalogue, its past runs stay in History. */
  isActive: boolean('is_active').notNull().default(true),
  runCount: integer('run_count').notNull().default(0),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  index('report_definitions_owner_idx').on(t.ownerId),
  index('report_definitions_scope_customer_idx').on(t.scopeCustomerId),
  index('report_definitions_entity_idx').on(t.entity),
]);
