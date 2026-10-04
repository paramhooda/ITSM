import { pgTable, text, boolean, timestamp, uuid, jsonb, integer, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { users } from './iam';
import { customers } from './customers';
import { configOptions } from './config';
import { services } from './services';
import { tickets } from './tickets';

/**
 * Change management: blackout windows (global or per customer), the risk
 * questionnaire, standard change templates, and CAB meetings with their
 * items. `change_details` carries the answers, the score and the links
 * (columns there are plain uuids: tickets.ts cannot import this file).
 */

export type CabDecision = 'pending' | 'approved' | 'rejected' | 'deferred';
export type CabMeetingStatus = 'scheduled' | 'in_progress' | 'closed' | 'cancelled';
export type ChangeRiskLevel = 'low' | 'medium' | 'high';

/** One answer option of a risk question. */
export interface RiskOption {
  key: string;
  label: string;
  score: number;
}

/** A period when normal changes must not be implemented (emergency changes may be let through). */
export const changeBlackoutWindows = pgTable('change_blackout_windows', {
  id: id(),
  /** Null = every customer. Row-level security lets everyone read null rows. */
  customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  reason: text('reason'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  /** Emergency changes may still be scheduled inside the window. */
  allowEmergency: boolean('allow_emergency').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [index('change_blackouts_window_idx').on(t.startsAt, t.endsAt), index('change_blackouts_customer_idx').on(t.customerId)]);

/** The risk questionnaire: each question weighs its chosen option's score. */
export const changeRiskQuestions = pgTable('change_risk_questions', {
  id: id(),
  key: text('key').notNull(),
  question: text('question').notNull(),
  hint: text('hint'),
  weight: integer('weight').notNull().default(1),
  options: jsonb('options').$type<RiskOption[]>().notNull().default([]),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [uniqueIndex('change_risk_questions_key_uniq').on(t.key), index('change_risk_questions_order_idx').on(t.sortOrder)]);

/** A pre-approved, repeatable change: prefills the form and may skip approval. */
export const changeTemplates = pgTable('change_templates', {
  id: id(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** standard | normal | emergency (standard by definition). */
  changeType: text('change_type').notNull().default('standard'),
  categoryId: uuid('category_id').references((): AnyPgColumn => configOptions.id, { onDelete: 'set null' }),
  serviceId: uuid('service_id').references((): AnyPgColumn => services.id, { onDelete: 'set null' }),
  riskId: uuid('risk_id').references((): AnyPgColumn => configOptions.id, { onDelete: 'set null' }),
  titleTemplate: text('title_template'),
  descriptionTemplate: text('description_template'),
  justification: text('justification'),
  implementationPlan: text('implementation_plan'),
  testPlan: text('test_plan'),
  backoutPlan: text('backout_plan'),
  communicationPlan: text('communication_plan'),
  downtimeExpectedMinutes: integer('downtime_expected_minutes'),
  /** Pre-approved: the ticket starts with approval not required. */
  skipApproval: boolean('skip_approval').notNull().default(true),
  /** Customers the template is offered to; empty = every customer. */
  customerIds: uuid('customer_ids').array().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [uniqueIndex('change_templates_key_uniq').on(t.key)]);

/** A CAB meeting: an agenda of changes and the decisions taken. */
export const cabMeetings = pgTable('cab_meetings', {
  id: id(),
  title: text('title').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  chairUserId: uuid('chair_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  /** Room, or the bridge link, shown on the meeting page and in the generated minutes (never in a notification: the requester may be a customer). */
  location: text('location'),
  /** People expected at the table; listed in the generated minutes. */
  attendeeUserIds: uuid('attendee_user_ids').array().notNull().default([]),
  /** scheduled | in_progress | closed | cancelled */
  status: text('status').notNull().default('scheduled'),
  minutes: text('minutes'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [index('cab_meetings_scheduled_idx').on(t.scheduledAt), index('cab_meetings_status_idx').on(t.status)]);

export const cabMeetingItems = pgTable('cab_meeting_items', {
  id: id(),
  meetingId: uuid('meeting_id').notNull().references((): AnyPgColumn => cabMeetings.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id').notNull().references((): AnyPgColumn => tickets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  /** pending | approved | rejected | deferred */
  decision: text('decision').notNull().default('pending'),
  notes: text('notes'),
  decidedBy: uuid('decided_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
}, (t) => [uniqueIndex('cab_meeting_items_uniq').on(t.meetingId, t.ticketId), index('cab_meeting_items_ticket_idx').on(t.ticketId)]);
