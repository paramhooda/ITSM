import { pgTable, text, boolean, uuid, integer, index, uniqueIndex, unique, timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps, ticketTypeEnum } from './_common';
import { customers, contacts } from './customers';
import { contracts } from './contracts';
import { tickets } from './tickets';
import { teams, users } from './iam';

/**
 * Survey policy overrides per customer (contract_id NULL) or per contract of a
 * customer. Every column except the scope is nullable: NULL inherits the
 * global `surveys.*` setting. Resolution order: contract row, customer row, settings.
 */
export const surveyConfigs = pgTable('survey_configs', {
  id: id(),
  customerId: uuid('customer_id').notNull().references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  contractId: uuid('contract_id').references((): AnyPgColumn => contracts.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled'),
  /** resolved | closed */
  sendOn: text('send_on'),
  resendOnClose: boolean('resend_on_close'),
  samplingPct: integer('sampling_pct'),
  question: text('question'),
  commentPrompt: text('comment_prompt'),
  reminderDays: integer('reminder_days'),
  expiryDays: integer('expiry_days'),
  fatigueDays: integer('fatigue_days'),
  lowRatingThreshold: integer('low_rating_threshold'),
  /** NULL inherits; otherwise a subset of incident | request | problem | change */
  ticketTypes: text('ticket_types').array(),
  notes: text('notes'),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [
  unique('survey_configs_scope_uniq').on(t.customerId, t.contractId).nullsNotDistinct(),
  index('survey_configs_customer_idx').on(t.customerId),
]);

export type SurveyStatus = 'pending' | 'answered' | 'expired' | 'cancelled';
export type SurveyTrigger = 'resolved' | 'closed' | 'manual';
export type SurveyChannel = 'email' | 'portal' | 'assistant';

/** One satisfaction survey per ticket: who was asked, how, and what they answered. */
export const ticketSurveys = pgTable('ticket_surveys', {
  id: id(),
  ticketId: uuid('ticket_id').notNull().references((): AnyPgColumn => tickets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  /** Snapshot of who handled the ticket when the survey went out, so per-engineer CSAT survives a later reassignment. */
  assigneeId: uuid('assignee_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  assignedTeamId: uuid('assigned_team_id').references((): AnyPgColumn => teams.id, { onDelete: 'set null' }),
  serviceId: uuid('service_id'),
  priorityId: uuid('priority_id'),
  ticketType: ticketTypeEnum('ticket_type').notNull(),
  trigger: text('trigger').$type<SurveyTrigger>().notNull(),
  question: text('question').notNull(),
  commentPrompt: text('comment_prompt'),
  recipientUserId: uuid('recipient_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  recipientContactId: uuid('recipient_contact_id').references((): AnyPgColumn => contacts.id, { onDelete: 'set null' }),
  recipientEmail: text('recipient_email'),
  recipientName: text('recipient_name'),
  tokenHash: text('token_hash').notNull(),
  tokenPrefix: text('token_prefix').notNull(),
  /** The token encrypted at rest (lib/crypto encryptSecret) so the reminder can re-send the same link. */
  tokenEnc: text('token_enc').notNull(),
  status: text('status').$type<SurveyStatus>().notNull().default('pending'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  /** The closure resend, when the survey went out on resolution and was still unanswered at closure. */
  resentAt: timestamp('resent_at', { withTimezone: true }),
  sendCount: integer('send_count').notNull().default(1),
  rating: integer('rating'),
  comment: text('comment'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  answeredByUserId: uuid('answered_by_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  channel: text('channel').$type<SurveyChannel>(),
  lowRatingAlertedAt: timestamp('low_rating_alerted_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  uniqueIndex('ticket_surveys_ticket_uniq').on(t.ticketId),
  uniqueIndex('ticket_surveys_token_uniq').on(t.tokenHash),
  index('ticket_surveys_customer_answered_idx').on(t.customerId, t.answeredAt),
  index('ticket_surveys_customer_requested_idx').on(t.customerId, t.requestedAt),
  index('ticket_surveys_status_idx').on(t.status, t.requestedAt),
  index('ticket_surveys_assignee_idx').on(t.assigneeId, t.answeredAt),
  index('ticket_surveys_recipient_idx').on(t.recipientUserId, t.requestedAt),
]);
