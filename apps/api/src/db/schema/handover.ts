import { pgTable, text, integer, date, timestamp, uuid, jsonb, boolean, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { teams, users } from './iam';

/**
 * Shift handover for operations teams (NOC, SOC, service desk). A team
 * defines its shifts (name, start and end time of day, weekdays, timezone);
 * at the end of a shift the outgoing engineer writes the handover from a
 * digest of what is open, breached, at risk, major, awaiting the customer and
 * scheduled next, publishes it to the incoming shift and the incoming
 * engineer acknowledges it. Both tables are shared (no customer column):
 * platform.sql policies restrict them to staff.
 */

export type HandoverStatus = 'draft' | 'final' | 'acknowledged';

export const teamShifts = pgTable('team_shifts', {
  id: id(),
  teamId: uuid('team_id').notNull().references((): AnyPgColumn => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** Local time of day, HH:MM. */
  startTime: text('start_time').notNull(),
  /** Local time of day, HH:MM; earlier than startTime for a shift that crosses midnight. */
  endTime: text('end_time').notNull(),
  /** ISO weekdays the shift runs (1 = Monday … 7 = Sunday). */
  days: integer('days').array().notNull().default([1, 2, 3, 4, 5, 6, 7]),
  timezone: text('timezone').notNull().default('UTC'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [index('team_shifts_team_idx').on(t.teamId, t.sortOrder)]);

/** The digest the handover was written from: exact counts and the lists behind them. */
export interface HandoverFacts {
  generatedAt: string;
  team: { id: string; name: string };
  counts: { open: number; p1p2: number; breached: number; atRisk: number; unassigned: number; awaitingCustomer: number; major: number; changesNext: number; openedInShift: number; resolvedInShift: number };
  tickets: { key: 'p1p2' | 'breached' | 'atRisk' | 'awaitingCustomer' | 'unassigned'; title: string; items: { id: string; number: string; title: string; priority: string | null; status: string | null; customer: string | null; assignee: string | null; slaDueAt: string | null; breachRisk: string | null }[] }[];
  major: { id: string; number: string; title: string; status: string | null; customer: string | null; commander: string | null; nextUpdateAt: string | null }[];
  changes: { id: string; number: string; title: string; customer: string | null; scheduledStart: string | null; scheduledEnd: string | null; changeType: string | null }[];
  onCall: { now: { userId: string; name: string; rota: string | null; until: string | null }[]; next: { userId: string; name: string; rota: string | null; from: string | null }[] };
  window: { from: string; to: string };
}

export const shiftHandovers = pgTable('shift_handovers', {
  id: id(),
  teamId: uuid('team_id').notNull().references((): AnyPgColumn => teams.id, { onDelete: 'cascade' }),
  shiftId: uuid('shift_id').references((): AnyPgColumn => teamShifts.id, { onDelete: 'set null' }),
  /** The day the outgoing shift belongs to (in the shift's timezone). */
  shiftDate: date('shift_date').notNull(),
  authorId: uuid('author_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  /** draft | final | acknowledged */
  status: text('status').notNull().default('draft'),
  /** The text the assistant proposed, kept so the edit can be compared. */
  aiDraft: text('ai_draft'),
  /** The handover as published, Markdown. */
  body: text('body').notNull().default(''),
  facts: jsonb('facts').$type<HandoverFacts | null>(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  acknowledgedBy: uuid('acknowledged_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgementNote: text('acknowledgement_note'),
  ...timestamps,
}, (t) => [index('shift_handovers_team_idx').on(t.teamId, t.shiftDate), index('shift_handovers_status_idx').on(t.status)]);
