import { sql } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { ForbiddenError, ValidationError } from '@/core/errors';
import { slaSummariesFor, worstSla } from '@/modules/sla/engine';
import { slaCompliance } from '@/modules/sla/policies';
import { entitlementSummary, customerEntitlements } from '@/modules/contracts/entitlements';
import { expiringContracts } from '@/modules/contracts/service';
import { parseDay } from '@/modules/reports/dates';
import { onCallSummary } from '@/modules/oncall/service';
import { csatFigures, csatLowest, hidesSoc, pendingSurveyCount, pendingSurveyItems, type CsatFilter } from '@/modules/surveys/figures';
import { loadSurveyDefaults } from '@/modules/surveys/policy';
import { arrivalHeatmap, backlogAgeing } from '@/modules/reports/analytics';
import { q, one, num, pct, isCustomerUser, openCond, custCond, socCond, BREACHED, AT_RISK, AGE_BUCKET, TICKET_LIST_COLS, TICKET_LIST_COLS_STAFF, TICKET_LIST_JOINS, EMPTY, dailySeries, ticketFlowSeries, domainFlowSeries, arrivalsWeek, attentionByCustomer, accountCounts, clampDays, NOT_SOC_DOMAINS, sumOf, weightedOf, delta, toDay, addDays, daysBetween, METRIC_KEYS, type MetricKey } from './common';
import { nocTotals, socTotals, amcTotals, nocScope, socScope, amcScope } from './totals';
import { scopeTimezone } from '@/modules/reports/analytics';

export { overview } from './overview';

type Row = Record<string, unknown>;

/** Attaches the worst SLA (remaining minutes, state) to ticket rows. */
async function withSla<T extends { id: string }>(ctx: Ctx, list: T[]) {
  const map = await slaSummariesFor(ctx.tx, list.map((t) => t.id));
  return list.map((t) => ({ ...t, sla: worstSla(map.get(t.id)) }));
}

/** Who is on call for the teams a dashboard cares about (any team with a rota when none of those types has one). */
async function onCallFor(ctx: Ctx, teamTypes: string[]) {
  if (!ctx.can('oncall:read')) return [];
  const typed = await onCallSummary(ctx.tx, teamTypes);
  return typed.length ? typed : onCallSummary(ctx.tx, null, new Date(), 4);
}

/** The CSAT window and thresholds every dashboard shares (`from`/`to` are YYYY-MM-DD days, inclusive); staff without soc:read never see security tickets' surveys. */
async function csatWindow(ctx: Ctx, from: string, to: string, extra: Partial<CsatFilter> = {}): Promise<CsatFilter> {
  const t = await loadSurveyDefaults(ctx.tx);
  return { from: new Date(`${from}T00:00:00.000Z`), to: new Date(`${to}T23:59:59.999Z`), excludeSoc: hidesSoc(ctx), satisfiedThreshold: t.satisfiedThreshold, lowThreshold: t.lowRatingThreshold, ...extra };
}

// ---------------------------------------------------------------- management

export async function management(ctx: Ctx, opts: { days?: number; customerId?: string | null } = {}) {
  const customerId = opts.customerId ?? null;
  ctx.require('dashboards:management', customerId);
  if (customerId) ctx.requireCustomer(customerId);
  const days = [7, 30, 90].includes(opts.days ?? 30) ? (opts.days ?? 30) : 30;
  const today = toDay(new Date());
  const from = addDays(today, -(days - 1));
  const prevFrom = addDays(from, -days);
  const prevTo = addDays(from, -1);
  const soc = socCond(ctx);
  const range = sql`t.created_at >= ${from}::date AND t.created_at < ${today}::date + interval '1 day'`;

  const series = await dailySeries(ctx, from, today, customerId);
  const previous = await dailySeries(ctx, prevFrom, prevTo, customerId);

  // Every tile that links is counted live here, under the caller's security fence and with the same whole-day window
  // the list applies to a date range, so "Opened" and "Resolved" in the period reproduce on the list whatever the
  // period length; the daily series (rollups beyond seven days, no fence) draws the charts and the deltas only.
  const resolvedRange = sql`t.resolved_at >= ${from}::date AND t.resolved_at < ${today}::date + interval '1 day'`;
  const live = await one<Row>(ctx, sql`
    SELECT count(*) FILTER (WHERE ${openCond()})::int AS open_now, count(*) FILTER (WHERE t.created_at >= ${today}::date)::int AS opened_today, count(*) FILTER (WHERE t.resolved_at >= ${today}::date)::int AS resolved_today,
      count(*) FILTER (WHERE ${range})::int AS opened_period, count(*) FILTER (WHERE ${resolvedRange})::int AS resolved_period,
      count(*) FILTER (WHERE ${openCond()} AND ${BREACHED})::int AS breached_open, count(*) FILTER (WHERE ${openCond()} AND t.assignee_id IS NULL)::int AS unassigned_open, count(*) FILTER (WHERE ${openCond()} AND t.is_major)::int AS major_open
    FROM tickets t WHERE (t.created_at >= ${from}::date OR t.resolved_at >= ${from}::date OR ${openCond()}) ${custCond(customerId)} ${soc}`);
  const counts = await accountCounts(ctx, customerId);
  const pm = await one<Row>(ctx, sql`
    SELECT count(*) FILTER (WHERE o.status = 'completed' AND o.completed_at IS NOT NULL AND o.completed_at::date <= o.planned_date + p.grace_days)::int AS on_time,
      count(*) FILTER (WHERE o.status IN ('completed', 'missed'))::int AS done, count(*) FILTER (WHERE o.status = 'missed')::int AS missed,
      count(*) FILTER (WHERE o.status IN ('planned', 'scheduled') AND o.planned_date < current_date)::int AS overdue
    FROM pm_occurrences o JOIN pm_programs p ON p.id = o.program_id WHERE o.planned_date >= ${from}::date AND o.planned_date <= ${today}::date ${custCond(customerId, sql`o.customer_id`)}`);
  const knownErrors = await one<Row>(ctx, sql`
    SELECT count(*) FILTER (WHERE coalesce(pd.ke_status, 'open') IN ('open', 'fix_in_progress'))::int AS ke_open, count(*) FILTER (WHERE pd.portal_visible)::int AS ke_published
    FROM problem_details pd JOIN tickets t ON t.id = pd.ticket_id WHERE pd.is_known_error ${custCond(customerId)} ${soc}`);

  const byService = await q<Row>(ctx, sql`
    SELECT sv.id, coalesce(sv.name, 'No service') AS name, count(*)::int AS tickets, count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved,
      count(*) FILTER (WHERE ${BREACHED})::int AS breaches, count(*) FILTER (WHERE t.scope_status = 'out_of_scope')::int AS out_of_scope
    FROM tickets t LEFT JOIN services sv ON sv.id = t.service_id WHERE ${range} ${custCond(customerId)} ${soc} GROUP BY sv.id, sv.name ORDER BY tickets DESC LIMIT 10`);
  // The same rows the overview's "needs attention" list shows (one helper, one number).
  const byCustomer = await attentionByCustomer(ctx, { from, to: today, customerId });
  const outOfScopeByCustomer = await q<Row>(ctx, sql`
    SELECT cu.id, cu.name, cu.code, count(*)::int AS out_of_scope, count(*) FILTER (WHERE t.scope_status = 'unknown')::int AS unknown_scope,
      (SELECT coalesce(sum(te.minutes), 0)::int FROM time_entries te WHERE te.ticket_id IN (SELECT t2.id FROM tickets t2 WHERE t2.customer_id = cu.id AND t2.scope_status = 'out_of_scope' AND t2.created_at >= ${from}::date)) AS minutes
    FROM tickets t JOIN customers cu ON cu.id = t.customer_id WHERE t.scope_status IN ('out_of_scope', 'unknown') AND ${range} ${custCond(customerId)} ${soc} GROUP BY cu.id, cu.name, cu.code ORDER BY out_of_scope DESC, unknown_scope DESC LIMIT 10`);

  const canContracts = ctx.can('contracts:read', customerId);
  const ents = canContracts ? await entitlementSummary(ctx, customerId ?? undefined, 1000) : { total: 0, overThreshold: 0, exhausted: 0, items: [] };
  const amcItems = ents.items.filter((i) => i.unit === 'visits' || i.unit === 'hours');
  const amcUtilizationPct = amcItems.length ? Math.round((amcItems.reduce((s, i) => s + Math.min(i.utilization.pct, 150), 0) / amcItems.length) * 10) / 10 : null;
  const entitlementAlerts = ents.items.filter((i) => i.utilization.overThreshold || i.utilization.exhausted).slice(0, 10);
  const expiring = canContracts ? await expiringContracts(ctx, 90, customerId ?? undefined) : { items: [], total: 0, days: 90 };

  const resMet = sumOf(series, 'resolutionMet');
  const resBreached = sumOf(series, 'resolutionBreached');
  const pResMet = sumOf(previous, 'resolutionMet');
  const pResBreached = sumOf(previous, 'resolutionBreached');
  const csatFilter = await csatWindow(ctx, from, today, { customerId });
  const csat = await csatFigures(ctx.tx, csatFilter);
  const csatPrevious = await csatFigures(ctx.tx, { ...csatFilter, from: new Date(`${prevFrom}T00:00:00.000Z`), to: new Date(`${prevTo}T23:59:59.999Z`) });
  const csatLowestRows = await csatLowest(ctx.tx, csatFilter, 5);
  const kpis = {
    ...counts,
    ticketsOpened: num(live.opened_period),
    ticketsResolved: num(live.resolved_period),
    ticketsClosed: sumOf(series, 'closed'),
    openNow: num(live.open_now),
    openedToday: num(live.opened_today),
    resolvedToday: num(live.resolved_today),
    breachedOpen: num(live.breached_open),
    unassignedOpen: num(live.unassigned_open),
    majorOpen: num(live.major_open),
    slaCompliancePct: pct(resMet, resMet + resBreached),
    resolutionMet: resMet,
    resolutionBreached: resBreached,
    slaBreaches: sumOf(series, 'slaBreached'),
    mttrMinutes: weightedOf(series, 'mttrMinutes', 'resolved'),
    firstResponseMinutes: weightedOf(series, 'firstResponseMinutes', 'opened'),
    outOfScopeCount: sumOf(series, 'outOfScope'),
    majorIncidents: sumOf(series, 'major'),
    amcUtilizationPct,
    entitlementsOverThreshold: ents.overThreshold,
    entitlementsExhausted: ents.exhausted,
    pmOnTimePct: pct(num(pm.on_time), num(pm.done)),
    pmMissed: num(pm.missed),
    pmOverdue: num(pm.overdue),
    visitsCompleted: sumOf(series, 'visitsCompleted'),
    engineeringHours: Math.round(sumOf(series, 'engineeringMinutes') / 6) / 10,
    knownErrorsOpen: num(knownErrors.ke_open),
    knownErrorsPublished: num(knownErrors.ke_published),
    csatAvg: csat.avg,
    csatSatisfiedPct: csat.satisfiedPct,
    csatResponseRate: csat.responseRate,
  };
  return {
    period: { days, from, to: today, previousFrom: prevFrom, previousTo: prevTo },
    customerId,
    kpis,
    series: series.map((d) => ({ day: d.day, opened: num(d.opened), resolved: num(d.resolved), closed: num(d.closed), breaches: num(d.slaBreached), outOfScope: num(d.outOfScope), mttrMinutes: d.mttrMinutes, resolutionMet: num(d.resolutionMet), resolutionBreached: num(d.resolutionBreached), compliancePct: pct(num(d.resolutionMet), num(d.resolutionMet) + num(d.resolutionBreached)) })),
    byService,
    byCustomer,
    outOfScopeByCustomer,
    entitlementAlerts,
    expiringContracts: expiring.items.slice(0, 10).map((c) => ({ id: c.id, number: c.number, name: c.name, customerId: c.customerId, customerName: c.customerName, status: c.status, endDate: c.endDate, daysToExpiry: c.daysToExpiry, autoRenew: c.autoRenew })),
    expiringContractsTotal: expiring.total,
    trends: {
      // Period-over-period movement compares the two series (same source, same scope), not the live tile.
      opened: delta(sumOf(series, 'opened'), sumOf(previous, 'opened')),
      resolved: delta(sumOf(series, 'resolved'), sumOf(previous, 'resolved')),
      breaches: delta(kpis.slaBreaches, sumOf(previous, 'slaBreached')),
      slaCompliancePct: delta(kpis.slaCompliancePct, pct(pResMet, pResMet + pResBreached)),
      mttrMinutes: delta(kpis.mttrMinutes, weightedOf(previous, 'mttrMinutes', 'resolved')),
      outOfScope: delta(kpis.outOfScopeCount, sumOf(previous, 'outOfScope')),
      majorIncidents: delta(kpis.majorIncidents, sumOf(previous, 'major')),
    },
    /** Customer satisfaction over the period: the figures, the weekly series, the lowest-rated tickets and the previous period. */
    csat: {
      avg: csat.avg,
      satisfiedPct: csat.satisfiedPct,
      responseRate: csat.responseRate,
      responses: csat.responses,
      sent: csat.sent,
      low: csat.low,
      series: csat.series,
      lowest: csatLowestRows.map((l) => ({ ticketId: l.ticketId, number: l.number, title: l.title, customerName: l.customerName, rating: l.rating, comment: l.comment, answeredAt: l.answeredAt, assigneeName: l.assigneeName })),
      previous: { avg: csatPrevious.avg, responses: csatPrevious.responses },
      trendAvg: delta(csat.avg, csatPrevious.avg),
    },
  };
}

