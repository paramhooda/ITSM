import { pgTable, text, boolean, uuid, jsonb, index, integer, numeric, timestamp, date } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { customers, sites } from './customers';
import { configOptions } from './config';
import { contracts, contractEntitlements } from './contracts';
import { services } from './services';
import { teams, users } from './iam';
import { tickets } from './tickets';

export const fieldVisits = pgTable('field_visits', {
  id: id(),
  number: text('number').notNull().unique(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  contractId: uuid('contract_id').references(() => contracts.id, { onDelete: 'set null' }),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  typeId: uuid('type_id').references(() => configOptions.id, { onDelete: 'set null' }),
  pmOccurrenceId: uuid('pm_occurrence_id'),
  title: text('title').notNull(),
  purpose: text('purpose'),
  status: text('status').notNull().default('requested'),
  engineerId: uuid('engineer_id').references(() => users.id, { onDelete: 'set null' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  additionalEngineerIds: uuid('additional_engineer_ids').array().notNull().default([]),
  requestedBy: uuid('requested_by'),
  scheduledStart: timestamp('scheduled_start', { withTimezone: true }),
  scheduledEnd: timestamp('scheduled_end', { withTimezone: true }),
  actualStart: timestamp('actual_start', { withTimezone: true }),
  actualEnd: timestamp('actual_end', { withTimezone: true }),
  travelMinutes: integer('travel_minutes'),
  workMinutes: integer('work_minutes'),
  workSummary: text('work_summary'),
  findings: text('findings'),
  recommendations: text('recommendations'),
  checklist: jsonb('checklist').$type<Record<string, unknown>[]>().notNull().default([]),
  customerAckName: text('customer_ack_name'),
  customerAckTitle: text('customer_ack_title'),
  customerAckAt: timestamp('customer_ack_at', { withTimezone: true }),
  customerAckNotes: text('customer_ack_notes'),
  customerRating: integer('customer_rating'),
  entitlementId: uuid('entitlement_id').references(() => contractEntitlements.id, { onDelete: 'set null' }),
  consumptionId: uuid('consumption_id'),
  billable: boolean('billable').notNull().default(false),
  reportGeneratedAt: timestamp('report_generated_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => [
  index('field_visits_customer_idx').on(t.customerId),
  index('field_visits_engineer_idx').on(t.engineerId, t.scheduledStart),
  index('field_visits_status_idx').on(t.status),
  index('field_visits_ticket_idx').on(t.ticketId),
]);

export const fieldVisitParts = pgTable('field_visit_parts', {
  id: id(),
  visitId: uuid('visit_id').notNull().references(() => fieldVisits.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  name: text('name').notNull(),
  partNumber: text('part_number'),
  serialNumber: text('serial_number'),
  quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull().default('1'),
  unitCost: numeric('unit_cost', { precision: 12, scale: 2 }),
  assetId: uuid('asset_id'),
  billable: boolean('billable').notNull().default(false),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('field_visit_parts_visit_idx').on(t.visitId)]);

export const fieldVisitNotes = pgTable('field_visit_notes', {
  id: id(),
  visitId: uuid('visit_id').notNull().references(() => fieldVisits.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  authorId: uuid('author_id'),
  authorName: text('author_name'),
  body: text('body').notNull(),
  isInternal: boolean('is_internal').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('field_visit_notes_visit_idx').on(t.visitId)]);

/** Preventive maintenance programs generate occurrences on a schedule. */
export const pmPrograms = pgTable('pm_programs', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
  contractId: uuid('contract_id').references(() => contracts.id, { onDelete: 'set null' }),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  entitlementId: uuid('entitlement_id').references(() => contractEntitlements.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  /** monthly | quarterly | half_yearly | annual | weekly | custom */
  frequency: text('frequency').notNull().default('quarterly'),
  intervalDays: integer('interval_days'),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  leadDays: integer('lead_days').notNull().default(14),
  graceDays: integer('grace_days').notNull().default(7),
  /** [{ item, required }] */
  checklist: jsonb('checklist').$type<Record<string, unknown>[]>().notNull().default([]),
  assignedTeamId: uuid('assigned_team_id').references(() => teams.id, { onDelete: 'set null' }),
  assignedEngineerId: uuid('assigned_engineer_id').references(() => users.id, { onDelete: 'set null' }),
  ciIds: uuid('ci_ids').array().notNull().default([]),
  assetIds: uuid('asset_ids').array().notNull().default([]),
  requiresSiteVisit: boolean('requires_site_visit').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [index('pm_programs_customer_idx').on(t.customerId)]);

export const pmOccurrences = pgTable('pm_occurrences', {
  id: id(),
  programId: uuid('program_id').notNull().references(() => pmPrograms.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  plannedDate: date('planned_date').notNull(),
  scheduledDate: date('scheduled_date'),
  status: text('status').notNull().default('planned'),
  fieldVisitId: uuid('field_visit_id').references(() => fieldVisits.id, { onDelete: 'set null' }),
  ticketId: uuid('ticket_id'),
  engineerId: uuid('engineer_id'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  checklistResults: jsonb('checklist_results').$type<Record<string, unknown>[]>().notNull().default([]),
  notes: text('notes'),
  rescheduleReason: text('reschedule_reason'),
  ...timestamps,
}, (t) => [index('pm_occurrences_program_idx').on(t.programId, t.plannedDate), index('pm_occurrences_customer_status_idx').on(t.customerId, t.status)]);
