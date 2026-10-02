import { customType, timestamp, uuid, pgEnum } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const id = () => uuid('id').primaryKey().defaultRandom();

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};

export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const ticketTypeEnum = pgEnum('ticket_type', ['incident', 'request', 'problem', 'change']);
export const statusCategoryEnum = pgEnum('status_category', ['new', 'open', 'pending', 'resolved', 'closed', 'cancelled']);
export const scopeStatusEnum = pgEnum('scope_status', ['in_scope', 'out_of_scope', 'unknown']);
export const slaMetricEnum = pgEnum('sla_metric', ['acknowledgement', 'response', 'restoration', 'resolution']);
export const slaStateEnum = pgEnum('sla_state', ['running', 'paused', 'met', 'breached', 'cancelled']);
export const userTypeEnum = pgEnum('user_type', ['msp', 'customer']);
export const userStatusEnum = pgEnum('user_status', ['active', 'invited', 'disabled', 'locked']);
export const domainEnum = pgEnum('domain', ['general', 'noc', 'soc', 'amc', 'service_desk']);

/** Helper for text search expressions. */
export const searchExpr = (...cols: string[]) =>
  sql.raw(`to_tsvector('simple', ${cols.map((c) => `coalesce(${c}, '')`).join(" || ' ' || ")})`);
