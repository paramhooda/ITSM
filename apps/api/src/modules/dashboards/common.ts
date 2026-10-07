import { sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DOMAINS } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { toDay, addDays, daysBetween, isValidTimezone } from '@/modules/reports/dates';
import { slaPredicates } from '@/modules/sla/predicates';

export { toDay, addDays, daysBetween };

export async function q<T = Record<string, unknown>>(ctx: Ctx, query: SQL): Promise<T[]> {
  const res = await ctx.tx.execute(query);
  return res.rows as T[];
}
export async function one<T = Record<string, unknown>>(ctx: Ctx, query: SQL): Promise<T> {
  return (await q<T>(ctx, query))[0] ?? ({} as T);
}

export const EMPTY = sql``;
export const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
/** Timestamps in raw `execute` rows arrive as pg text ('2026-10-02 17:58:28.119+00'); normalise to a Date (or null). */
export const asDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')));
export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
export const isCustomerUser = (ctx: Ctx) => ctx.user.userType === 'customer';

export const OPEN_STATUS = sql`(SELECT id FROM config_options WHERE type = 'ticket_status' AND status_category IN ('new', 'open', 'pending'))`;
export const openCond = (col: SQL = sql`t.status_id`) => sql`${col} IN ${OPEN_STATUS}`;
export const custCond = (customerId: string | null | undefined, col: SQL = sql`t.customer_id`) => (customerId ? sql`AND ${col} = ${customerId}::uuid` : EMPTY);
export const socCond = (ctx: Ctx, col: SQL = sql`t.domain`) => (!isCustomerUser(ctx) && !ctx.can('soc:read') ? sql`AND ${col} <> 'soc'` : EMPTY);
/** The SLA vocabulary over a ticket row aliased `t`: the same predicates the ticket list filters on (`modules/sla/predicates`). */
const SLA = slaPredicates(sql`t.id`);
export const BREACHED = SLA.breached;
export const AT_RISK = SLA.atRisk;
export const AGE_BUCKET = sql`CASE WHEN now() - t.created_at < interval '4 hours' THEN '< 4h' WHEN now() - t.created_at < interval '24 hours' THEN '4-24h' WHEN now() - t.created_at < interval '3 days' THEN '1-3d' ELSE '> 3d' END`;

/** Compact ticket columns used by dashboard lists. */
export const TICKET_LIST_COLS = sql`t.id, t.number, t.type, t.title, t.customer_id, cu.name AS customer_name, pr.label AS priority, pr.color AS priority_color, pr.level AS priority_level,
  st.label AS status, st.color AS status_color, st.status_category, cat.label AS category, t.assignee_id, asg.name AS assignee, tm.name AS team, t.created_at, t.updated_at, t.resolved_at, t.last_activity_at, t.escalation_level, t.is_major, t.scope_status`;
/** The staff lists add the breach forecast and the customer's last mood (never sent to portal users). */
export const TICKET_LIST_COLS_STAFF = sql`${TICKET_LIST_COLS}, t.breach_risk, t.last_sentiment`;
export const TICKET_LIST_JOINS = sql`LEFT JOIN customers cu ON cu.id = t.customer_id LEFT JOIN config_options pr ON pr.id = t.priority_id LEFT JOIN config_options st ON st.id = t.status_id LEFT JOIN config_options cat ON cat.id = t.category_id LEFT JOIN users asg ON asg.id = t.assignee_id LEFT JOIN teams tm ON tm.id = t.assigned_team_id`;

// ---------------------------------------------------------------- daily metric series (rollups + live)