// ---------------------------------------------------------------- NOC

export async function noc(ctx: Ctx, opts: { days?: number; customerId?: string | null; teamId?: string | null } = {}) {
  const customerId = opts.customerId ?? null;
  ctx.require('dashboards:noc', customerId);
  if (customerId) ctx.requireCustomer(customerId);
  const teamId = opts.teamId ?? null;
  const days = clampDays(opts.days);
  const now = new Date();
  const today = toDay(now);
  const from = addDays(today, -(days - 1));
  // Every domain but security, the customer scope and, when asked, one team: the one scope every widget shares.
  const scope = nocScope({ customerId, teamId });
  const base = scope;
  const cust = EMPTY;
  const totals = await nocTotals(ctx, { customerId, teamId });
  const teams = await q<Row>(ctx, sql`SELECT te.id, te.name, te.team_type FROM teams te WHERE te.is_active AND te.team_type IN ('noc', 'infrastructure', 'network') ORDER BY te.name`);
  const openIncidents = await q<Row>(ctx, sql`
    SELECT pr.id, coalesce(pr.label, 'No priority') AS label, pr.key, pr.color, coalesce(pr.level, 99) AS level, count(*)::int AS count, count(*) FILTER (WHERE ${BREACHED})::int AS breached
    FROM tickets t LEFT JOIN config_options pr ON pr.id = t.priority_id WHERE ${base} ${cust} AND t.type = 'incident' AND ${openCond()} GROUP BY pr.id, pr.label, pr.key, pr.color, pr.level ORDER BY level`);
  const criticalOpen = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`
    SELECT ${TICKET_LIST_COLS_STAFF}, ci.name AS ci_name, ci.id AS ci_id FROM tickets t ${TICKET_LIST_JOINS} LEFT JOIN cis ci ON ci.id = t.primary_ci_id
    WHERE ${base} ${cust} AND ${openCond()} AND (pr.level <= 2 OR t.is_major) ORDER BY pr.level NULLS LAST, t.created_at LIMIT 25`));
  const atRiskRows = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`
    SELECT ${TICKET_LIST_COLS_STAFF} FROM tickets t ${TICKET_LIST_JOINS} WHERE ${base} ${cust} AND ${openCond()} AND (${BREACHED} OR ${AT_RISK}) ORDER BY t.created_at LIMIT 100`));
  const slaList = atRiskRows.sort((a, b) => (a.sla?.remainingMinutes ?? 0) - (b.sla?.remainingMinutes ?? 0)).slice(0, 20);
  const unassigned = await q<Row>(ctx, sql`SELECT ${TICKET_LIST_COLS_STAFF} FROM tickets t ${TICKET_LIST_JOINS} WHERE ${base} ${cust} AND ${openCond()} AND t.assignee_id IS NULL ORDER BY pr.level NULLS LAST, t.created_at LIMIT 20`);
  const byCategory = await q<Row>(ctx, sql`
    SELECT cat.id, coalesce(cat.label, 'Uncategorized') AS label, cat.key, count(*)::int AS count, count(*) FILTER (WHERE ${BREACHED})::int AS breached
    FROM tickets t LEFT JOIN config_options cat ON cat.id = t.category_id WHERE ${base} ${cust} AND ${openCond()} AND (cat.domain = 'noc' OR cat.id IS NULL) GROUP BY cat.id, cat.label, cat.key, cat.sort_order ORDER BY count DESC, cat.sort_order`);
  // Open tickets by the team and the service that carry them (ids so each row drills down; every row, largest first, so the web folds the tail into a true "Other").
  const byTeam = await q<Row>(ctx, sql`
    SELECT te.id, coalesce(te.name, 'No team') AS name, count(*)::int AS open, count(*) FILTER (WHERE ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk
    FROM tickets t LEFT JOIN teams te ON te.id = t.assigned_team_id WHERE ${base} ${cust} AND ${openCond()} GROUP BY te.id, te.name ORDER BY open DESC, name`);
  const byService = await q<Row>(ctx, sql`
    SELECT sv.id, coalesce(sv.name, 'No service') AS name, count(*)::int AS open, count(*) FILTER (WHERE ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk
    FROM tickets t LEFT JOIN services sv ON sv.id = t.service_id WHERE ${base} ${cust} AND ${openCond()} GROUP BY sv.id, sv.name ORDER BY open DESC, name`);
  const eventsWhere = sql`e.integration_type = 'prtg' ${custCond(customerId, sql`e.customer_id`)}`;
  const events = await q<Row>(ctx, sql`
    SELECT coalesce(e.severity, 'unknown') AS severity, count(*)::int AS count, count(*) FILTER (WHERE e.ticket_id IS NOT NULL)::int AS ticketed
    FROM integration_events e WHERE ${eventsWhere} AND e.received_at >= now() - interval '24 hours' GROUP BY 1 ORDER BY count DESC`);
  const events7d = await q<Row>(ctx, sql`
    SELECT coalesce(e.severity, 'unknown') AS severity, count(*)::int AS count, count(*) FILTER (WHERE e.ticket_id IS NOT NULL)::int AS ticketed
    FROM integration_events e WHERE ${eventsWhere} AND e.received_at >= now() - interval '7 days' GROUP BY 1 ORDER BY count DESC`);
  const events7dByDay = await q<Row>(ctx, sql`
    WITH d AS (SELECT generate_series(current_date - 6, current_date, interval '1 day')::date AS day)
    SELECT d.day::text AS day, count(e.id)::int AS count, count(e.id) FILTER (WHERE e.ticket_id IS NOT NULL)::int AS ticketed
    FROM d LEFT JOIN integration_events e ON e.received_at::date = d.day AND ${eventsWhere} AND e.received_at >= current_date - 6 GROUP BY d.day ORDER BY d.day`);
  const workload = await q<Row>(ctx, sql`
    WITH ops AS (SELECT DISTINCT tm.user_id FROM team_members tm JOIN teams te ON te.id = tm.team_id WHERE te.team_type IN ('noc', 'infrastructure', 'network') AND te.is_active ${teamId ? sql`AND te.id = ${teamId}::uuid` : EMPTY})
    SELECT u.id, u.name, count(t.id)::int AS open, count(t.id) FILTER (WHERE pr.level <= 2)::int AS critical, count(t.id) FILTER (WHERE ${BREACHED})::int AS breached, count(t.id) FILTER (WHERE t.updated_at < now() - interval '24 hours')::int AS stale,
      (SELECT string_agg(te.name, ', ' ORDER BY te.name) FROM team_members tm JOIN teams te ON te.id = tm.team_id WHERE tm.user_id = u.id AND te.team_type IN ('noc', 'infrastructure', 'network')) AS teams
    FROM users u LEFT JOIN tickets t ON t.assignee_id = u.id AND ${base} ${cust} AND ${openCond()} LEFT JOIN config_options pr ON pr.id = t.priority_id
    WHERE u.status = 'active' AND u.user_type = 'msp' AND (u.id IN (SELECT user_id FROM ops) OR (NOT EXISTS (SELECT 1 FROM ops) AND t.id IS NOT NULL))
    GROUP BY u.id, u.name ORDER BY open DESC, u.name LIMIT 25`);
  const recentlyResolved = await q<Row>(ctx, sql`SELECT ${TICKET_LIST_COLS_STAFF}, round(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60)::int AS mttr_minutes FROM tickets t ${TICKET_LIST_JOINS} WHERE ${base} ${cust} AND t.resolved_at IS NOT NULL ORDER BY t.resolved_at DESC LIMIT 10`);
  const aging = await q<Row>(ctx, sql`SELECT ${AGE_BUCKET} AS bucket, count(*)::int AS count FROM tickets t WHERE ${base} ${cust} AND ${openCond()} GROUP BY 1`);
  const majorIncidents = await q<Row>(ctx, sql`
    SELECT t.id, t.number, t.title, cu.name AS customer_name, m.declared_at, m.last_update_at, m.next_update_due_at, m.bridge_url, u.name AS commander,
      (m.next_update_due_at IS NOT NULL AND m.next_update_due_at < now()) AS overdue,
      (SELECT count(*)::int FROM ticket_links l WHERE l.target_ticket_id = t.id AND l.link_type = 'child_of') AS children
    FROM major_incidents m JOIN tickets t ON t.id = m.ticket_id JOIN customers cu ON cu.id = t.customer_id LEFT JOIN users u ON u.id = m.commander_user_id
    WHERE m.status = 'active' AND ${base} ${cust} ORDER BY m.declared_at DESC LIMIT 10`);
  const order = ['< 4h', '4-24h', '1-3d', '> 3d'];
  // The flow is live and carries the same scope as the tiles (domain, customer, team), so the chart and the numbers agree.
  const series = await domainFlowSeries(ctx, from, today, sql`AND ${base} ${cust}`);
  const timezone = await scopeTimezone(ctx, customerId);
  const ageing = await backlogAgeing(ctx, { customerId, domains: NOT_SOC_DOMAINS, teamId }, now);
  const arrivals = { timezone, week: await arrivalsWeek(ctx, sql`AND ${base} ${cust}`, { from, to: today, timezone }), pattern: { from, to: today, cells: await arrivalHeatmap(ctx, { customerId, from, to: today, timezone, domains: NOT_SOC_DOMAINS, teamId }) } };
  const onCall = await onCallFor(ctx, ['noc', 'infrastructure', 'network']);
  const bucket = (r: Row) => ({ id: (r.id as string | null) ?? null, name: String(r.name), open: num(r.open), breached: num(r.breached), atRisk: num(r.at_risk) });
  return {
    generatedAt: now,
    period: { days, from, to: today },
    customerId,
    teamId,
    /** The NOC-type teams the hero's team filter offers. */
    teams: teams.map((t) => ({ id: String(t.id), name: String(t.name), teamType: String(t.team_type) })),
    onCall,
    majorIncidents: majorIncidents.map((r) => ({ id: String(r.id), number: String(r.number), title: String(r.title), customerName: String(r.customer_name), declaredAt: r.declared_at, lastUpdateAt: r.last_update_at ?? null, nextUpdateDueAt: r.next_update_due_at ?? null, bridgeUrl: r.bridge_url ?? null, commander: r.commander ?? null, overdue: !!r.overdue, children: num(r.children) })),
    series,
    totals,
    openIncidents,
    criticalOpen,
    slaAtRisk: { atRisk: totals.atRisk, breached: totals.breached, items: slaList },
    unassigned: { count: totals.unassigned, items: unassigned },
    byCategory,
    byTeam: byTeam.map(bucket),
    byService: byService.map(bucket),
    monitoringEvents24h: { total: events.reduce((s, e) => s + num(e.count), 0), ticketsCreated: events.reduce((s, e) => s + num(e.ticketed), 0), bySeverity: events },
    monitoringEvents7d: { total: events7d.reduce((s, e) => s + num(e.count), 0), ticketsCreated: events7d.reduce((s, e) => s + num(e.ticketed), 0), bySeverity: events7d, byDay: events7dByDay.map((r) => ({ day: String(r.day), count: num(r.count), ticketed: num(r.ticketed) })) },
    engineerWorkload: workload,
    recentlyResolved,
    aging: order.map((bucket) => ({ bucket, count: num(aging.find((a) => a.bucket === bucket)?.count) })),
    /** The five-bucket backlog ageing with the created window each bar drills down with. */
    ageing,
    arrivals,
  };
}

