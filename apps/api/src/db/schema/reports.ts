import { pgTable, text, boolean, uuid, jsonb, index, integer, timestamp, date, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { customers } from './customers';
import { users } from './iam';

export const reportSchedules = pgTable('report_schedules', {
  id: id(),
  name: text('name').notNull(),
  reportKey: text('report_key').notNull(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  recipients: text('recipients').array().notNull().default([]),
  recipientUserIds: uuid('recipient_user_ids').array().notNull().default([]),
  /** daily | weekly | monthly | quarterly | cron */
  frequency: text('frequency').notNull().default('weekly'),
  cronExpression: text('cron_expression'),
  timezone: text('timezone').notNull().default('UTC'),
  /** last_day | last_7_days | last_30_days | month_to_date | last_month | quarter_to_date | last_quarter | custom */
  dateRange: text('date_range').notNull().default('last_7_days'),
  filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
  format: text('format').notNull().default('html'),
  /** email | portal | both */
  delivery: text('delivery').notNull().default('email'),
  isActive: boolean('is_active').notNull().default(true),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [index('report_schedules_next_run_idx').on(t.isActive, t.nextRunAt), index('report_schedules_customer_idx').on(t.customerId)]);

export const reportRuns = pgTable('report_runs', {
  id: id(),
  scheduleId: uuid('schedule_id').references(() => reportSchedules.id, { onDelete: 'set null' }),
  reportKey: text('report_key').notNull(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  parameters: jsonb('parameters').$type<Record<string, unknown>>().notNull().default({}),
  format: text('format').notNull().default('html'),
  status: text('status').notNull().default('queued'),
  attachmentId: uuid('attachment_id'),
  rowCount: integer('row_count'),
  error: text('error'),
  deliveredTo: text('delivered_to').array().notNull().default([]),
  portalVisible: boolean('portal_visible').notNull().default(false),
  requestedBy: uuid('requested_by'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('report_runs_customer_idx').on(t.customerId, t.createdAt), index('report_runs_schedule_idx').on(t.scheduleId)]);

/** Daily pre-aggregated metrics per customer for fast dashboards at scale. */
export const metricRollupsDaily = pgTable('metric_rollups_daily', {
  id: id(),
  day: date('day').notNull(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  metrics: jsonb('metrics').$type<Record<string, number>>().notNull().default({}),
  computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('metric_rollups_day_customer_idx').on(t.day, t.customerId)]);
