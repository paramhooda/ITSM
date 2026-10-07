import { sql } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { q, one, num, openCond, custCond, teamCond, BREACHED, AT_RISK } from './common';

/**
 * The tile numbers of the three operations dashboards, each computed by one
 * function the dedicated dashboard and the overview's strip both call, so a
 * strip number on the overview is the same number as the tile on the
 * dashboard it links to. Every count is live, under the customer scope and,
 * for the NOC, the team filter; "breached" and "at risk" are the shared SLA
 * vocabulary (`modules/sla/predicates`). The security fence does not apply
 * here on purpose: the NOC counts every domain but security and the SOC is
 * only reachable with `soc:read` (the callers check).
 */

type Row = Record<string, unknown>;

export interface OperationsScope {
  customerId: string | null;
  /** NOC only: tickets assigned to one team. */
  teamId?: string | null;
}

export interface NocTotals {
  open: number;
  openIncidents: number;
  breached: number;
  atRisk: number;
  unassigned: number;
  major: number;
  escalated: number;
  openedToday: number;
  highRisk: number;
  mediumRisk: number;
  unhappy: number;
  resolvedToday: number;
  mttrTodayMinutes: number | null;
  knownErrorsOpen: number;
}

/** The NOC's `t`-aliased scope: every domain but security, the customer and the team. */
export const nocScope = (s: OperationsScope) => sql`t.domain <> 'soc' ${custCond(s.customerId)} ${teamCond(s.teamId)}`;

export async function nocTotals(ctx: Ctx, s: OperationsScope): Promise<NocTotals> {
  const scope = nocScope(s);
  const totals = await one<Row>(ctx, sql`
    SELECT count(*)::int AS open, count(*) FILTER (WHERE t.type = 'incident')::int AS open_incidents, count(*) FILTER (WHERE ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk,
      count(*) FILTER (WHERE t.assignee_id IS NULL)::int AS unassigned, count(*) FILTER (WHERE t.is_major)::int AS major, count(*) FILTER (WHERE t.escalation_level > 0)::int AS escalated,
      count(*) FILTER (WHERE t.breach_risk = 'high')::int AS high_risk, count(*) FILTER (WHERE t.breach_risk = 'medium')::int AS medium_risk,
      count(*) FILTER (WHERE t.last_sentiment IN ('negative', 'angry'))::int AS unhappy
    FROM tickets t WHERE ${scope} AND ${openCond()}`);
  // "Opened today" counts every ticket raised today, resolved or not (the list it opens carries only the created range).
  const openedToday = await one<Row>(ctx, sql`SELECT count(*)::int AS n FROM tickets t WHERE ${scope} AND t.created_at >= current_date`);
  const resolvedToday = await one<Row>(ctx, sql`SELECT count(*)::int AS n, round((avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60))::numeric)::int AS mttr FROM tickets t WHERE ${scope} AND t.resolved_at >= current_date`);
  const knownErrors = await one<Row>(ctx, sql`SELECT count(*)::int AS n FROM problem_details pd JOIN tickets t ON t.id = pd.ticket_id WHERE pd.is_known_error AND coalesce(pd.ke_status, 'open') IN ('open', 'fix_in_progress') AND ${scope}`);
  return {
    open: num(totals.open),
    openIncidents: num(totals.open_incidents),
    breached: num(totals.breached),
    atRisk: num(totals.at_risk),
    unassigned: num(totals.unassigned),
    major: num(totals.major),
    escalated: num(totals.escalated),
    openedToday: num(openedToday.n),
    highRisk: num(totals.high_risk),
    mediumRisk: num(totals.medium_risk),
    unhappy: num(totals.unhappy),
    resolvedToday: num(resolvedToday.n),
    mttrTodayMinutes: resolvedToday.mttr === null || resolvedToday.mttr === undefined ? null : num(resolvedToday.mttr),
    knownErrorsOpen: num(knownErrors.n),
  };
}

export interface SocTotals {
  open: number;
  breached: number;
  atRisk: number;
  escalated: number;
  unassigned: number;
  openedToday: number;
  criticalHigh: number;
  /** The severity options the "critical / high" tile counts (level 1 and 2), so the tile links with exactly these ids. */
  criticalHighSeverityIds: string[];
}