// ---------------------------------------------------------------- SOC

export async function soc(ctx: Ctx, opts: { days?: number; customerId?: string | null } = {}) {
  const customerId = opts.customerId ?? null;
  ctx.require('dashboards:soc', customerId);
  ctx.require('soc:read', customerId);
  if (customerId) ctx.requireCustomer(customerId);
  const days = clampDays(opts.days);
  const now = new Date();
  const today = toDay(now);
  const from30 = addDays(today, -(days - 1));
  const base = socScope({ customerId });
  const cust = EMPTY;
  const totals = await socTotals(ctx, { customerId });
  // Every severity, retired ones included: a ticket that still carries a retired severity must land in a key of the stacked series, so the stack adds up to the day's opened bar.
  const severities = await q<Row>(ctx, sql`SELECT id, key, label, color, coalesce(level, 99)::int AS level, is_active FROM config_options WHERE type = 'security_severity' ORDER BY is_active DESC, level, sort_order`);
  const bySeverity = await q<Row>(ctx, sql`
    SELECT sev.id, coalesce(sev.label, 'Unclassified') AS label, sev.key, sev.color, coalesce(sev.level, 99) AS level, count(*)::int AS count, count(*) FILTER (WHERE ${BREACHED})::int AS breached
    FROM tickets t LEFT JOIN config_options sev ON sev.id = t.security_severity_id WHERE ${base} ${cust} AND ${openCond()} GROUP BY sev.id, sev.label, sev.key, sev.color, sev.level ORDER BY level`);
  const byCategory = await q<Row>(ctx, sql`
    SELECT cat.id, coalesce(cat.label, 'Uncategorized') AS label, cat.key, count(*)::int AS count FROM tickets t LEFT JOIN config_options cat ON cat.id = t.category_id
    WHERE ${base} ${cust} AND ${openCond()} GROUP BY cat.id, cat.label, cat.key, cat.sort_order ORDER BY count DESC, cat.sort_order LIMIT 12`);
  const byCustomer = await q<Row>(ctx, sql`
    SELECT cu.id, cu.name, cu.code, count(*)::int AS open, count(*) FILTER (WHERE sev.level <= 2)::int AS critical_high, count(*) FILTER (WHERE ${BREACHED})::int AS breached
    FROM tickets t JOIN customers cu ON cu.id = t.customer_id LEFT JOIN config_options sev ON sev.id = t.security_severity_id WHERE ${base} ${cust} AND ${openCond()} GROUP BY cu.id, cu.name, cu.code ORDER BY open DESC LIMIT 10`);
  const escalations = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`
    SELECT ${TICKET_LIST_COLS_STAFF}, sev.label AS severity, sev.color AS severity_color FROM tickets t ${TICKET_LIST_JOINS} LEFT JOIN config_options sev ON sev.id = t.security_severity_id
    WHERE ${base} ${cust} AND ${openCond()} AND t.escalation_level > 0 ORDER BY t.escalation_level DESC, t.created_at LIMIT 10`));
  const slaItems = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`
    SELECT ${TICKET_LIST_COLS_STAFF}, sev.label AS severity, sev.color AS severity_color FROM tickets t ${TICKET_LIST_JOINS} LEFT JOIN config_options sev ON sev.id = t.security_severity_id
    WHERE ${base} ${cust} AND ${openCond()} AND (${BREACHED} OR ${AT_RISK}) ORDER BY t.created_at LIMIT 100`));
  const siemWhere = sql`e.integration_type = 'fortisiem' ${custCond(customerId, sql`e.customer_id`)}`;
  const siem = await q<Row>(ctx, sql`
    SELECT coalesce(e.severity, 'unknown') AS severity, count(*)::int AS count, count(*) FILTER (WHERE e.ticket_id IS NOT NULL)::int AS ticketed
    FROM integration_events e WHERE ${siemWhere} AND e.received_at >= now() - interval '24 hours' GROUP BY 1 ORDER BY count DESC`);
  const siem7d = await q<Row>(ctx, sql`
    SELECT coalesce(e.severity, 'unknown') AS severity, count(*)::int AS count, count(*) FILTER (WHERE e.ticket_id IS NOT NULL)::int AS ticketed
    FROM integration_events e WHERE ${siemWhere} AND e.received_at >= now() - interval '7 days' GROUP BY 1 ORDER BY count DESC`);
  const siem7dByDay = await q<Row>(ctx, sql`
    WITH d AS (SELECT generate_series(current_date - 6, current_date, interval '1 day')::date AS day)
    SELECT d.day::text AS day, count(e.id)::int AS count, count(e.id) FILTER (WHERE e.ticket_id IS NOT NULL)::int AS ticketed
    FROM d LEFT JOIN integration_events e ON e.received_at::date = d.day AND ${siemWhere} AND e.received_at >= current_date - 6 GROUP BY d.day ORDER BY d.day`);
  const recent = await q<Row>(ctx, sql`SELECT ${TICKET_LIST_COLS_STAFF}, sev.label AS severity, sev.color AS severity_color FROM tickets t ${TICKET_LIST_JOINS} LEFT JOIN config_options sev ON sev.id = t.security_severity_id WHERE ${base} ${cust} ORDER BY t.created_at DESC LIMIT 20`);
  const mttr = await one<Row>(ctx, sql`
    SELECT count(*)::int AS resolved, round((avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60))::numeric)::int AS mttr, round((avg(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at)) / 60))::numeric)::int AS response,
      (SELECT count(*)::int FROM tickets t2 WHERE t2.domain = 'soc' ${custCond(customerId, sql`t2.customer_id`)} AND t2.created_at >= now() - (${days} || ' days')::interval) AS opened_30d
    FROM tickets t WHERE ${base} ${cust} AND t.resolved_at >= now() - (${days} || ' days')::interval`);
  // Security-domain ticket flow for the period: the trend chart reads it in full, the KPI sparklines its tail.
  const series = await ticketFlowSeries(ctx, from30, today, sql`AND ${base} ${cust}`);
  // Security tickets opened per day by severity (keyed by the severity key, every day present), for the stacked chart.
  const sevDaily = await q<Row>(ctx, sql`
    SELECT t.created_at::date::text AS day, coalesce(sev.key, 'unclassified') AS key, count(*)::int AS n FROM tickets t LEFT JOIN config_options sev ON sev.id = t.security_severity_id
    WHERE ${base} ${cust} AND t.created_at >= ${from30}::date AND t.created_at < ${today}::date + interval '1 day' GROUP BY 1, 2`);
  const sevKeys = [...severities.map((s) => String(s.key)), 'unclassified'];
  const seriesBySeverity = series.map((d) => ({ day: d.day, ...Object.fromEntries(sevKeys.map((k) => [k, num(sevDaily.find((r) => r.day === d.day && r.key === k)?.n)])) }));
  // Responsiveness per severity over the period: opened, resolved, MTTA, MTTR and the breaches on those tickets.
  const responsivenessBySeverity = (
    await q<Row>(ctx, sql`
      SELECT sev.id, coalesce(sev.label, 'Unclassified') AS label, sev.key, sev.color, coalesce(sev.level, 99)::int AS level,
        count(*) FILTER (WHERE t.created_at >= ${from30}::date AND t.created_at < ${today}::date + interval '1 day')::int AS opened,
        count(*) FILTER (WHERE t.resolved_at >= ${from30}::date AND t.resolved_at < ${today}::date + interval '1 day')::int AS resolved,
        round(avg(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at)) / 60) FILTER (WHERE t.resolved_at >= ${from30}::date AND t.resolved_at < ${today}::date + interval '1 day' AND t.first_response_at IS NOT NULL)) AS mtta,
        round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60) FILTER (WHERE t.resolved_at >= ${from30}::date AND t.resolved_at < ${today}::date + interval '1 day')) AS mttr,
        count(*) FILTER (WHERE t.created_at >= ${from30}::date AND t.created_at < ${today}::date + interval '1 day' AND ${BREACHED})::int AS breached
      FROM tickets t LEFT JOIN config_options sev ON sev.id = t.security_severity_id
      WHERE ${base} ${cust} AND ((t.created_at >= ${from30}::date AND t.created_at < ${today}::date + interval '1 day') OR (t.resolved_at >= ${from30}::date AND t.resolved_at < ${today}::date + interval '1 day'))
      GROUP BY sev.id, sev.label, sev.key, sev.color, sev.level ORDER BY level`)
  ).map((r) => ({ id: (r.id as string | null) ?? null, label: String(r.label), key: (r.key as string | null) ?? null, color: (r.color as string | null) ?? null, level: num(r.level), opened: num(r.opened), resolved: num(r.resolved), mttaMinutes: r.mtta === null || r.mtta === undefined ? null : num(r.mtta), mttrMinutes: r.mttr === null || r.mttr === undefined ? null : num(r.mttr), breached: num(r.breached) }));
  const timezone = await scopeTimezone(ctx, customerId);
  const ageing = await backlogAgeing(ctx, { customerId, domains: ['soc'] }, now);
  const arrivals = { timezone, week: await arrivalsWeek(ctx, sql`AND ${base} ${cust}`, { from: from30, to: today, timezone }), pattern: { from: from30, to: today, cells: await arrivalHeatmap(ctx, { customerId, from: from30, to: today, timezone, domains: ['soc'] }) } };
  const onCall = await onCallFor(ctx, ['soc', 'security']);
  return {
    generatedAt: now,
    period: { days, from: from30, to: today },
    customerId,
    onCall,
    series,
    /** Every security severity in level order (id, key, label, colour), the keys of `seriesBySeverity`. */
    severities: severities.map((s) => ({ id: String(s.id), key: String(s.key), label: String(s.label), color: (s.color as string | null) ?? null, level: num(s.level), isActive: s.is_active !== false })),
    seriesBySeverity,
    totals,
    criticalHighSeverityIds: totals.criticalHighSeverityIds,
    bySeverity,
    byCategory,
    byCustomer,
    responsivenessBySeverity,
    slaStatus: { atRisk: totals.atRisk, breached: totals.breached, items: slaItems.sort((a, b) => (a.sla?.remainingMinutes ?? 0) - (b.sla?.remainingMinutes ?? 0)).slice(0, 20) },
    escalations: { count: totals.escalated, items: escalations },
    siemEvents24h: { total: siem.reduce((s, e) => s + num(e.count), 0), ticketsCreated: siem.reduce((s, e) => s + num(e.ticketed), 0), bySeverity: siem },
    siemEvents7d: { total: siem7d.reduce((s, e) => s + num(e.count), 0), ticketsCreated: siem7d.reduce((s, e) => s + num(e.ticketed), 0), bySeverity: siem7d, byDay: siem7dByDay.map((r) => ({ day: String(r.day), count: num(r.count), ticketed: num(r.ticketed) })) },
    recent,
    mttrSecurity30d: { resolved: num(mttr.resolved), opened: num(mttr.opened_30d), mttrMinutes: mttr.mttr === null || mttr.mttr === undefined ? null : num(mttr.mttr), responseMinutes: mttr.response === null || mttr.response === undefined ? null : num(mttr.response) },
    ageing,
    arrivals,
  };
}

