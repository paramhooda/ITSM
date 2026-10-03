import { pgTable, text, boolean, date, timestamp, uuid, jsonb, integer, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id } from './_common';
import { users } from './iam';

/**
 * Daily briefings: one row per person and local day, generated at the time
 * they chose (users.preferences.briefing) from the facts their role cares
 * about, phrased by the model when one is on. Shared table without a customer
 * column: platform.sql restricts rows to their own person.
 */

export type BriefingRole = 'engineer' | 'noc_manager' | 'soc_manager' | 'service_manager' | 'account_manager';

export interface BriefingItem {
  /** The reference people recognise: a ticket number, a contract number, a customer name. */
  ref: string;
  title: string;
  meta?: string | null;
  /** App-relative link. */
  link?: string | null;
}

export interface BriefingSection {
  key: string;
  title: string;
  /** One sentence with the exact figures behind the list. */
  summary?: string | null;
  items: BriefingItem[];
}

export interface BriefingFacts {
  role: BriefingRole;
  roleLabel: string;
  day: string;
  timezone: string;
  generatedAt: string;
  /** The two to four sentences that matter most, with exact figures. */
  headline: string[];
  sections: BriefingSection[];
}

export const briefings = pgTable('briefings', {
  id: id(),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  roleKey: text('role_key').notNull(),
  /** The person's local day. */
  day: date('day').notNull(),
  facts: jsonb('facts').$type<BriefingFacts | null>(),
  /** Markdown shown on the dashboard card. */
  text: text('text').notNull().default(''),
  /** The same briefing as email HTML. */
  html: text('html').notNull().default(''),
  /** True when the model phrased it; false for the deterministic text. */
  ai: boolean('ai').notNull().default(false),
  channels: text('channels').array().notNull().default([]),
  /** How many times the briefing for this day was (re)generated on request; the manual cap counts these. */
  generations: integer('generations').notNull().default(1),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('briefings_user_day_idx').on(t.userId, t.day)]);
