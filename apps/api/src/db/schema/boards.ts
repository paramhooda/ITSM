import { pgTable, text, boolean, uuid, integer, date, timestamp, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { teams, users } from './iam';

/**
 * Sticky notes on the task boards: one person's scratch notes for the shift,
 * optionally pinned to a team board. Shared table without a customer column:
 * platform.sql restricts rows to their author (the briefings pattern). The
 * boards themselves are views over tickets and ticket_tasks and need no table;
 * the per-person board layout lives in users.preferences.
 */
export type BoardKind = 'tickets' | 'tasks';
export const BOARD_NOTE_COLORS = ['amber', 'blue', 'green', 'rose', 'slate'] as const;
export type BoardNoteColor = (typeof BOARD_NOTE_COLORS)[number];

export const boardNotes = pgTable('board_notes', {
  id: id(),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  /** The team board the note was written on; null for My board. */
  teamId: uuid('team_id').references((): AnyPgColumn => teams.id, { onDelete: 'set null' }),
  /** tickets | tasks */
  board: text('board').$type<BoardKind>().notNull().default('tickets'),
  body: text('body').notNull(),
  /** amber | blue | green | rose | slate (palette names from statusColors) */
  color: text('color').$type<BoardNoteColor>().notNull().default('amber'),
  pinned: boolean('pinned').notNull().default(false),
  done: boolean('done').notNull().default(false),
  /** When the note was marked done; the retention purge counts from here, so later edits never restart it. */
  doneAt: timestamp('done_at', { withTimezone: true }),
  /** The author's local day the note was written for; purged with the done notes. */
  shiftDate: date('shift_date'),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
}, (t) => [index('board_notes_user_idx').on(t.userId, t.board), index('board_notes_team_idx').on(t.teamId)]);
