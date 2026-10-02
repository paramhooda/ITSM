import { pgTable, text, boolean, uuid, jsonb, index, uniqueIndex, integer, primaryKey, date, timestamp } from 'drizzle-orm/pg-core';
import { id, timestamps, statusCategoryEnum, domainEnum } from './_common';

/**
 * Generic configurable option lists: categories, statuses, priorities, sources,
 * contract types, scope headers, asset categories, visit types... Anything the
 * MSP should be able to tune without code changes.
 */
export const configOptions = pgTable('config_options', {
  id: id(),
  type: text('type').notNull(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  description: text('description'),
  parentId: uuid('parent_id'),
  domain: domainEnum('domain').notNull().default('general'),
  /** For ticket statuses: the lifecycle category this status maps to. */
  statusCategory: statusCategoryEnum('status_category'),
  /** For ticket statuses: whether SLA clocks pause while in this status. */
  pausesSla: boolean('pauses_sla').notNull().default(false),
  /** For priorities: numeric level (1 = highest). */
  level: integer('level'),
  color: text('color'),
  icon: text('icon'),
  sortOrder: integer('sort_order').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  /** Ticket types this option applies to (empty = all). */
  appliesTo: text('applies_to').array().notNull().default([]),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => [
  uniqueIndex('config_options_type_key_idx').on(t.type, t.key),
  index('config_options_type_idx').on(t.type),
  index('config_options_parent_idx').on(t.parentId),
]);

/** Impact x Urgency -> Priority. */
export const priorityMatrix = pgTable('priority_matrix', {
  impactId: uuid('impact_id').notNull().references(() => configOptions.id, { onDelete: 'cascade' }),
  urgencyId: uuid('urgency_id').notNull().references(() => configOptions.id, { onDelete: 'cascade' }),
  priorityId: uuid('priority_id').notNull().references(() => configOptions.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.impactId, t.urgencyId] })]);

/** Custom fields that extend core entities (stored in each entity's custom_fields jsonb). */
export const customFieldDefinitions = pgTable('custom_field_definitions', {
  id: id(),
  entity: text('entity').notNull(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  fieldType: text('field_type').notNull().default('text'),
  options: jsonb('options').$type<{ value: string; label: string }[]>().notNull().default([]),
  required: boolean('required').notNull().default(false),
  customerVisible: boolean('customer_visible').notNull().default(false),
  helpText: text('help_text'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [uniqueIndex('custom_field_entity_key_idx').on(t.entity, t.key)]);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  description: text('description'),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Weekly working hours (per timezone) used by SLA policies and sites. */
export const businessCalendars = pgTable('business_calendars', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  timezone: text('timezone').notNull().default('UTC'),
  is24x7: boolean('is_24x7').notNull().default(false),
  /** { mon: [["09:00","18:00"]], tue: [...], ... } */
  hours: jsonb('hours').$type<Record<string, [string, string][]>>().notNull().default({}),
  holidayCalendarId: uuid('holiday_calendar_id'),
  isDefault: boolean('is_default').notNull().default(false),
  ...timestamps,
});

export const holidayCalendars = pgTable('holiday_calendars', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  country: text('country'),
  ...timestamps,
});

export const holidays = pgTable('holidays', {
  id: id(),
  calendarId: uuid('calendar_id').notNull().references(() => holidayCalendars.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  name: text('name').notNull(),
}, (t) => [uniqueIndex('holidays_calendar_date_idx').on(t.calendarId, t.date)]);

export const notificationTemplates = pgTable('notification_templates', {
  id: id(),
  event: text('event').notNull(),
  channel: text('channel').notNull().default('email'),
  name: text('name').notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  isSystem: boolean('is_system').notNull().default(false),
  ...timestamps,
}, (t) => [uniqueIndex('notification_templates_event_channel_idx').on(t.event, t.channel)]);

/** Who gets notified for an event. */
export const notificationRules = pgTable('notification_rules', {
  id: id(),
  event: text('event').notNull(),
  name: text('name').notNull(),
  /** { assignee, team, requester, watchers, customerContacts, roles: [], users: [], emails: [] } */
  recipients: jsonb('recipients').$type<Record<string, unknown>>().notNull().default({}),
  channels: text('channels').array().notNull().default(['email', 'in_app']),
  conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [index('notification_rules_event_idx').on(t.event)]);

/** Automatic assignment of new tickets to teams / engineers. */
export const assignmentRules = pgTable('assignment_rules', {
  id: id(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  /** { ticketType, categoryIds, serviceIds, customerIds, priorityIds, domain, source } */
  conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull().default({}),
  teamId: uuid('team_id'),
  userId: uuid('user_id'),
  strategy: text('strategy').notNull().default('team'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

/** Escalation when SLA consumption crosses thresholds or tickets age. */
export const escalationRules = pgTable('escalation_rules', {
  id: id(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  /** { metric, thresholdPct, ticketTypes, priorityIds, customerIds, teamIds, onBreach } */
  conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull().default({}),
  /** { notifyTeamIds, notifyUserIds, notifyRoles, notifyManager, reassignTeamId, raisePriority, emails } */
  actions: jsonb('actions').$type<Record<string, unknown>>().notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const approvalWorkflows = pgTable('approval_workflows', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  /** [{ name, approverType: 'customer_contact'|'role'|'user'|'team'|'account_manager', approverRef, required: 'all'|'any' }] */
  steps: jsonb('steps').$type<Record<string, unknown>[]>().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});