// ---------------------------------------------------------------- engineer (my work)

export async function engineer(ctx: Ctx, opts: { days?: number; customerId?: string | null } = {}) {
  if (isCustomerUser(ctx)) throw new ForbiddenError('The engineer dashboard is available to MSP users');
  const customerId = opts.customerId ?? null;
  if (customerId) ctx.requireCustomer(customerId);
  const cust = custCond(customerId);
  const days = clampDays(opts.days);
  const me = ctx.user.id;
  const teamIds = ctx.user.teams.map((t) => t.id);
  const soc = socCond(ctx);
  const mine = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`SELECT ${TICKET_LIST_COLS_STAFF}, t.due_at, t.priority_id FROM tickets t ${TICKET_LIST_JOINS} WHERE t.assignee_id = ${me}::uuid AND ${openCond()} ${soc} ${cust} ORDER BY pr.level NULLS LAST, t.created_at LIMIT 100`));
  // The tile numbers are exact counts (the table above is capped), with the shared SLA vocabulary, so "Assigned to me" reproduces on the list.
  const mineTotals = await one<Row>(ctx, sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE ${BREACHED})::int AS breached FROM tickets t WHERE t.assignee_id = ${me}::uuid AND ${openCond()} ${soc} ${cust}`);
  // Grouped in the database (not over the capped table), so each "My queue by priority" row reproduces on the list it opens.
  const byPriority = (
    await q<Row>(ctx, sql`
      SELECT pr.id, coalesce(pr.label, 'No priority') AS label, pr.color, coalesce(pr.level, 99) AS level, count(*)::int AS count
      FROM tickets t LEFT JOIN config_options pr ON pr.id = t.priority_id WHERE t.assignee_id = ${me}::uuid AND ${openCond()} ${soc} ${cust} GROUP BY pr.id, pr.label, pr.color, pr.level ORDER BY level`)
  ).map((r) => ({ id: (r.id as string | null) ?? null, label: String(r.label), color: (r.color as string | null) ?? null, level: num(r.level) || 99, count: num(r.count) }));
  const dueSoon = [...mine].filter((t) => t.sla && t.sla.state !== 'paused').sort((a, b) => (a.sla?.remainingMinutes ?? 0) - (b.sla?.remainingMinutes ?? 0)).slice(0, 10);
  const teamQueues = teamIds.length
    ? await q<Row>(ctx, sql`
      SELECT te.id, te.name, count(t.id) FILTER (WHERE t.assignee_id IS NULL)::int AS unassigned, count(t.id)::int AS open, count(t.id) FILTER (WHERE ${BREACHED})::int AS breached
      FROM teams te LEFT JOIN tickets t ON t.assigned_team_id = te.id AND ${openCond()} ${soc} ${cust} WHERE te.id = ANY(ARRAY[${sql.join(teamIds.map((id) => sql`${id}::uuid`), sql`, `)}]) GROUP BY te.id, te.name ORDER BY te.name`)
    : [];
  const todayRows = await q<Row>(ctx, sql`SELECT ${TICKET_LIST_COLS_STAFF}, t.due_at FROM tickets t ${TICKET_LIST_JOINS} WHERE t.assignee_id = ${me}::uuid AND ${openCond()} AND t.due_at >= current_date AND t.due_at < current_date + 1 ${soc} ${cust} ORDER BY t.due_at LIMIT 20`);
  const visits = await q<Row>(ctx, sql`
    SELECT v.id, v.number, v.title, v.status, v.scheduled_start, v.scheduled_end, cu.name AS customer_name, si.name AS site_name FROM field_visits v LEFT JOIN customers cu ON cu.id = v.customer_id LEFT JOIN sites si ON si.id = v.site_id
    WHERE (v.engineer_id = ${me}::uuid OR ${me}::uuid = ANY(v.additional_engineer_ids)) AND v.status IN ('requested', 'scheduled', 'in_progress') AND v.scheduled_start >= current_date AND v.scheduled_start < current_date + 1 ${custCond(customerId, sql`v.customer_id`)} ORDER BY v.scheduled_start LIMIT 20`);
  const pmToday = await q<Row>(ctx, sql`
    SELECT o.id, p.id AS program_id, p.name AS program, cu.name AS customer_name, o.status, o.planned_date, o.scheduled_date FROM pm_occurrences o JOIN pm_programs p ON p.id = o.program_id LEFT JOIN customers cu ON cu.id = o.customer_id
    WHERE coalesce(o.engineer_id, p.assigned_engineer_id) = ${me}::uuid AND o.status IN ('planned', 'scheduled') AND coalesce(o.scheduled_date, o.planned_date) = current_date ${custCond(customerId, sql`o.customer_id`)} ORDER BY p.name LIMIT 20`);
  const tasks = await q<Row>(ctx, sql`
    SELECT k.id, k.title, k.status, k.due_at, t.id AS ticket_id, t.number AS ticket_number, t.title AS ticket_title FROM ticket_tasks k JOIN tickets t ON t.id = k.ticket_id
    WHERE k.assignee_id = ${me}::uuid AND k.status NOT IN ('done', 'completed', 'cancelled') ${soc} ${cust} ORDER BY k.due_at NULLS LAST, k.created_at LIMIT 20`);
  const approvals = await one<Row>(ctx, sql`SELECT count(*)::int AS n FROM approvals a WHERE a.status = 'pending' AND (a.approver_user_id = ${me}::uuid ${teamIds.length ? sql`OR a.approver_team_id = ANY(ARRAY[${sql.join(teamIds.map((id) => sql`${id}::uuid`), sql`, `)}])` : EMPTY})`);
  const activity = await one<Row>(ctx, sql`
    SELECT (SELECT count(*)::int FROM ticket_comments c WHERE c.author_id = ${me}::uuid AND c.created_at >= current_date) AS comments,
      (SELECT coalesce(sum(te.minutes), 0)::int FROM time_entries te WHERE te.user_id = ${me}::uuid AND te.created_at >= current_date) AS minutes,
      (SELECT count(*)::int FROM tickets t WHERE t.assignee_id = ${me}::uuid AND t.resolved_at >= current_date ${soc} ${cust}) AS resolved,
      (SELECT count(*)::int FROM tickets t WHERE t.assignee_id = ${me}::uuid AND ${openCond()} AND ${BREACHED} ${soc} ${cust}) AS breached`);
  const serviceIds = [...new Set(mine.map((t) => t.service_id).filter((x): x is string => typeof x === 'string'))];
  const myServices = await q<{ service_id: string }>(ctx, sql`SELECT DISTINCT t.service_id FROM tickets t WHERE t.assignee_id = ${me}::uuid AND ${openCond()} AND t.service_id IS NOT NULL LIMIT 50`);
  const svcIds = [...new Set([...serviceIds, ...myServices.map((s) => s.service_id)])];
  const knowledge = await q<Row>(ctx, sql`
    SELECT a.id, a.number, a.title, a.article_type, a.published_at, s.name AS service_name FROM kb_articles a LEFT JOIN services s ON s.id = a.service_id
    WHERE a.status = 'published' ${svcIds.length ? sql`AND (a.service_id = ANY(ARRAY[${sql.join(svcIds.map((id) => sql`${id}::uuid`), sql`, `)}]) OR a.service_id IS NULL)` : EMPTY}
    ORDER BY (a.service_id IS NOT NULL) DESC, a.published_at DESC NULLS LAST LIMIT 5`);
  const watched = await q<Row>(ctx, sql`
    SELECT ${TICKET_LIST_COLS_STAFF} FROM ticket_watchers w JOIN tickets t ON t.id = w.ticket_id ${TICKET_LIST_JOINS}
    WHERE w.user_id = ${me}::uuid AND t.last_activity_at >= now() - interval '24 hours' ${soc} ${cust} ORDER BY t.last_activity_at DESC LIMIT 10`);
  const today = toDay(new Date());
  const from14 = addDays(today, -(days - 1));
  const flow = await ticketFlowSeries(ctx, from14, today, sql`AND t.assignee_id = ${me}::uuid ${soc} ${cust}`);
  const csatFilter = await csatWindow(ctx, from14, today, { customerId, assigneeId: me });
  const csat = await csatFigures(ctx.tx, csatFilter);
  const recent = await q<Row>(ctx, sql`
    SELECT s.ticket_id, t.number, t.title, s.rating, s.comment, s.answered_at, cu.name AS customer_name FROM ticket_surveys s JOIN tickets t ON t.id = s.ticket_id LEFT JOIN customers cu ON cu.id = s.customer_id
    WHERE s.assignee_id = ${me}::uuid AND s.status = 'answered' AND s.answered_at >= ${csatFilter.from} ${soc} ${custCond(customerId, sql`s.customer_id`)} ORDER BY s.answered_at DESC LIMIT 5`);
  return {
    generatedAt: new Date(),
    period: { days, from: from14, to: today },
    /** Tickets assigned to me resolved per day over the period. */
    series: flow.map((d) => ({ day: d.day, resolved: d.resolved })),
    assigned: { total: num(mineTotals.total), byPriority, breached: num(mineTotals.breached), items: mine.slice(0, 25), dueSoon },
    teamQueues,
    today: { dueTickets: todayRows, visits, pmOccurrences: pmToday, tasks },
    approvalsPending: num(approvals.n),
    activity: { comments: num(activity.comments), minutes: num(activity.minutes), resolved: num(activity.resolved), breachedAssigned: num(activity.breached) },
    knowledge,
    watched,
    /** Customer ratings on tickets I handled over the period. */
    csat: { avg: csat.avg, responses: csat.responses, satisfiedPct: csat.satisfiedPct, recent: recent.map((r) => ({ ticketId: String(r.ticket_id), number: String(r.number), title: String(r.title), rating: num(r.rating), comment: (r.comment as string | null) ?? null, answeredAt: r.answered_at ?? null, customerName: (r.customer_name as string | null) ?? null })) },
  };
}

// ---------------------------------------------------------------- customer

export async function customer(ctx: Ctx, opts: { customerId?: string | null; days?: number } = {}) {
  const days = clampDays(opts.days);
  let customerId: string;
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:access', ctx.user.customerId)) throw new ForbiddenError('Missing permission: portal:access');
    if (!ctx.user.customerId) throw new ForbiddenError('Customer context required');
    customerId = ctx.user.customerId;
  } else {
    if (!opts.customerId) throw new ValidationError('customerId is required');
    ctx.require('customers:read', opts.customerId);
    ctx.requireCustomer(opts.customerId);
    customerId = opts.customerId;
  }
  // Staff see this customer's tickets under their own security fence (the list the tiles open applies the same one);
  // a portal user is never fenced here, their organisation's tickets are theirs to see.
  const cust = sql`t.customer_id = ${customerId}::uuid ${socCond(ctx)}`;
  const [info] = await q<Row>(ctx, sql`SELECT c.id, c.name, c.code, c.timezone, c.account_manager_id, am.name AS account_manager_name, am.email AS account_manager_email, am.phone AS account_manager_phone FROM customers c LEFT JOIN users am ON am.id = c.account_manager_id WHERE c.id = ${customerId}::uuid`);
  const open = await q<Row>(ctx, sql`SELECT st.status_category AS category, count(*)::int AS count FROM tickets t JOIN config_options st ON st.id = t.status_id WHERE ${cust} AND ${openCond()} GROUP BY 1`);
  const byPriority = await q<Row>(ctx, sql`SELECT pr.id, pr.key, coalesce(pr.label, 'No priority') AS label, pr.color, coalesce(pr.level, 99) AS level, count(*)::int AS count FROM tickets t LEFT JOIN config_options pr ON pr.id = t.priority_id WHERE ${cust} AND ${openCond()} GROUP BY 1, 2, 3, 4, 5 ORDER BY 5`);
  const byType = await q<Row>(ctx, sql`SELECT t.type, count(*)::int AS count FROM tickets t WHERE ${cust} AND ${openCond()} GROUP BY 1`);
  const now = new Date();
  const today = toDay(now);
  const from30 = addDays(today, -(days - 1));
  // Opened / resolved in the period use the same whole-day window as the series below, so the tile, the chart and the list it opens agree.
  const counts = await one<Row>(ctx, sql`
    SELECT count(*) FILTER (WHERE ${openCond()})::int AS open, count(*) FILTER (WHERE ${openCond()} AND st.key = 'pending_customer')::int AS awaiting_reply, count(*) FILTER (WHERE ${openCond()} AND st.key = 'awaiting_approval')::int AS awaiting_approval,
      count(*) FILTER (WHERE t.resolved_at >= ${from30}::date)::int AS resolved_30d, count(*) FILTER (WHERE t.created_at >= ${from30}::date)::int AS opened_30d, count(*) FILTER (WHERE ${openCond()} AND t.is_major)::int AS major_open
    FROM tickets t JOIN config_options st ON st.id = t.status_id WHERE ${cust} AND (${openCond()} OR t.created_at >= ${from30}::date OR t.resolved_at >= ${from30}::date)`);
  const d30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const d90 = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const dPeriod = new Date(now.getTime() - days * 86_400_000).toISOString();
  const [sla30, sla90] = [await slaCompliance(ctx, { customerId, from: d30, groupBy: 'priority' }), await slaCompliance(ctx, { customerId, from: d90, groupBy: 'priority' })];
  const slaPeriod = days === 30 ? sla30 : days === 90 ? sla90 : await slaCompliance(ctx, { customerId, from: dPeriod, groupBy: 'priority' });
  const series = await dailySeries(ctx, from30, today, customerId);
  const contracts = await q<Row>(ctx, sql`
    SELECT c.id, c.number, c.name, c.status, c.start_date, c.end_date, (c.end_date - current_date)::int AS days_to_expiry, c.auto_renew, ty.label AS type,
      (SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM contract_services cs JOIN services s ON s.id = cs.service_id WHERE cs.contract_id = c.id) AS services
    FROM contracts c LEFT JOIN config_options ty ON ty.id = c.type_id WHERE c.customer_id = ${customerId}::uuid AND c.status IN ('active', 'expiring') ORDER BY c.end_date LIMIT 20`);
  const entitlements = (await customerEntitlements(ctx, customerId)).map((e) => ({ id: e.id, name: e.name, unit: e.unit, period: e.utilization.period, contractNumber: e.contractNumber, quantity: e.utilization.quantity, used: e.utilization.used, remaining: e.utilization.remaining, pct: e.utilization.pct, overThreshold: e.utilization.overThreshold, exhausted: e.utilization.exhausted, periodEnd: e.utilization.periodEnd }));
  const maintenance = await q<Row>(ctx, sql`
    SELECT o.id, p.name AS program, o.planned_date, o.scheduled_date, o.status, si.name AS site, u.name AS engineer FROM pm_occurrences o JOIN pm_programs p ON p.id = o.program_id LEFT JOIN sites si ON si.id = p.site_id LEFT JOIN users u ON u.id = coalesce(o.engineer_id, p.assigned_engineer_id)
    WHERE o.customer_id = ${customerId}::uuid AND o.status IN ('planned', 'scheduled', 'rescheduled') AND coalesce(o.scheduled_date, o.planned_date) BETWEEN current_date AND current_date + 30 ORDER BY coalesce(o.scheduled_date, o.planned_date) LIMIT 10`);
  const visits = await q<Row>(ctx, sql`
    SELECT v.id, v.number, v.title, v.status, v.scheduled_start, v.scheduled_end, u.name AS engineer, si.name AS site FROM field_visits v LEFT JOIN users u ON u.id = v.engineer_id LEFT JOIN sites si ON si.id = v.site_id
    WHERE v.customer_id = ${customerId}::uuid AND v.status IN ('requested', 'scheduled', 'in_progress') AND coalesce(v.scheduled_start, now()) >= now() - interval '1 day' ORDER BY v.scheduled_start NULLS LAST LIMIT 10`);
  const reports = await q<Row>(ctx, sql`
    SELECT r.id, r.name, r.report_key, r.format, r.created_at, r.attachment_id, a.filename, a.size, r.parameters->>'period' AS period FROM report_runs r LEFT JOIN attachments a ON a.id = r.attachment_id
    WHERE r.customer_id = ${customerId}::uuid AND r.portal_visible AND r.status = 'completed' ORDER BY r.created_at DESC LIMIT 5`);
  const recent = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`SELECT ${TICKET_LIST_COLS} FROM tickets t ${TICKET_LIST_JOINS} WHERE ${cust} ORDER BY t.last_activity_at DESC LIMIT 10`));
  const teams = await q<Row>(ctx, sql`
    SELECT te.id, te.name, te.team_type, te.email, m.name AS manager_name FROM teams te LEFT JOIN users m ON m.id = te.manager_user_id
    WHERE te.is_active AND (te.id IN (SELECT ct.team_id FROM customer_teams ct WHERE ct.customer_id = ${customerId}::uuid) OR te.team_type = 'service_desk') ORDER BY (te.team_type = 'service_desk') DESC, te.name LIMIT 10`);
  // Known issues with a workaround: the organisation's published known errors (customer-safe fields only); empty for portal users without portal:kedb.
  const canKedb = !isCustomerUser(ctx) || ctx.can('portal:kedb', customerId);
  const keConds = sql`pd.is_known_error AND pd.portal_visible AND coalesce(pd.ke_status, 'open') <> 'retired' AND ${cust}`;
  const kePublished = canKedb ? await one<Row>(ctx, sql`SELECT count(*)::int AS n FROM problem_details pd JOIN tickets t ON t.id = pd.ticket_id WHERE ${keConds}`) : { n: 0 };
  const keItems = canKedb
    ? await q<Row>(ctx, sql`SELECT t.id, t.number, t.title, coalesce(pd.ke_status, 'open') AS ke_status, pd.published_at FROM problem_details pd JOIN tickets t ON t.id = pd.ticket_id WHERE ${keConds} AND coalesce(pd.ke_status, 'open') IN ('open', 'fix_in_progress') ORDER BY pd.published_at DESC NULLS LAST LIMIT 5`)
    : [];
  const openTotal = num(counts.open);
  const csatFilter = await csatWindow(ctx, from30, today, { customerId });
  const csat = await csatFigures(ctx.tx, csatFilter);
  const pendingCount = await pendingSurveyCount(ctx.tx, customerId);
  const pendingItems = isCustomerUser(ctx) ? await pendingSurveyItems(ctx.tx, customerId, null, 5) : [];
  return {
    generatedAt: now,
    customer: info ? { id: info.id, name: info.name, code: info.code, timezone: info.timezone } : { id: customerId, name: '', code: '', timezone: 'UTC' },
    period: { days, from: from30, to: today },
    /** Tickets opened and resolved per day for this customer over the period. */
    series: series.map((d) => ({ day: d.day, opened: num(d.opened), resolved: num(d.resolved) })),
    tickets: {
      open: openTotal,
      byStatusCategory: Object.fromEntries(open.map((r) => [String(r.category), num(r.count)])),
      byPriority,
      byType: Object.fromEntries(byType.map((r) => [String(r.type), num(r.count)])),
      awaitingReply: num(counts.awaiting_reply),
      awaitingApproval: num(counts.awaiting_approval),
      resolved30d: num(counts.resolved_30d),
      opened30d: num(counts.opened_30d),
      majorOpen: num(counts.major_open),
    },
    sla: { period: { days, totals: slaPeriod.totals, groups: slaPeriod.groups }, days30: { totals: sla30.totals, groups: sla30.groups }, days90: { totals: sla90.totals, groups: sla90.groups } },
    contracts,
    entitlements,
    upcomingMaintenance: maintenance,
    scheduledVisits: visits,
    reports,
    recentTickets: recent,
    serviceTeam: {
      accountManager: info?.account_manager_id ? { id: info.account_manager_id, name: info.account_manager_name, email: info.account_manager_email, phone: info.account_manager_phone } : null,
      teams,
    },
    knownErrors: { published: num(kePublished.n), items: keItems.map((r) => ({ id: String(r.id), number: String(r.number), title: String(r.title), keStatus: String(r.ke_status), publishedAt: r.published_at ?? null })) },
    /** The organisation's satisfaction over the period and the tickets still to rate (items for portal users only). */
    csat: { avg: csat.avg, responses: csat.responses, satisfiedPct: csat.satisfiedPct, pending: { count: pendingCount, items: pendingItems } },
  };
}

// ---------------------------------------------------------------- trends

export async function trends(ctx: Ctx, opts: { customerId?: string | null; from?: string; to?: string; metric?: string }) {
  let customerId = opts.customerId ?? null;
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:access', ctx.user.customerId)) throw new ForbiddenError('Missing permission: portal:access');
    customerId = ctx.user.customerId;
  } else {
    if (!(ctx.can('dashboards:management', customerId) || ctx.can('customers:read', customerId) || ctx.can('tickets:read', customerId))) throw new ForbiddenError('Missing permission: dashboards:management');
    if (customerId) ctx.requireCustomer(customerId);
  }
  const to = opts.to ? toDay(parseDay(opts.to)) : toDay(new Date());
  const from = opts.from ? toDay(parseDay(opts.from)) : addDays(to, -29);
  if (from > to) throw new ValidationError('from must be on or before to');
  if (daysBetween(from, to) > 400) throw new ValidationError('Range cannot exceed 400 days');
  const series = await dailySeries(ctx, from, to, customerId);
  const metric = opts.metric && (METRIC_KEYS as readonly string[]).includes(opts.metric) ? (opts.metric as MetricKey) : null;
  return {
    customerId,
    from,
    to,
    metric,
    series: metric ? series.map((d) => ({ day: d.day, value: d[metric] })) : series,
    totals: Object.fromEntries(METRIC_KEYS.filter((k) => k !== 'mttrMinutes' && k !== 'firstResponseMinutes').map((k) => [k, sumOf(series, k)])),
  };
}

// ---------------------------------------------------------------- AMC / field service (ticket management view)

export async function amc(ctx: Ctx, opts: { days?: number; customerId?: string | null } = {}) {
  const customerId = opts.customerId ?? null;
  ctx.require('dashboards:amc', customerId);
  if (customerId) ctx.requireCustomer(customerId);
  const cust = EMPTY;
  const vcust = custCond(customerId, sql`v.customer_id`);
  const ocust = custCond(customerId, sql`o.customer_id`);
  const days = clampDays(opts.days);
  const base = amcScope({ customerId });
  const kpis = await amcTotals(ctx, { customerId });
  const queue = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`
    SELECT ${TICKET_LIST_COLS_STAFF}, st.key AS status_key, si.name AS site_name, t.due_at, (t.due_at >= current_date AND t.due_at < current_date + 1) AS due_today,
      v.number AS visit_number, v.id AS visit_id
    FROM tickets t ${TICKET_LIST_JOINS} LEFT JOIN sites si ON si.id = t.site_id
    LEFT JOIN LATERAL (SELECT fv.id, fv.number FROM field_visits fv WHERE fv.ticket_id = t.id ORDER BY fv.created_at DESC LIMIT 1) v ON true
    WHERE ${base} ${cust} AND ${openCond()} ORDER BY pr.level NULLS LAST, t.created_at LIMIT 200`));
  const visits = await q<Row>(ctx, sql`
    SELECT v.id, v.number, v.title, v.status, v.scheduled_start, v.scheduled_end, cu.name AS customer_name, si.name AS site_name, u.name AS engineer, t.number AS ticket_number, t.id AS ticket_id
    FROM field_visits v LEFT JOIN customers cu ON cu.id = v.customer_id LEFT JOIN sites si ON si.id = v.site_id LEFT JOIN users u ON u.id = v.engineer_id LEFT JOIN tickets t ON t.id = v.ticket_id
    WHERE v.status IN ('requested', 'scheduled', 'in_progress') AND coalesce(v.scheduled_start, now()) >= now() - interval '1 day' AND coalesce(v.scheduled_start, now()) < date_trunc('week', now()) + interval '14 days' ${vcust}
    ORDER BY (v.status = 'in_progress') DESC, v.scheduled_start NULLS LAST LIMIT 12`);
  const maintenance = await q<Row>(ctx, sql`
    SELECT o.id, p.id AS program_id, p.name AS program, cu.name AS customer_name, si.name AS site, coalesce(o.scheduled_date, o.planned_date) AS due_date, o.status,
      (coalesce(o.scheduled_date, o.planned_date) < current_date) AS overdue, u.name AS engineer
    FROM pm_occurrences o JOIN pm_programs p ON p.id = o.program_id LEFT JOIN customers cu ON cu.id = o.customer_id LEFT JOIN sites si ON si.id = p.site_id LEFT JOIN users u ON u.id = coalesce(o.engineer_id, p.assigned_engineer_id)
    WHERE o.status IN ('planned', 'scheduled', 'rescheduled') AND coalesce(o.scheduled_date, o.planned_date) <= current_date + 14 ${ocust} ORDER BY coalesce(o.scheduled_date, o.planned_date) LIMIT 10`);
  const ents = ctx.can('contracts:read') ? await entitlementSummary(ctx, customerId ?? undefined, 500) : { total: 0, overThreshold: 0, exhausted: 0, items: [] };
  const entitlements = ents.items.filter((i) => (i.unit === 'visits' || i.unit === 'hours') && (i.utilization.pct >= 80 || i.utilization.exhausted)).slice(0, 6);
  const now = new Date();
  const today = toDay(now);
  const from30 = addDays(today, -(days - 1));
  const daily = await dailySeries(ctx, from30, today, customerId);
  // AMC load by customer and by site (open tickets now, ids so each row drills down).
  const byCustomer = (
    await q<Row>(ctx, sql`
      SELECT cu.id, cu.name, cu.code, count(*)::int AS open, count(*) FILTER (WHERE ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk, count(*) FILTER (WHERE t.due_at >= current_date AND t.due_at < current_date + 1)::int AS due_today
      FROM tickets t JOIN customers cu ON cu.id = t.customer_id WHERE ${base} ${cust} AND ${openCond()} GROUP BY cu.id, cu.name, cu.code ORDER BY open DESC, cu.name LIMIT 12`)
  ).map((r) => ({ id: String(r.id), name: String(r.name), code: String(r.code), open: num(r.open), breached: num(r.breached), atRisk: num(r.at_risk), dueToday: num(r.due_today) }));
  const bySite = (
    await q<Row>(ctx, sql`
      SELECT si.id, coalesce(si.name, 'No site') AS name, t.customer_id, cu.name AS customer_name, count(*)::int AS open, count(*) FILTER (WHERE ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk
      FROM tickets t LEFT JOIN sites si ON si.id = t.site_id JOIN customers cu ON cu.id = t.customer_id WHERE ${base} ${cust} AND ${openCond()} GROUP BY si.id, si.name, t.customer_id, cu.name ORDER BY open DESC, name LIMIT 12`)
  ).map((r) => ({ id: (r.id as string | null) ?? null, name: String(r.name), customerId: String(r.customer_id), customerName: String(r.customer_name), open: num(r.open), breached: num(r.breached), atRisk: num(r.at_risk) }));
  // Visits per engineer, counted with the visits list's own predicates so each cell opens the list it was counted on
  // (`/field/visits?engineerId&status[&from&to]`): the engineer is the lead or an additional engineer, "scheduled" is every
  // visit still in that status (overdue ones included), "completed" the completed visits whose scheduled start falls in the period.
  const visitsByEngineer = (
    await q<Row>(ctx, sql`
      SELECT u.id, u.name, count(*) FILTER (WHERE v.status = 'scheduled')::int AS scheduled, count(*) FILTER (WHERE v.status = 'in_progress')::int AS in_progress,
        count(*) FILTER (WHERE v.status = 'completed' AND v.scheduled_start >= ${from30}::date AND v.scheduled_start < ${today}::date + interval '1 day')::int AS completed
      FROM field_visits v JOIN users u ON u.id = v.engineer_id OR u.id = ANY(v.additional_engineer_ids)
      WHERE ((v.status IN ('scheduled', 'in_progress')) OR (v.status = 'completed' AND v.scheduled_start >= ${from30}::date AND v.scheduled_start < ${today}::date + interval '1 day')) ${vcust}
      GROUP BY u.id, u.name ORDER BY (count(*) FILTER (WHERE v.status IN ('scheduled', 'in_progress'))) DESC, u.name LIMIT 12`)
  ).map((r) => ({ id: String(r.id), name: String(r.name), scheduled: num(r.scheduled), inProgress: num(r.in_progress), completedInPeriod: num(r.completed) }));
  const ageing = await backlogAgeing(ctx, { customerId, domains: ['amc'] }, now);
  // Pipeline health: visits scheduled and PM occurrences planned in the last 30 and next 30 days, by status (fixed lifecycle order),
  // counted on the date the lists filter on (`scheduled_start`, `planned_date`) so a slice opens `?status&from&to` with the same number.
  const window = { from: addDays(today, -30), to: addDays(today, 30) };
  const visitRows = await q<Row>(ctx, sql`SELECT v.status, count(*)::int AS count FROM field_visits v WHERE v.scheduled_start >= ${window.from}::date AND v.scheduled_start < ${window.to}::date + interval '1 day' ${vcust} GROUP BY 1`);
  const pmRows = await q<Row>(ctx, sql`SELECT o.status, count(*)::int AS count FROM pm_occurrences o WHERE o.planned_date BETWEEN ${window.from}::date AND ${window.to}::date ${ocust} GROUP BY 1`);
  const byStatus = (rows: Row[], order: string[]) => order.map((status) => ({ status, count: num(rows.find((r) => r.status === status)?.count) }));
  // Resolution SLA on AMC tickets opened in the period (same clocks management() sums per customer).
  const sla = await one<Row>(ctx, sql`
    SELECT count(*) FILTER (WHERE s.state = 'met')::int AS met, count(*) FILTER (WHERE s.state = 'breached')::int AS breached
    FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id WHERE s.metric = 'resolution' AND ${base} ${cust} AND t.created_at >= ${from30}::date`);
  const csat = await csatFigures(ctx.tx, await csatWindow(ctx, from30, today, { customerId, domain: 'amc' }));
  return {
    generatedAt: now,
    period: { days, from: from30, to: today },
    customerId,
    /** Site visits and PM occurrences completed per day over the period. */
    series: daily.map((d) => ({ day: d.day, visitsCompleted: num(d.visitsCompleted), pmCompleted: num(d.pmCompleted) })),
    /** The window the two status donuts count over (the last 30 and the next 30 days); a slice links with it. */
    window,
    visitsByStatus: byStatus(visitRows, ['requested', 'scheduled', 'in_progress', 'completed', 'cancelled']),
    pmByStatus: byStatus(pmRows, ['planned', 'scheduled', 'rescheduled', 'completed', 'missed', 'cancelled']),
    sla30d: { met: num(sla.met), breached: num(sla.breached), compliancePct: pct(num(sla.met), num(sla.met) + num(sla.breached)) },
    kpis,
    byCustomer,
    bySite,
    visitsByEngineer,
    ageing,
    queue: {
      items: queue,
      counts: {
        all: queue.length,
        unassigned: queue.filter((t) => !t.assignee_id).length,
        dueToday: queue.filter((t) => t.due_today === true).length,
        breached: queue.filter((t) => t.sla?.breached).length,
        awaitingCustomer: queue.filter((t) => t.status_key === 'pending_customer').length,
      },
    },
    visits,
    maintenance,
    entitlements,
    /** Customer satisfaction on AMC tickets over the period. */
    csat30d: { avg: csat.avg, responses: csat.responses, satisfiedPct: csat.satisfiedPct },
  };
}
