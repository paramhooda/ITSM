import { pgTable, text, boolean, date, timestamp, uuid, jsonb, integer, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id } from './_common';
import { users } from './iam';

/**
 * Daily briefings: one row per person and local day, generated at the time
 * they chose (users.preferences.briefing) from the facts their role cares
 * about, phrased by the model when one is on. Shared table without a customer
 * column: platform.sql restricts rows to their own person.
 *
 * The facts are the truth and are stored layout-ready: a KPI row, sections
 * with doors (counts that reproduce on the list they open) and typed items,
 * and the bounded narrative the model phrased (or the deterministic one) in
 * `facts.narrative`. Rows written before the narrative existed are normalised
 * on read (`normaliseFacts`), so no migration was needed.
 */

export type BriefingRole = 'engineer' | 'noc_manager' | 'soc_manager' | 'service_manager' | 'account_manager' | 'customer';

export type BriefingItemKind = 'ticket' | 'customer' | 'contract' | 'entitlement' | 'integration' | 'sla' | 'visit' | 'maintenance' | 'change' | 'approval' | 'announcement' | 'known_error';

/** A count with the list it opens: `href` null means a figure (no list predicate reproduces it). */
export interface BriefingDoor {
  label: string;
  value: number;
  href: string | null;
}

export interface BriefingItem {
  /** The reference people recognise: a ticket number, a contract number, a customer name. */
  ref: string;
  title: string;
  /** The one-line details for the email, built from the typed fields by `metaOf` so the two never disagree. */
  meta?: string | null;
  /** App-relative link. */
  link?: string | null;
  kind?: BriefingItemKind;
  priority?: { key: string | null; label: string | null; color: string | null } | null;
  customer?: string | null;
  /** The owner's name; null for the portal (never a staff name) and for unowned tickets. */
  assignee?: string | null;
  team?: string | null;
  dueAt?: string | null;
  breachRisk?: 'low' | 'medium' | 'high' | null;
  sentiment?: string | null;
  status?: string | null;
  /** When the item happens: an ISO instant (a visit, a change, an announcement) or a YYYY-MM-DD day (a maintenance window, a contract end), which is the same day in every timezone and is shown as given. */
  when?: string | null;
  /** Per-row doors (the account manager's customers: open and breached for that customer). */
  doors?: BriefingDoor[] | null;
}

export interface BriefingSection {
  key: string;
  title: string;
  /** The deterministic lead: one sentence with the exact figures behind the list, written from the door values. */
  summary?: string | null;
  /** The counts behind the section, each a door when it reproduces on a list. */
  doors: BriefingDoor[];
  items: BriefingItem[];
}

export interface BriefingKpi {
  key: string;
  label: string;
  value: number | string;
  tone: 'good' | 'warn' | 'bad' | null;
  href: string | null;
  hint?: string | null;
}

/** What the model phrased, bounded and grounded against the facts; `source` says whether any of it survived. */
export interface BriefingNarrative {
  greeting: string;
  summary: string;
  sections: { key: string; lead: string; picks: string[] }[];
  source: 'model' | 'facts';
}

export interface BriefingFacts {
  role: BriefingRole;
  roleLabel: string;
  day: string;
  timezone: string;
  generatedAt: string;
  /** The two to four sentences that matter most, with exact figures. */
  headline: string[];
  kpis: BriefingKpi[];
  sections: BriefingSection[];
  narrative?: BriefingNarrative | null;
}

/** A stored row's facts with the fields later versions added (`kpis`, `doors`, `narrative`) filled in; null stays null. */
export function normaliseFacts(raw: Partial<BriefingFacts> | null | undefined): BriefingFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    role: raw.role ?? 'engineer',
    roleLabel: raw.roleLabel ?? '',
    day: raw.day ?? '',
    timezone: raw.timezone ?? 'UTC',
    generatedAt: raw.generatedAt ?? '',
    headline: Array.isArray(raw.headline) ? raw.headline : [],
    kpis: Array.isArray(raw.kpis) ? raw.kpis : [],
    sections: Array.isArray(raw.sections) ? raw.sections.map((s) => ({ ...s, doors: Array.isArray(s.doors) ? s.doors : [], items: Array.isArray(s.items) ? s.items : [] })) : [],
    narrative: raw.narrative ?? null,
  };
}

export const briefings = pgTable('briefings', {
  id: id(),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  roleKey: text('role_key').notNull(),
  /** The person's local day. */
  day: date('day').notNull(),
  facts: jsonb('facts').$type<BriefingFacts | null>(),
  /** Markdown: the email body and, until the panel ships, the dashboard card. */
  text: text('text').notNull().default(''),
  /** The same briefing as email HTML. */
  html: text('html').notNull().default(''),
  /** True when the model's phrasing survived grounding; false for the deterministic narrative. */
  ai: boolean('ai').notNull().default(false),
  channels: text('channels').array().notNull().default([]),
  /** How many times the briefing for this day was (re)generated on request; the manual cap counts these. */
  generations: integer('generations').notNull().default(1),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('briefings_user_day_idx').on(t.userId, t.day)]);
