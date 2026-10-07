import { sql, type SQL } from 'drizzle-orm';

/**
 * The one SLA vocabulary every count shares: the ticket list, its tiles and
 * groupings, the task boards, the dashboards, the customer overview and the
 * reports all spell "breached", "at risk" and "on track" through this helper,
 * so a number on a dashboard reproduces itself on the list it opens.
 *
 * - breached: the engine has flagged a clock (`ticket_slas.state = 'breached'`).
 *   The sweep runs every minute, so a clock past its due time reads as
 *   breached within a minute; nobody re-derives it from `due_at` any more.
 * - at risk: a running clock the engine has warned about (`warned_at` set) and
 *   nothing breached yet on the ticket.
 * - ok (on track): neither of the above.
 *
 * `ticketId` is the column the predicate correlates on: `tickets.id` in
 * drizzle query-builder code, `t.id` in raw SQL aliased `t`.
 */
export const SLA_STATES = ['breached', 'at_risk', 'ok'] as const;
export type SlaStateKey = (typeof SLA_STATES)[number];

export interface SlaPredicates {
  breached: SQL;
  atRisk: SQL;
  ok: SQL;
}

export function slaPredicates(ticketId: SQL): SlaPredicates {
  const breached = sql`EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = ${ticketId} AND s.state = 'breached')`;
  const warned = sql`EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = ${ticketId} AND s.state = 'running' AND s.warned_at IS NOT NULL)`;
  return {
    breached,
    atRisk: sql`(${warned} AND NOT ${breached})`,
    ok: sql`(NOT ${breached} AND NOT ${warned})`,
  };
}

export const isSlaState = (v: string): v is SlaStateKey => (SLA_STATES as readonly string[]).includes(v);

/** `OR` of the predicates for a set of states (a list filter such as `slaState=breached,at_risk`); undefined when no valid state is named. */
export function slaStateCond(p: SlaPredicates, states: readonly string[]): SQL | undefined {
  const parts = states.filter(isSlaState).map((s) => (s === 'breached' ? p.breached : s === 'at_risk' ? p.atRisk : p.ok));
  if (!parts.length) return undefined;
  if (parts.length === 1) return parts[0];
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * The worst state of a ticket's clocks as one label (for report columns):
 * 'breached', 'at_risk', 'ok' (a running or paused clock, nothing breached or
 * warned) or NULL when the ticket has no clock.
 */
export const worstSlaStateSql = (ticketId: SQL, alias: SQL = sql`s`): SQL =>
  sql`(SELECT CASE WHEN bool_or(${alias}.state = 'breached') THEN 'breached' WHEN bool_or(${alias}.state = 'running' AND ${alias}.warned_at IS NOT NULL) THEN 'at_risk' WHEN bool_or(${alias}.state IN ('running','paused')) THEN 'ok' ELSE NULL END FROM ticket_slas ${alias} WHERE ${alias}.ticket_id = ${ticketId})`;