export const METRIC_KEYS = ['opened', 'incidentsOpened', 'requestsOpened', 'securityOpened', 'resolved', 'closed', 'outOfScope', 'major', 'mttrMinutes', 'firstResponseMinutes', 'slaMet', 'slaBreached', 'resolutionMet', 'resolutionBreached', 'responseMet', 'responseBreached', 'visitsCompleted', 'visitMinutes', 'pmCompleted', 'pmMissed', 'engineeringMinutes'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export type DayMetrics = { day: string } & Record<MetricKey, number | null>;

const SUM_KEYS: MetricKey[] = ['opened', 'incidentsOpened', 'requestsOpened', 'securityOpened', 'resolved', 'closed', 'outOfScope', 'major', 'slaMet', 'slaBreached', 'resolutionMet', 'resolutionBreached', 'responseMet', 'responseBreached', 'visitsCompleted', 'visitMinutes', 'pmCompleted', 'pmMissed', 'engineeringMinutes'];

/** Pre-aggregated history from metric_rollups_daily (per day, summed across visible customers). */
async function rollupDays(ctx: Ctx, from: string, to: string, customerId?: string | null): Promise<DayMetrics[]> {
  const sums = sql.join(SUM_KEYS.map((k) => sql`coalesce(sum((metrics->>${k})::numeric), 0)::float AS ${sql.raw(`"${k}"`)}`), sql`, `);
  const rows = await q<DayMetrics>(ctx, sql`
    SELECT day::text AS day, ${sums},
      CASE WHEN sum((metrics->>'resolved')::numeric) FILTER (WHERE metrics ? 'mttrMinutes') > 0 THEN round((sum((metrics->>'mttrMinutes')::numeric * (metrics->>'resolved')::numeric) / sum((metrics->>'resolved')::numeric) FILTER (WHERE metrics ? 'mttrMinutes'))::numeric, 1)::float END AS "mttrMinutes",
      CASE WHEN sum((metrics->>'opened')::numeric) FILTER (WHERE metrics ? 'firstResponseMinutes') > 0 THEN round((sum((metrics->>'firstResponseMinutes')::numeric * (metrics->>'opened')::numeric) / sum((metrics->>'opened')::numeric) FILTER (WHERE metrics ? 'firstResponseMinutes'))::numeric, 1)::float END AS "firstResponseMinutes"
    FROM metric_rollups_daily WHERE day >= ${from}::date AND day <= ${to}::date ${customerId ? sql`AND customer_id = ${customerId}::uuid` : EMPTY}
    GROUP BY day ORDER BY day`);
  return rows;
}

/** Live per-day metrics computed from source tables (used for short ranges and "today"). */
export async function liveDays(ctx: Ctx, from: string, to: string, customerId?: string | null): Promise<DayMetrics[]> {
  const c = (col: SQL) => (customerId ? sql`AND ${col} = ${customerId}::uuid` : EMPTY);
  const win = (col: SQL) => sql`${col} >= ${from}::date AND ${col} < ${to}::date + interval '1 day'`;
  return q<DayMetrics>(ctx, sql`
    WITH d AS (SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day),
    o AS (SELECT created_at::date AS day, count(*)::int AS opened, count(*) FILTER (WHERE type = 'incident')::int AS incidents, count(*) FILTER (WHERE type = 'request')::int AS requests, count(*) FILTER (WHERE domain = 'soc')::int AS security,
          count(*) FILTER (WHERE scope_status = 'out_of_scope')::int AS out_of_scope, count(*) FILTER (WHERE is_major)::int AS major FROM tickets WHERE ${win(sql`created_at`)} ${c(sql`customer_id`)} GROUP BY 1),
    r AS (SELECT resolved_at::date AS day, count(*)::int AS resolved, round((avg(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60))::numeric, 1)::float AS mttr FROM tickets WHERE ${win(sql`resolved_at`)} ${c(sql`customer_id`)} GROUP BY 1),
    cl AS (SELECT closed_at::date AS day, count(*)::int AS closed FROM tickets WHERE ${win(sql`closed_at`)} ${c(sql`customer_id`)} GROUP BY 1),
    fr AS (SELECT first_response_at::date AS day, round((avg(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60))::numeric, 1)::float AS frm FROM tickets WHERE ${win(sql`first_response_at`)} ${c(sql`customer_id`)} GROUP BY 1),
    sm AS (SELECT completed_at::date AS day, count(*)::int AS sla_met, count(*) FILTER (WHERE metric = 'resolution')::int AS res_met, count(*) FILTER (WHERE metric = 'response')::int AS resp_met FROM ticket_slas WHERE state = 'met' AND ${win(sql`completed_at`)} ${c(sql`customer_id`)} GROUP BY 1),
    sb AS (SELECT breached_at::date AS day, count(*)::int AS sla_breached, count(*) FILTER (WHERE metric = 'resolution')::int AS res_breached, count(*) FILTER (WHERE metric = 'response')::int AS resp_breached FROM ticket_slas WHERE state = 'breached' AND ${win(sql`breached_at`)} ${c(sql`customer_id`)} GROUP BY 1),
    v AS (SELECT actual_end::date AS day, count(*)::int AS visits, coalesce(sum(work_minutes), 0)::int AS visit_minutes FROM field_visits WHERE status = 'completed' AND ${win(sql`actual_end`)} ${c(sql`customer_id`)} GROUP BY 1),
    pc AS (SELECT completed_at::date AS day, count(*)::int AS pm_completed FROM pm_occurrences WHERE status = 'completed' AND ${win(sql`completed_at`)} ${c(sql`customer_id`)} GROUP BY 1),
    pm AS (SELECT updated_at::date AS day, count(*)::int AS pm_missed FROM pm_occurrences WHERE status = 'missed' AND ${win(sql`updated_at`)} ${c(sql`customer_id`)} GROUP BY 1),
    e AS (SELECT created_at::date AS day, coalesce(sum(minutes), 0)::int AS eng FROM time_entries WHERE ${win(sql`created_at`)} ${c(sql`customer_id`)} GROUP BY 1)
    SELECT d.day::text AS day, coalesce(o.opened, 0) AS "opened", coalesce(o.incidents, 0) AS "incidentsOpened", coalesce(o.requests, 0) AS "requestsOpened", coalesce(o.security, 0) AS "securityOpened",
      coalesce(r.resolved, 0) AS "resolved", coalesce(cl.closed, 0) AS "closed", coalesce(o.out_of_scope, 0) AS "outOfScope", coalesce(o.major, 0) AS "major", r.mttr AS "mttrMinutes", fr.frm AS "firstResponseMinutes",
      coalesce(sm.sla_met, 0) AS "slaMet", coalesce(sb.sla_breached, 0) AS "slaBreached", coalesce(sm.res_met, 0) AS "resolutionMet", coalesce(sb.res_breached, 0) AS "resolutionBreached", coalesce(sm.resp_met, 0) AS "responseMet", coalesce(sb.resp_breached, 0) AS "responseBreached",
      coalesce(v.visits, 0) AS "visitsCompleted", coalesce(v.visit_minutes, 0) AS "visitMinutes", coalesce(pc.pm_completed, 0) AS "pmCompleted", coalesce(pm.pm_missed, 0) AS "pmMissed", coalesce(e.eng, 0) AS "engineeringMinutes"
    FROM d LEFT JOIN o ON o.day = d.day LEFT JOIN r ON r.day = d.day LEFT JOIN cl ON cl.day = d.day LEFT JOIN fr ON fr.day = d.day LEFT JOIN sm ON sm.day = d.day LEFT JOIN sb ON sb.day = d.day
      LEFT JOIN v ON v.day = d.day LEFT JOIN pc ON pc.day = d.day LEFT JOIN pm ON pm.day = d.day LEFT JOIN e ON e.day = d.day
    ORDER BY d.day`);
}

const emptyDay = (day: string): DayMetrics => ({ day, ...(Object.fromEntries(METRIC_KEYS.map((k) => [k, k === 'mttrMinutes' || k === 'firstResponseMinutes' ? null : 0])) as Record<MetricKey, number | null>) });

/**
 * Daily series for [from, to]: live for short ranges (<= 7 days), otherwise
 * rollups for history plus a live computation for today. Falls back to live
 * when no rollups exist yet (fresh installs). Every day in the range is present.
 */
export async function dailySeries(ctx: Ctx, from: string, to: string, customerId?: string | null): Promise<DayMetrics[]> {
  const today = toDay(new Date());
  const length = daysBetween(from, to) + 1;
  let rows: DayMetrics[] = [];
  if (length <= 7) rows = await liveDays(ctx, from, to, customerId);
  else {
    const histTo = to < today ? to : addDays(today, -1);
    const hist = histTo >= from ? await rollupDays(ctx, from, histTo, customerId) : [];
    if (!hist.length && length <= 400) rows = await liveDays(ctx, from, to, customerId);
    else {
      rows = hist;
      if (to >= today && from <= today) rows = [...hist, ...(await liveDays(ctx, today, today, customerId))];
    }
  }
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: DayMetrics[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(byDay.get(d) ?? emptyDay(d));
  return out;
}

export const sumOf = (s: DayMetrics[], k: MetricKey) => s.reduce((a, r) => a + num(r[k]), 0);
/** Weighted mean of a per-day average (`k`) by a per-day count (`w`). */
export function weightedOf(s: DayMetrics[], k: MetricKey, w: MetricKey) {
  const den = s.reduce((a, r) => a + (r[k] === null || r[k] === undefined ? 0 : num(r[w])), 0);
  return den ? Math.round((s.reduce((a, r) => a + (r[k] === null || r[k] === undefined ? 0 : num(r[k]) * num(r[w])), 0) / den) * 10) / 10 : null;
}
export const delta = (current: number | null, previous: number | null) => ({ current, previous, deltaPct: current !== null && previous !== null && previous !== 0 ? Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10 : null });

// ---------------------------------------------------------------- ticket flow for one slice (domain, assignee)

export interface FlowDay { day: string; opened: number; resolved: number; breaches: number }

/**
 * Daily opened / resolved / SLA-breached counts for the tickets matching `cond`
 * (an `AND …` fragment over the alias `t`), computed live from the source tables.
 * Every day in [from, to] is present. Used where a dashboard needs a slice that
 * `dailySeries` (per customer only) cannot express: a domain or an assignee.
 */
export async function ticketFlowSeries(ctx: Ctx, from: string, to: string, cond: SQL = EMPTY): Promise<FlowDay[]> {
  const win = (col: SQL) => sql`${col} >= ${from}::date AND ${col} < ${to}::date + interval '1 day'`;
  const rows = await q<FlowDay>(ctx, sql`
    WITH d AS (SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day),
    o AS (SELECT t.created_at::date AS day, count(*)::int AS opened FROM tickets t WHERE ${win(sql`t.created_at`)} ${cond} GROUP BY 1),
    r AS (SELECT t.resolved_at::date AS day, count(*)::int AS resolved FROM tickets t WHERE ${win(sql`t.resolved_at`)} ${cond} GROUP BY 1),
    b AS (SELECT s.breached_at::date AS day, count(*)::int AS breaches FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id WHERE s.state = 'breached' AND ${win(sql`s.breached_at`)} ${cond} GROUP BY 1)
    SELECT d.day::text AS day, coalesce(o.opened, 0) AS opened, coalesce(r.resolved, 0) AS resolved, coalesce(b.breaches, 0) AS breaches
    FROM d LEFT JOIN o ON o.day = d.day LEFT JOIN r ON r.day = d.day LEFT JOIN b ON b.day = d.day ORDER BY d.day`);
  return rows.map((r) => ({ day: String(r.day), opened: num(r.opened), resolved: num(r.resolved), breaches: num(r.breaches) }));
}

// ---------------------------------------------------------------- scope fragments shared by the overview and the dedicated dashboards

/** Every domain but security: what the NOC dashboard counts and what staff without `soc:read` see. */
export const NOT_SOC_DOMAINS: string[] = DOMAINS.filter((d) => d !== 'soc');
/** `AND t.assigned_team_id = …` for a team filter (the NOC dashboard's hero control). */
export const teamCond = (teamId: string | null | undefined, col: SQL = sql`t.assigned_team_id`) => (teamId ? sql`AND ${col} = ${teamId}::uuid` : EMPTY);

// ---------------------------------------------------------------- arrivals by day and hour with exact drill-down windows

export interface ArrivalCell {
  /** The local day (YYYY-MM-DD in `timezone`). */
  day: string;
  /** Weekday label of that day (Mon … Sun). */
  row: string;
  /** Hour of day, two digits. */
  col: string;
  value: number;
  /** The exact created window of the cell (inclusive timestamps): the ticket list's `createdFrom`/`createdTo`. */
  createdFrom: string;
  createdTo: string;
}

export interface ArrivalsWeek {
  timezone: string;
  from: string;
  to: string;
  cells: ArrivalCell[];
}

const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Ticket arrivals per local day and hour over at most seven days ending `to`,
 * in `timezone`. Each cell is counted over its own exact window (the hour's
 * first instant to its last millisecond), the very predicates the ticket list
 * applies to a `createdFrom`/`createdTo` pair, so a cell drills down to the
 * tickets it counted. The day is walked in wall-clock hours, so on a
 * daylight-saving change the skipped hour has no cell and the repeated hour's
 * cell spans both passes: every instant of the day lands in exactly one cell
 * and the cells add up to the whole window. `cond` is an `AND …` fragment
 * over the alias `t` (customer scope, security fence, domain, team). Every
 * hour the day has is present, zeros included.
 */
export async function arrivalsWeek(ctx: Ctx, cond: SQL, opts: { from: string; to: string; timezone: string }): Promise<ArrivalsWeek> {
  const tz = isValidTimezone(opts.timezone) ? opts.timezone : 'UTC';
  const from = daysBetween(opts.from, opts.to) >= 7 ? addDays(opts.to, -6) : opts.from;
  const windows: { day: string; hour: number; s: Date; e: Date }[] = [];
  for (let d = from; d <= opts.to; d = addDays(d, 1)) {
    const midnight = DateTime.fromISO(d, { zone: tz }).startOf('day');
    const nextMidnight = midnight.plus({ days: 1 }).startOf('day');
    for (let s = midnight; s < nextMidnight; ) {
      const e = DateTime.min(s.plus({ hours: 1 }), nextMidnight);
      const prev = windows[windows.length - 1];
      if (prev && prev.day === d && prev.hour === s.hour) prev.e = new Date(e.toMillis() - 1);
      else windows.push({ day: d, hour: s.hour, s: s.toJSDate(), e: new Date(e.toMillis() - 1) });
      s = e;
    }
  }
  const first = windows[0]!.s;
  const last = windows[windows.length - 1]!.e;
  const values = sql.join(windows.map((w, i) => sql`(${i}::int, ${w.s}::timestamptz, ${w.e}::timestamptz)`), sql`, `);
  const counts = await q<{ i: number; n: number }>(ctx, sql`
    WITH w(i, s, e) AS (VALUES ${values}),
    x AS (SELECT t.created_at FROM tickets t WHERE t.created_at >= ${first} AND t.created_at <= ${last} ${cond})
    SELECT w.i, count(x.created_at)::int AS n FROM w LEFT JOIN x ON x.created_at >= w.s AND x.created_at <= w.e GROUP BY w.i`);
  const byIndex = new Map(counts.map((r) => [num(r.i), num(r.n)]));
  return {
    timezone: tz,
    from,
    to: opts.to,
    cells: windows.map((w, i) => ({ day: w.day, row: WEEKDAY[(DateTime.fromISO(w.day, { zone: tz }).weekday + 6) % 7]!, col: String(w.hour).padStart(2, '0'), value: byIndex.get(i) ?? 0, createdFrom: w.s.toISOString(), createdTo: w.e.toISOString() })),
  };
}

// ---------------------------------------------------------------- daily flow with the incident share (NOC)

export interface DomainFlowDay extends FlowDay { incidents: number }

/** `ticketFlowSeries` plus the incidents opened per day, for the NOC chart; live and fenced like the tiles. */
export async function domainFlowSeries(ctx: Ctx, from: string, to: string, cond: SQL = EMPTY): Promise<DomainFlowDay[]> {
  const win = (col: SQL) => sql`${col} >= ${from}::date AND ${col} < ${to}::date + interval '1 day'`;
  const rows = await q<DomainFlowDay>(ctx, sql`
    WITH d AS (SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day),
    o AS (SELECT t.created_at::date AS day, count(*)::int AS opened, count(*) FILTER (WHERE t.type = 'incident')::int AS incidents FROM tickets t WHERE ${win(sql`t.created_at`)} ${cond} GROUP BY 1),
    r AS (SELECT t.resolved_at::date AS day, count(*)::int AS resolved FROM tickets t WHERE ${win(sql`t.resolved_at`)} ${cond} GROUP BY 1),
    b AS (SELECT s.breached_at::date AS day, count(*)::int AS breaches FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id WHERE s.state = 'breached' AND ${win(sql`s.breached_at`)} ${cond} GROUP BY 1)
    SELECT d.day::text AS day, coalesce(o.opened, 0) AS opened, coalesce(o.incidents, 0) AS incidents, coalesce(r.resolved, 0) AS resolved, coalesce(b.breaches, 0) AS breaches
    FROM d LEFT JOIN o ON o.day = d.day LEFT JOIN r ON r.day = d.day LEFT JOIN b ON b.day = d.day ORDER BY d.day`);
  return rows.map((r) => ({ day: String(r.day), opened: num(r.opened), incidents: num(r.incidents), resolved: num(r.resolved), breaches: num(r.breaches) }));
}

// ---------------------------------------------------------------- customers needing attention (management and the overview)

export interface AttentionRow {
  id: string;
  name: string;
  code: string;
  tickets: number;
  resolved: number;
  out_of_scope: number;
  major: number;
  slaMet: number;
  slaBreached: number;
  compliancePct: number | null;
}

/**
 * The customers with the most tickets opened in the period, with their
 * resolved, out-of-scope and major counts and their resolution-SLA compliance
 * on those tickets: the "needs attention" list of the management dashboard and
 * of the overview's management section (one query, so both show the same rows).
 */
export async function attentionByCustomer(ctx: Ctx, opts: { from: string; to: string; customerId: string | null; limit?: number }): Promise<AttentionRow[]> {
  const range = sql`t.created_at >= ${opts.from}::date AND t.created_at < ${opts.to}::date + interval '1 day'`;
  const soc = socCond(ctx);
  const top = await q<Record<string, unknown>>(ctx, sql`
    SELECT cu.id, cu.name, cu.code, count(*)::int AS tickets, count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved, count(*) FILTER (WHERE t.scope_status = 'out_of_scope')::int AS out_of_scope, count(*) FILTER (WHERE t.is_major)::int AS major
    FROM tickets t JOIN customers cu ON cu.id = t.customer_id WHERE ${range} ${custCond(opts.customerId)} ${soc} GROUP BY cu.id, cu.name, cu.code ORDER BY tickets DESC LIMIT ${opts.limit ?? 10}`);
  const ids = top.map((c) => String(c.id));
  const sla = ids.length
    ? await q<Record<string, unknown>>(ctx, sql`
      SELECT s.customer_id, count(*) FILTER (WHERE s.state = 'met')::int AS met, count(*) FILTER (WHERE s.state = 'breached')::int AS breached
      FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id WHERE s.metric = 'resolution' AND s.customer_id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]) AND ${range} ${soc} GROUP BY s.customer_id`)
    : [];
  const slaMap = new Map(sla.map((r) => [String(r.customer_id), r]));
  return top.map((c) => {
    const s = slaMap.get(String(c.id));
    return { id: String(c.id), name: String(c.name), code: String(c.code), tickets: num(c.tickets), resolved: num(c.resolved), out_of_scope: num(c.out_of_scope), major: num(c.major), slaMet: num(s?.met), slaBreached: num(s?.breached), compliancePct: pct(num(s?.met), num(s?.met) + num(s?.breached)) };
  });
}

/** Period selector shared by every dashboard: 7, 30 or 90 days from the UI, anything sane from the API. */
export const clampDays = (d?: number | null) => Math.min(365, Math.max(1, Math.round(d ?? 30)));

/** Active customers and contracts (active, expiring within 90 days, expired in the last 30) in the scope: the management figures. */
export async function accountCounts(ctx: Ctx, customerId: string | null) {
  const counts = await one<Record<string, unknown>>(ctx, sql`
    SELECT (SELECT count(*)::int FROM customers c WHERE c.is_active ${custCond(customerId, sql`c.id`)}) AS customers_active,
      (SELECT count(*)::int FROM contracts c WHERE c.status IN ('active', 'expiring') ${custCond(customerId, sql`c.customer_id`)}) AS contracts_active,
      (SELECT count(*)::int FROM contracts c WHERE c.status IN ('active', 'expiring') AND c.end_date >= current_date AND c.end_date <= current_date + 90 ${custCond(customerId, sql`c.customer_id`)}) AS contracts_expiring_90d,
      (SELECT count(*)::int FROM contracts c WHERE c.status = 'expired' AND c.end_date >= current_date - 30 ${custCond(customerId, sql`c.customer_id`)}) AS contracts_expired_30d`);
  return { customersActive: num(counts.customers_active), contractsActive: num(counts.contracts_active), contractsExpiring90d: num(counts.contracts_expiring_90d), contractsExpired30d: num(counts.contracts_expired_30d) };
}
