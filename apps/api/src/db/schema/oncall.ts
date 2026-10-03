import { pgTable, text, boolean, timestamp, uuid, jsonb, index, uniqueIndex, integer, date, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { teams, users } from './iam';
import { tickets } from './tickets';

/**
 * On-call: a team's rotas (who covers when), overrides (swaps and cover),
 * escalation policies (whom to page, over which channels, for how long before
 * the next step) and the pages themselves. Rotas and policies are global
 * (team-scoped) rows; pages carry the ticket's customer so row-level security
 * applies to them like any other ticket record.
 */

export type NotificationChannelKey = 'email' | 'in_app' | 'whatsapp';

/** One step of an escalation policy. */
export interface EscalationStep {
  /** oncall = whoever the team's rotas say; user = a named person; team = every member; manager = the team's manager. */
  target: 'oncall' | 'user' | 'team' | 'manager';
  userId?: string | null;
  teamId?: string | null;
  channels: NotificationChannelKey[];
  /** Minutes to wait for an acknowledgement before the next step (or the end of the policy). */
  timeoutMinutes: number;
}

export const oncallRotas = pgTable('oncall_rotas', {
  id: id(),
  teamId: uuid('team_id').notNull().references((): AnyPgColumn => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  /** IANA zone the handoff time and shift window are expressed in. */
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  /** weekly | daily | custom (every `rotation_days` days) */
  rotation: text('rotation').notNull().default('weekly'),
  rotationDays: integer('rotation_days').notNull().default(7),
  /** Local time of day the shift hands over, HH:mm. */
  handoffTime: text('handoff_time').notNull().default('09:00'),
  /** Optional daily window (HH:mm, local); outside it nobody from this rota is on call. Null = around the clock. */
  shiftStart: text('shift_start'),
  shiftEnd: text('shift_end'),
  /** The date of the first handoff: the first participant starts then. */
  startDate: date('start_date').notNull(),
  /** Primary first; the first rota with someone on call is the page target. */
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [index('oncall_rotas_team_idx').on(t.teamId, t.sortOrder)]);

export const oncallRotaParticipants = pgTable('oncall_rota_participants', {
  id: id(),
  rotaId: uuid('rota_id').notNull().references((): AnyPgColumn => oncallRotas.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
}, (t) => [uniqueIndex('oncall_rota_participants_uniq').on(t.rotaId, t.userId), index('oncall_rota_participants_rota_idx').on(t.rotaId, t.position)]);

/** A person covering a rota for a period, whatever the rotation says (swap, leave cover, extra hands). */
export const oncallOverrides = pgTable('oncall_overrides', {
  id: id(),
  rotaId: uuid('rota_id').notNull().references((): AnyPgColumn => oncallRotas.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('oncall_overrides_rota_idx').on(t.rotaId, t.startsAt)]);

export const escalationPolicies = pgTable('oncall_escalation_policies', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  steps: jsonb('steps').$type<EscalationStep[]>().notNull().default([]),
  /** How many more times the whole step list runs when nobody acknowledges (0 = once). */
  repeatCount: integer('repeat_count').notNull().default(0),
  /** When the page is acknowledged and the ticket has no assignee, assign it to the acknowledger. */
  assignOnAck: boolean('assign_on_ack').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

/**
 * One row per page step. A chain shares `root_page_id`; the step that times out
 * is marked escalated and the next row is created. Acknowledging any pending row
 * closes the chain.
 */
export const pages = pgTable('pages', {
  id: id(),
  ticketId: uuid('ticket_id').notNull().references((): AnyPgColumn => tickets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  policyId: uuid('policy_id').references((): AnyPgColumn => escalationPolicies.id, { onDelete: 'set null' }),
  rootPageId: uuid('root_page_id').references((): AnyPgColumn => pages.id, { onDelete: 'cascade' }),
  step: integer('step').notNull().default(0),
  cycle: integer('cycle').notNull().default(0),
  /** oncall | user | team | manager (what the step asked for) */
  targetKind: text('target_kind').notNull().default('oncall'),
  targetUserId: uuid('target_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  targetTeamId: uuid('target_team_id').references((): AnyPgColumn => teams.id, { onDelete: 'set null' }),
  channels: text('channels').array().notNull().default([]),
  /** pending | acked | escalated | expired | cancelled */
  status: text('status').notNull().default('pending'),
  /** rule | manual | ai */
  source: text('source').notNull().default('manual'),
  reason: text('reason'),
  ackTokenHash: text('ack_token_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  ackedBy: uuid('acked_by'),
  ackedAt: timestamp('acked_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  ...timestamps,
}, (t) => [
  index('pages_ticket_idx').on(t.ticketId, t.createdAt),
  index('pages_status_idx').on(t.status, t.expiresAt),
  uniqueIndex('pages_ack_token_idx').on(t.ackTokenHash),
]);
