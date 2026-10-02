import { pgTable, text, boolean, uuid, jsonb, index, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps, slaMetricEnum, slaStateEnum, ticketTypeEnum } from './_common';
import { configOptions, businessCalendars, holidayCalendars } from './config';
import { customers } from './customers';

export const slaPolicies = pgTable('sla_policies', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  calendarId: uuid('calendar_id').references(() => businessCalendars.id, { onDelete: 'set null' }),
  holidayCalendarId: uuid('holiday_calendar_id').references(() => holidayCalendars.id, { onDelete: 'set null' }),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const slaTargets = pgTable('sla_targets', {
  id: id(),
  policyId: uuid('policy_id').notNull().references(() => slaPolicies.id, { onDelete: 'cascade' }),
  ticketType: ticketTypeEnum('ticket_type').notNull().default('incident'),
  priorityId: uuid('priority_id').references(() => configOptions.id, { onDelete: 'cascade' }),
  metric: slaMetricEnum('metric').notNull(),
  minutes: integer('minutes').notNull(),
  warnPct: integer('warn_pct').notNull().default(75),
  /** When true, the clock runs on calendar time regardless of business hours. */
  calendarTime: boolean('calendar_time').notNull().default(false),
}, (t) => [
  uniqueIndex('sla_targets_unique_idx').on(t.policyId, t.ticketType, t.priorityId, t.metric),
  index('sla_targets_policy_idx').on(t.policyId),
]);

/** Status overrides for pausing: policy-specific pause statuses (in addition to status.pauses_sla). */
export const slaPauseStatuses = pgTable('sla_pause_statuses', {
  policyId: uuid('policy_id').notNull().references(() => slaPolicies.id, { onDelete: 'cascade' }),
  statusId: uuid('status_id').notNull().references(() => configOptions.id, { onDelete: 'cascade' }),
}, (t) => [uniqueIndex('sla_pause_statuses_idx').on(t.policyId, t.statusId)]);

/** One row per ticket per SLA metric. */
export const ticketSlas = pgTable('ticket_slas', {
  id: id(),
  ticketId: uuid('ticket_id').notNull(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  policyId: uuid('policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
  metric: slaMetricEnum('metric').notNull(),
  targetMinutes: integer('target_minutes').notNull(),
  warnPct: integer('warn_pct').notNull().default(75),
  calendarTime: boolean('calendar_time').notNull().default(false),
  calendarSnapshot: jsonb('calendar_snapshot').$type<Record<string, unknown>>().notNull().default({}),
  state: slaStateEnum('state').notNull().default('running'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  pausedMinutes: integer('paused_minutes').notNull().default(0),
  warnedAt: timestamp('warned_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  breachedAt: timestamp('breached_at', { withTimezone: true }),
  elapsedMinutesAtCompletion: integer('elapsed_minutes_at_completion'),
  ...timestamps,
}, (t) => [
  uniqueIndex('ticket_slas_ticket_metric_idx').on(t.ticketId, t.metric),
  index('ticket_slas_state_due_idx').on(t.state, t.dueAt),
  index('ticket_slas_customer_idx').on(t.customerId),
]);

export const ticketSlaEvents = pgTable('ticket_sla_events', {
  id: id(),
  ticketSlaId: uuid('ticket_sla_id').notNull().references(() => ticketSlas.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  eventType: text('event_type').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('ticket_sla_events_sla_idx').on(t.ticketSlaId)]);

export const escalationLog = pgTable('escalation_log', {
  id: id(),
  ticketId: uuid('ticket_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  ruleId: uuid('rule_id'),
  level: integer('level').notNull().default(1),
  reason: text('reason').notNull(),
  actions: jsonb('actions').$type<Record<string, unknown>>().notNull().default({}),
  triggeredBy: uuid('triggered_by'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('escalation_log_ticket_idx').on(t.ticketId)]);