/** The SOC's `t`-aliased scope: the security domain and the customer. */
export const socScope = (s: OperationsScope) => sql`t.domain = 'soc' ${custCond(s.customerId)}`;

export async function socTotals(ctx: Ctx, s: OperationsScope): Promise<SocTotals> {
  const scope = socScope(s);
  const totals = await one<Row>(ctx, sql`
    SELECT count(*)::int AS open, count(*) FILTER (WHERE ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk, count(*) FILTER (WHERE t.escalation_level > 0)::int AS escalated,
      count(*) FILTER (WHERE t.assignee_id IS NULL)::int AS unassigned, count(*) FILTER (WHERE sev.level <= 2)::int AS critical_high
    FROM tickets t LEFT JOIN config_options sev ON sev.id = t.security_severity_id WHERE ${scope} AND ${openCond()}`);
  const openedToday = await one<Row>(ctx, sql`SELECT count(*)::int AS n FROM tickets t WHERE ${scope} AND t.created_at >= current_date`);
  const severe = await q<{ id: string }>(ctx, sql`SELECT id FROM config_options WHERE type = 'security_severity' AND level <= 2 ORDER BY level, sort_order`);
  return {
    open: num(totals.open),
    breached: num(totals.breached),
    atRisk: num(totals.at_risk),
    escalated: num(totals.escalated),
    unassigned: num(totals.unassigned),
    openedToday: num(openedToday.n),
    criticalHigh: num(totals.critical_high),
    criticalHighSeverityIds: severe.map((r) => String(r.id)),
  };
}

export interface AmcTotals {
  open: number;
  unassigned: number;
  breached: number;
  atRisk: number;
  dueToday: number;
  awaitingCustomer: number;
  openedToday: number;
  resolvedThisWeek: number;
  resolvedToday: number;
  visitsThisWeek: number;
}

/** The AMC dashboard's `t`-aliased scope: the AMC domain and the customer. */
export const amcScope = (s: OperationsScope) => sql`t.domain = 'amc' ${custCond(s.customerId)}`;

export async function amcTotals(ctx: Ctx, s: OperationsScope): Promise<AmcTotals> {
  const scope = amcScope(s);
  const totals = await one<Row>(ctx, sql`
    SELECT count(*)::int AS open, count(*) FILTER (WHERE t.assignee_id IS NULL)::int AS unassigned, count(*) FILTER (WHERE ${BREACHED})::int AS breached,
      count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk, count(*) FILTER (WHERE t.due_at >= current_date AND t.due_at < current_date + 1)::int AS due_today,
      count(*) FILTER (WHERE st.key = 'pending_customer')::int AS awaiting_customer
    FROM tickets t JOIN config_options st ON st.id = t.status_id WHERE ${scope} AND ${openCond()}`);
  const openedToday = await one<Row>(ctx, sql`SELECT count(*)::int AS n FROM tickets t WHERE ${scope} AND t.created_at >= current_date`);
  const resolved = await one<Row>(ctx, sql`SELECT count(*) FILTER (WHERE t.resolved_at >= date_trunc('week', now()))::int AS week, count(*) FILTER (WHERE t.resolved_at >= current_date)::int AS today FROM tickets t WHERE ${scope} AND t.resolved_at IS NOT NULL AND t.resolved_at >= date_trunc('week', now())`);
  const visitsWeek = await one<Row>(ctx, sql`
    SELECT count(*)::int AS n FROM field_visits v WHERE v.status IN ('scheduled', 'in_progress') ${custCond(s.customerId, sql`v.customer_id`)} AND v.scheduled_start >= date_trunc('week', now()) AND v.scheduled_start < date_trunc('week', now()) + interval '7 days'`);
  return {
    open: num(totals.open),
    unassigned: num(totals.unassigned),
    breached: num(totals.breached),
    atRisk: num(totals.at_risk),
    dueToday: num(totals.due_today),
    awaitingCustomer: num(totals.awaiting_customer),
    openedToday: num(openedToday.n),
    resolvedThisWeek: num(resolved.week),
    resolvedToday: num(resolved.today),
    visitsThisWeek: num(visitsWeek.n),
  };
}
