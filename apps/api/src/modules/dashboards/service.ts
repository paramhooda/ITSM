import { sql } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { ForbiddenError, ValidationError } from '@/core/errors';
import { slaSummariesFor, worstSla } from '@/modules/sla/engine';
import { slaCompliance } from '@/modules/sla/policies';
import { entitlementSummary, customerEntitlements } from '@/modules/contracts/entitlements';
import { expiringContracts } from '@/modules/contracts/service';
import { parseDay } from '@/modules/reports/dates';
import { q, one, num, pct, isCustomerUser, openCond, custCond, socCond, BREACHED, AT_RISK, AGE_BUCKET, TICKET_LIST_COLS, TICKET_LIST_JOINS, EMPTY, dailySeries, sumOf, weightedOf, delta, toDay, addDays, daysBetween, METRIC_KEYS, type MetricKey } from './common';

type Row = Record<string, unknown>;

/** Attaches the worst SLA (remaining minutes, state) to ticket rows. */
async function withSla<T extends { id: string }>(ctx: Ctx, list: T[]) {
  const map = await slaSummariesFor(ctx.tx, list.map((t) => t.id));
  return list.map((t) => ({ ...t, sla: worstSla(map.get(t.id)) }));
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

  const live = await one<Row>(ctx, sql`
    SELECT count(*) FILTER (WHERE ${openCond()})::int AS open_now, count(*) FILTER (WHERE t.created_at >= ${today}::date)::int AS opened_today, count(*) FILTER (WHERE t.resolved_at >= ${today}::date)::int AS resolved_today,
      count(*) FILTER (WHERE ${openCond()} AND ${BREACHED})::int AS breached_open, count(*) FILTER (WHERE ${openCond()} AND t.assignee_id IS NULL)::int AS unassigned_open, count(*) FILTER (WHERE ${openCond()} AND t.is_major)::int AS major_open
    FROM tickets t WHERE (t.created_at >= ${from}::date OR ${openCond()}) ${custCond(customerId)} ${soc}`);
  const counts = await one<Row>(ctx, sql`
    SELECT (SELECT count(*)::int FROM customers c WHERE c.is_active ${custCond(customerId, sql`c.id`)}) AS customers_active,
      (SELECT count(*)::int FROM contracts c WHERE c.status IN ('active', 'expiring') ${custCond(customerId, sql`c.customer_id`)}) AS contracts_active,
      (SELECT count(*)::int FROM contracts c WHERE c.status IN ('active', 'expiring') AND c.end_date >= current_date AND c.end_date <= current_date + 90 ${custCond(customerId, sql`c.customer_id`)}) AS contracts_expiring_90d,
      (SELECT count(*)::int FROM contracts c WHERE c.status = 'expired' AND c.end_date >= current_date - 30 ${custCond(customerId, sql`c.customer_id`)}) AS contracts_expired_30d`);
  const pm = await one<Row>(ctx, sql`
    SELECT count(*) FILTER (WHERE o.status = 'completed' AND o.completed_at IS NOT NULL AND o.completed_at::date <= o.planned_date + p.grace_days)::int AS on_time,
      count(*) FILTER (WHERE o.status IN ('completed', 'missed'))::int AS done, count(*) FILTER (WHERE o.status = 'missed')::int AS missed,
      count(*) FILTER (WHERE o.status IN ('planned', 'scheduled') AND o.planned_date < current_date)::int AS overdue
    FROM pm_occurrences o JOIN pm_programs p ON p.id = o.program_id WHERE o.planned_date >= ${from}::date AND o.planned_date <= ${today}::date ${custCond(customerId, sql`o.customer_id`)}`);

  const byService = await q<Row>(ctx, sql`
    SELECT sv.id, coalesce(sv.name, 'No service') AS name, count(*)::int AS tickets, count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = t.id AND s.state = 'breached'))::int AS breaches, count(*) FILTER (WHERE t.scope_status = 'out_of_scope')::int AS out_of_scope
    FROM tickets t LEFT JOIN services sv ON sv.id = t.service_id WHERE ${range} ${custCond(customerId)} ${soc} GROUP BY sv.id, sv.name ORDER BY tickets DESC LIMIT 10`);
  const topCustomers = await q<Row>(ctx, sql`
    SELECT cu.id, cu.name, cu.code, count(*)::int AS tickets, count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved, count(*) FILTER (WHERE t.scope_status = 'out_of_scope')::int AS out_of_scope, count(*) FILTER (WHERE t.is_major)::int AS major
    FROM tickets t JOIN customers cu ON cu.id = t.customer_id WHERE ${range} ${custCond(customerId)} ${soc} GROUP BY cu.id, cu.name, cu.code ORDER BY tickets DESC LIMIT 10`);
  const custIds = topCustomers.map((c) => c.id as string);
  const slaByCustomer = custIds.length
    ? await q<Row>(ctx, sql`
      SELECT s.customer_id, count(*) FILTER (WHERE s.state = 'met')::int AS met, count(*) FILTER (WHERE s.state = 'breached')::int AS breached
      FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id WHERE s.metric = 'resolution' AND s.customer_id = ANY(ARRAY[${sql.join(custIds.map((id) => sql`${id}::uuid`), sql`, `)}]) AND ${range} ${soc} GROUP BY s.customer_id`)
    : [];
  const slaMap = new Map(slaByCustomer.map((r) => [String(r.customer_id), r]));
  const byCustomer = topCustomers.map((c) => {
    const s = slaMap.get(String(c.id));
    return { ...c, slaMet: num(s?.met), slaBreached: num(s?.breached), compliancePct: pct(num(s?.met), num(s?.met) + num(s?.breached)) };
  });
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
  const kpis = {
    customersActive: num(counts.customers_active),
    contractsActive: num(counts.contracts_active),
    contractsExpiring90d: num(counts.contracts_expiring_90d),
    contractsExpired30d: num(counts.contracts_expired_30d),
    ticketsOpened: sumOf(series, 'opened'),
    ticketsResolved: sumOf(series, 'resolved'),
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
  };
  return {
    period: { days, from, to: today, previousFrom: prevFrom, previousTo: prevTo },
    customerId,
    kpis,
    series: series.map((d) => ({ day: d.day, opened: num(d.opened), resolved: num(d.resolved), closed: num(d.closed), breaches: num(d.slaBreached), outOfScope: num(d.outOfScope), mttrMinutes: d.mttrMinutes })),
    byService,
    byCustomer,
    outOfScopeByCustomer,
    entitlementAlerts,
    expiringContracts: expiring.items.slice(0, 10).map((c) => ({ id: c.id, number: c.number, name: c.name, customerId: c.customerId, customerName: c.customerName, status: c.status, endDate: c.endDate, daysToExpiry: c.daysToExpiry, autoRenew: c.autoRenew })),
    expiringContractsTotal: expiring.total,
    trends: {
      opened: delta(kpis.ticketsOpened, sumOf(previous, 'opened')),
      resolved: delta(kpis.ticketsResolved, sumOf(previous, 'resolved')),
      breaches: delta(kpis.slaBreaches, sumOf(previous, 'slaBreached')),
      slaCompliancePct: delta(kpis.slaCompliancePct, pct(pResMet, pResMet + pResBreached)),
      mttrMinutes: delta(kpis.mttrMinutes, weightedOf(previous, 'mttrMinutes', 'resolved')),
      outOfScope: delta(kpis.outOfScopeCount, sumOf(previous, 'outOfScope')),
      majorIncidents: delta(kpis.majorIncidents, sumOf(previous, 'major')),
    },
  };
}

// ---------------------------------------------------------------- NOC

export async function noc(ctx: Ctx) {
  ctx.require('dashboards:noc');
  const base = sql`t.domain <> 'soc'`;
  const openIncidents = await q<Row>(ctx, sql`
    SELECT pr.id, coalesce(pr.label, 'No priority') AS label, pr.key, pr.color, coalesce(pr.level, 99) AS level, count(*)::int AS count, count(*) FILTER (WHERE ${BREACHED})::int AS breached
    FROM tickets t LEFT JOIN config_options pr ON pr.id = t.priority_id WHERE ${base} AND t.type = 'incident' AND ${openCond()} GROUP BY pr.id, pr.label, pr.key, pr.color, pr.level ORDER BY level`);
  const totals = await one<Row>(ctx, sql`
    SELECT count(*)::int AS open, count(*) FILTER (WHERE t.type = 'incident')::int AS open_incidents, count(*) FILTER (WHERE ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk,
      count(*) FILTER (WHERE t.assignee_id IS NULL)::int AS unassigned, count(*) FILTER (WHERE t.is_major)::int AS major, count(*) FILTER (WHERE t.escalation_level > 0)::int AS escalated,
      count(*) FILTER (WHERE t.created_at >= current_date)::int AS opened_today
    FROM tickets t WHERE ${base} AND ${openCond()}`);
  const resolvedToday = await one<Row>(ctx, sql`SELECT count(*)::int AS n, round((avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60))::numeric)::int AS mttr FROM tickets t WHERE ${base} AND t.resolved_at >= current_date`);
  const criticalOpen = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`
    SELECT ${TICKET_LIST_COLS}, ci.name AS ci_name, ci.id AS ci_id FROM tickets t ${TICKET_LIST_JOINS} LEFT JOIN cis ci ON ci.id = t.primary_ci_id
    WHERE ${base} AND ${openCond()} AND (pr.level <= 2 OR t.is_major) ORDER BY pr.level NULLS LAST, t.created_at LIMIT 25`));
  const atRiskRows = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`
    SELECT ${TICKET_LIST_COLS} FROM tickets t ${TICKET_LIST_JOINS} WHERE ${base} AND ${openCond()} AND (${BREACHED} OR ${AT_RISK}) ORDER BY t.created_at LIMIT 100`));
  const slaList = atRiskRows.sort((a, b) => (a.sla?.remainingMinutes ?? 0) - (b.sla?.remainingMinutes ?? 0)).slice(0, 20);
  const unassigned = await q<Row>(ctx, sql`SELECT ${TICKET_LIST_COLS} FROM tickets t ${TICKET_LIST_JOINS} WHERE ${base} AND ${openCond()} AND t.assignee_id IS NULL ORDER BY pr.level NULLS LAST, t.created_at LIMIT 20`);
  const byCategory = await q<Row>(ctx, sql`
    SELECT cat.id, coalesce(cat.label, 'Uncategorized') AS label, cat.key, count(*)::int AS count, count(*) FILTER (WHERE ${BREACHED})::int AS breached
    FROM tickets t LEFT JOIN config_options cat ON cat.id = t.category_id WHERE ${base} AND ${openCond()} AND (cat.domain = 'noc' OR cat.id IS NULL) GROUP BY cat.id, cat.label, cat.key, cat.sort_order ORDER BY count DESC, cat.sort_order LIMIT 12`);
  const events = await q<Row>(ctx, sql`
    SELECT coalesce(e.severity, 'unknown') AS severity, count(*)::int AS count, count(*) FILTER (WHERE e.ticket_id IS NOT NULL)::int AS ticketed
    FROM integration_events e WHERE e.integration_type = 'prtg' AND e.received_at >= now() - interval '24 hours' GROUP BY 1 ORDER BY count DESC`);
  const workload = await q<Row>(ctx, sql`
    WITH ops AS (SELECT DISTINCT tm.user_id FROM team_members tm JOIN teams te ON te.id = tm.team_id WHERE te.team_type IN ('noc', 'infrastructure', 'network') AND te.is_active)
    SELECT u.id, u.name, count(t.id)::int AS open, count(t.id) FILTER (WHERE pr.level <= 2)::int AS critical, count(t.id) FILTER (WHERE ${BREACHED})::int AS breached, count(t.id) FILTER (WHERE t.updated_at < now() - interval '24 hours')::int AS stale,
      (SELECT string_agg(te.name, ', ' ORDER BY te.name) FROM team_members tm JOIN teams te ON te.id = tm.team_id WHERE tm.user_id = u.id AND te.team_type IN ('noc', 'infrastructure', 'network')) AS teams
    FROM users u LEFT JOIN tickets t ON t.assignee_id = u.id AND ${base} AND ${openCond()} LEFT JOIN config_options pr ON pr.id = t.priority_id
    WHERE u.status = 'active' AND u.user_type = 'msp' AND (u.id IN (SELECT user_id FROM ops) OR (NOT EXISTS (SELECT 1 FROM ops) AND t.id IS NOT NULL))
    GROUP BY u.id, u.name ORDER BY open DESC, u.name LIMIT 25`);
  const recentlyResolved = await q<Row>(ctx, sql`SELECT ${TICKET_LIST_COLS}, round(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60)::int AS mttr_minutes FROM tickets t ${TICKET_LIST_JOINS} WHERE ${base} AND t.resolved_at IS NOT NULL ORDER BY t.resolved_at DESC LIMIT 10`);
  const aging = await q<Row>(ctx, sql`SELECT ${AGE_BUCKET} AS bucket, count(*)::int AS count FROM tickets t WHERE ${base} AND ${openCond()} GROUP BY 1`);
  const order = ['< 4h', '4-24h', '1-3d', '> 3d'];
  return {
    generatedAt: new Date(),
    totals: { open: num(totals.open), openIncidents: num(totals.open_incidents), breached: num(totals.breached), atRisk: num(totals.at_risk), unassigned: num(totals.unassigned), major: num(totals.major), escalated: num(totals.escalated), openedToday: num(totals.opened_today), resolvedToday: num(resolvedToday.n), mttrTodayMinutes: resolvedToday.mttr === null || resolvedToday.mttr === undefined ? null : num(resolvedToday.mttr) },
    openIncidents,
    criticalOpen,
    slaAtRisk: { atRisk: num(totals.at_risk), breached: num(totals.breached), items: slaList },
    unassigned: { count: num(totals.unassigned), items: unassigned },
    byCategory,
    monitoringEvents24h: { total: events.reduce((s, e) => s + num(e.count), 0), ticketsCreated: events.reduce((s, e) => s + num(e.ticketed), 0), bySeverity: events },
    engineerWorkload: workload,
    recentlyResolved,
    aging: order.map((bucket) => ({ bucket, count: num(aging.find((a) => a.bucket === bucket)?.count) })),
  };
}

// ---------------------------------------------------------------- SOC

export async function soc(ctx: Ctx) {
  ctx.require('dashboards:soc');
  ctx.require('soc:read');
  const base = sql`t.domain = 'soc'`;
  const totals = await one<Row>(ctx, sql`
    SELECT count(*)::int AS open, count(*) FILTER (WHERE ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk, count(*) FILTER (WHERE t.escalation_level > 0)::int AS escalated,
      count(*) FILTER (WHERE t.assignee_id IS NULL)::int AS unassigned, count(*) FILTER (WHERE t.created_at >= current_date)::int AS opened_today, count(*) FILTER (WHERE sev.level <= 2)::int AS critical_high
    FROM tickets t LEFT JOIN config_options sev ON sev.id = t.security_severity_id WHERE ${base} AND ${openCond()}`);
  const bySeverity = await q<Row>(ctx, sql`
    SELECT sev.id, coalesce(sev.label, 'Unclassified') AS label, sev.key, sev.color, coalesce(sev.level, 99) AS level, count(*)::int AS count, count(*) FILTER (WHERE ${BREACHED})::int AS breached
    FROM tickets t LEFT JOIN config_options sev ON sev.id = t.security_severity_id WHERE ${base} AND ${openCond()} GROUP BY sev.id, sev.label, sev.key, sev.color, sev.level ORDER BY level`);
  const byCategory = await q<Row>(ctx, sql`
    SELECT cat.id, coalesce(cat.label, 'Uncategorized') AS label, cat.key, count(*)::int AS count FROM tickets t LEFT JOIN config_options cat ON cat.id = t.category_id
    WHERE ${base} AND ${openCond()} GROUP BY cat.id, cat.label, cat.key, cat.sort_order ORDER BY count DESC, cat.sort_order LIMIT 12`);
  const byCustomer = await q<Row>(ctx, sql`
    SELECT cu.id, cu.name, cu.code, count(*)::int AS open, count(*) FILTER (WHERE sev.level <= 2)::int AS critical_high, count(*) FILTER (WHERE ${BREACHED})::int AS breached
    FROM tickets t JOIN customers cu ON cu.id = t.customer_id LEFT JOIN config_options sev ON sev.id = t.security_severity_id WHERE ${base} AND ${openCond()} GROUP BY cu.id, cu.name, cu.code ORDER BY open DESC LIMIT 10`);
  const escalations = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`
    SELECT ${TICKET_LIST_COLS}, sev.label AS severity, sev.color AS severity_color FROM tickets t ${TICKET_LIST_JOINS} LEFT JOIN config_options sev ON sev.id = t.security_severity_id
    WHERE ${base} AND ${openCond()} AND t.escalation_level > 0 ORDER BY t.escalation_level DESC, t.created_at LIMIT 10`));
  const slaItems = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`
    SELECT ${TICKET_LIST_COLS}, sev.label AS severity, sev.color AS severity_color FROM tickets t ${TICKET_LIST_JOINS} LEFT JOIN config_options sev ON sev.id = t.security_severity_id
    WHERE ${base} AND ${openCond()} AND (${BREACHED} OR ${AT_RISK}) ORDER BY t.created_at LIMIT 100`));
  const siem = await q<Row>(ctx, sql`
    SELECT coalesce(e.severity, 'unknown') AS severity, count(*)::int AS count, count(*) FILTER (WHERE e.ticket_id IS NOT NULL)::int AS ticketed
    FROM integration_events e WHERE e.integration_type = 'fortisiem' AND e.received_at >= now() - interval '24 hours' GROUP BY 1 ORDER BY count DESC`);
  const recent = await q<Row>(ctx, sql`SELECT ${TICKET_LIST_COLS}, sev.label AS severity, sev.color AS severity_color FROM tickets t ${TICKET_LIST_JOINS} LEFT JOIN config_options sev ON sev.id = t.security_severity_id WHERE ${base} ORDER BY t.created_at DESC LIMIT 20`);
  const mttr = await one<Row>(ctx, sql`
    SELECT count(*)::int AS resolved, round((avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60))::numeric)::int AS mttr, round((avg(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at)) / 60))::numeric)::int AS response,
      (SELECT count(*)::int FROM tickets t2 WHERE t2.domain = 'soc' AND t2.created_at >= now() - interval '30 days') AS opened_30d
    FROM tickets t WHERE ${base} AND t.resolved_at >= now() - interval '30 days'`);
  return {
    generatedAt: new Date(),
    totals: { open: num(totals.open), breached: num(totals.breached), atRisk: num(totals.at_risk), escalated: num(totals.escalated), unassigned: num(totals.unassigned), openedToday: num(totals.opened_today), criticalHigh: num(totals.critical_high) },
    bySeverity,
    byCategory,
    byCustomer,
    slaStatus: { atRisk: num(totals.at_risk), breached: num(totals.breached), items: slaItems.sort((a, b) => (a.sla?.remainingMinutes ?? 0) - (b.sla?.remainingMinutes ?? 0)).slice(0, 20) },
    escalations: { count: num(totals.escalated), items: escalations },
    siemEvents24h: { total: siem.reduce((s, e) => s + num(e.count), 0), ticketsCreated: siem.reduce((s, e) => s + num(e.ticketed), 0), bySeverity: siem },
    recent,
    mttrSecurity30d: { resolved: num(mttr.resolved), opened: num(mttr.opened_30d), mttrMinutes: mttr.mttr === null || mttr.mttr === undefined ? null : num(mttr.mttr), responseMinutes: mttr.response === null || mttr.response === undefined ? null : num(mttr.response) },
  };
}

// ---------------------------------------------------------------- engineer (my work)

export async function engineer(ctx: Ctx) {
  if (isCustomerUser(ctx)) throw new ForbiddenError('The engineer dashboard is available to MSP users');
  const me = ctx.user.id;
  const teamIds = ctx.user.teams.map((t) => t.id);
  const soc = socCond(ctx);
  const mine = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`SELECT ${TICKET_LIST_COLS}, t.due_at FROM tickets t ${TICKET_LIST_JOINS} WHERE t.assignee_id = ${me}::uuid AND ${openCond()} ${soc} ORDER BY pr.level NULLS LAST, t.created_at LIMIT 100`));
  const byPriority = new Map<string, { label: string; color: string | null; level: number; count: number }>();
  for (const t of mine) {
    const k = String(t.priority ?? 'No priority');
    const v = byPriority.get(k) ?? { label: k, color: (t.priority_color as string | null) ?? null, level: num(t.priority_level) || 99, count: 0 };
    v.count++;
    byPriority.set(k, v);
  }
  const dueSoon = [...mine].filter((t) => t.sla && t.sla.state !== 'paused').sort((a, b) => (a.sla?.remainingMinutes ?? 0) - (b.sla?.remainingMinutes ?? 0)).slice(0, 10);
  const teamQueues = teamIds.length
    ? await q<Row>(ctx, sql`
      SELECT te.id, te.name, count(t.id) FILTER (WHERE t.assignee_id IS NULL)::int AS unassigned, count(t.id)::int AS open, count(t.id) FILTER (WHERE ${BREACHED})::int AS breached
      FROM teams te LEFT JOIN tickets t ON t.assigned_team_id = te.id AND ${openCond()} ${soc} WHERE te.id = ANY(ARRAY[${sql.join(teamIds.map((id) => sql`${id}::uuid`), sql`, `)}]) GROUP BY te.id, te.name ORDER BY te.name`)
    : [];
  const todayRows = await q<Row>(ctx, sql`SELECT ${TICKET_LIST_COLS}, t.due_at FROM tickets t ${TICKET_LIST_JOINS} WHERE t.assignee_id = ${me}::uuid AND ${openCond()} AND t.due_at >= current_date AND t.due_at < current_date + 1 ${soc} ORDER BY t.due_at LIMIT 20`);
  const visits = await q<Row>(ctx, sql`
    SELECT v.id, v.number, v.title, v.status, v.scheduled_start, v.scheduled_end, cu.name AS customer_name, si.name AS site_name FROM field_visits v LEFT JOIN customers cu ON cu.id = v.customer_id LEFT JOIN sites si ON si.id = v.site_id
    WHERE (v.engineer_id = ${me}::uuid OR ${me}::uuid = ANY(v.additional_engineer_ids)) AND v.status IN ('requested', 'scheduled', 'in_progress') AND v.scheduled_start >= current_date AND v.scheduled_start < current_date + 1 ORDER BY v.scheduled_start LIMIT 20`);
  const pmToday = await q<Row>(ctx, sql`
    SELECT o.id, p.name AS program, cu.name AS customer_name, o.status, o.planned_date, o.scheduled_date FROM pm_occurrences o JOIN pm_programs p ON p.id = o.program_id LEFT JOIN customers cu ON cu.id = o.customer_id
    WHERE coalesce(o.engineer_id, p.assigned_engineer_id) = ${me}::uuid AND o.status IN ('planned', 'scheduled') AND coalesce(o.scheduled_date, o.planned_date) = current_date ORDER BY p.name LIMIT 20`);
  const tasks = await q<Row>(ctx, sql`
    SELECT k.id, k.title, k.status, k.due_at, t.id AS ticket_id, t.number AS ticket_number, t.title AS ticket_title FROM ticket_tasks k JOIN tickets t ON t.id = k.ticket_id
    WHERE k.assignee_id = ${me}::uuid AND k.status NOT IN ('done', 'completed', 'cancelled') ${soc} ORDER BY k.due_at NULLS LAST, k.created_at LIMIT 20`);
  const approvals = await one<Row>(ctx, sql`SELECT count(*)::int AS n FROM approvals a WHERE a.status = 'pending' AND (a.approver_user_id = ${me}::uuid ${teamIds.length ? sql`OR a.approver_team_id = ANY(ARRAY[${sql.join(teamIds.map((id) => sql`${id}::uuid`), sql`, `)}])` : EMPTY})`);
  const activity = await one<Row>(ctx, sql`
    SELECT (SELECT count(*)::int FROM ticket_comments c WHERE c.author_id = ${me}::uuid AND c.created_at >= current_date) AS comments,
      (SELECT coalesce(sum(te.minutes), 0)::int FROM time_entries te WHERE te.user_id = ${me}::uuid AND te.created_at >= current_date) AS minutes,
      (SELECT count(*)::int FROM tickets t WHERE t.assignee_id = ${me}::uuid AND t.resolved_at >= current_date) AS resolved,
      (SELECT count(*)::int FROM tickets t WHERE t.assignee_id = ${me}::uuid AND ${openCond()} AND ${BREACHED}) AS breached`);
  const serviceIds = [...new Set(mine.map((t) => t.service_id).filter((x): x is string => typeof x === 'string'))];
  const myServices = await q<{ service_id: string }>(ctx, sql`SELECT DISTINCT t.service_id FROM tickets t WHERE t.assignee_id = ${me}::uuid AND ${openCond()} AND t.service_id IS NOT NULL LIMIT 50`);
  const svcIds = [...new Set([...serviceIds, ...myServices.map((s) => s.service_id)])];
  const knowledge = await q<Row>(ctx, sql`
    SELECT a.id, a.number, a.title, a.article_type, a.published_at, s.name AS service_name FROM kb_articles a LEFT JOIN services s ON s.id = a.service_id
    WHERE a.status = 'published' ${svcIds.length ? sql`AND (a.service_id = ANY(ARRAY[${sql.join(svcIds.map((id) => sql`${id}::uuid`), sql`, `)}]) OR a.service_id IS NULL)` : EMPTY}
    ORDER BY (a.service_id IS NOT NULL) DESC, a.published_at DESC NULLS LAST LIMIT 5`);
  const watched = await q<Row>(ctx, sql`
    SELECT ${TICKET_LIST_COLS} FROM ticket_watchers w JOIN tickets t ON t.id = w.ticket_id ${TICKET_LIST_JOINS}
    WHERE w.user_id = ${me}::uuid AND t.last_activity_at >= now() - interval '24 hours' ${soc} ORDER BY t.last_activity_at DESC LIMIT 10`);
  return {
    generatedAt: new Date(),
    assigned: { total: mine.length, byPriority: [...byPriority.values()].sort((a, b) => a.level - b.level), breached: mine.filter((t) => t.sla?.breached).length, items: mine.slice(0, 25), dueSoon },
    teamQueues,
    today: { dueTickets: todayRows, visits, pmOccurrences: pmToday, tasks },
    approvalsPending: num(approvals.n),
    activity: { comments: num(activity.comments), minutes: num(activity.minutes), resolved: num(activity.resolved), breachedAssigned: num(activity.breached) },
    knowledge,
    watched,
  };
}

// ---------------------------------------------------------------- customer

export async function customer(ctx: Ctx, opts: { customerId?: string | null } = {}) {
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
  const cust = sql`t.customer_id = ${customerId}::uuid`;
  const [info] = await q<Row>(ctx, sql`SELECT c.id, c.name, c.code, c.timezone, c.account_manager_id, am.name AS account_manager_name, am.email AS account_manager_email, am.phone AS account_manager_phone FROM customers c LEFT JOIN users am ON am.id = c.account_manager_id WHERE c.id = ${customerId}::uuid`);
  const open = await q<Row>(ctx, sql`SELECT st.status_category AS category, count(*)::int AS count FROM tickets t JOIN config_options st ON st.id = t.status_id WHERE ${cust} AND ${openCond()} GROUP BY 1`);
  const byPriority = await q<Row>(ctx, sql`SELECT coalesce(pr.label, 'No priority') AS label, pr.color, coalesce(pr.level, 99) AS level, count(*)::int AS count FROM tickets t LEFT JOIN config_options pr ON pr.id = t.priority_id WHERE ${cust} AND ${openCond()} GROUP BY 1, 2, 3 ORDER BY 3`);
  const byType = await q<Row>(ctx, sql`SELECT t.type, count(*)::int AS count FROM tickets t WHERE ${cust} AND ${openCond()} GROUP BY 1`);
  const counts = await one<Row>(ctx, sql`
    SELECT count(*) FILTER (WHERE ${openCond()})::int AS open, count(*) FILTER (WHERE ${openCond()} AND st.key = 'pending_customer')::int AS awaiting_reply, count(*) FILTER (WHERE ${openCond()} AND st.key = 'awaiting_approval')::int AS awaiting_approval,
      count(*) FILTER (WHERE t.resolved_at >= now() - interval '30 days')::int AS resolved_30d, count(*) FILTER (WHERE t.created_at >= now() - interval '30 days')::int AS opened_30d, count(*) FILTER (WHERE ${openCond()} AND t.is_major)::int AS major_open
    FROM tickets t JOIN config_options st ON st.id = t.status_id WHERE ${cust} AND (${openCond()} OR t.created_at >= now() - interval '30 days' OR t.resolved_at >= now() - interval '30 days')`);
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const d90 = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const [sla30, sla90] = [await slaCompliance(ctx, { customerId, from: d30, groupBy: 'priority' }), await slaCompliance(ctx, { customerId, from: d90, groupBy: 'priority' })];
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
  const openTotal = num(counts.open);
  return {
    generatedAt: now,
    customer: info ? { id: info.id, name: info.name, code: info.code, timezone: info.timezone } : { id: customerId, name: '', code: '', timezone: 'UTC' },
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
    sla: { days30: { totals: sla30.totals, groups: sla30.groups }, days90: { totals: sla90.totals, groups: sla90.groups } },
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

export async function amc(ctx: Ctx) {
  ctx.require('dashboards:amc');
  const base = sql`t.domain = 'amc'`;
  const totals = await one<Row>(ctx, sql`
    SELECT count(*)::int AS open, count(*) FILTER (WHERE t.assignee_id IS NULL)::int AS unassigned, count(*) FILTER (WHERE ${BREACHED})::int AS breached,
      count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk, count(*) FILTER (WHERE t.due_at >= current_date AND t.due_at < current_date + 1)::int AS due_today,
      count(*) FILTER (WHERE st.key = 'pending_customer')::int AS awaiting_customer, count(*) FILTER (WHERE t.created_at >= current_date)::int AS opened_today
    FROM tickets t JOIN config_options st ON st.id = t.status_id WHERE ${base} AND ${openCond()}`);
  const resolved = await one<Row>(ctx, sql`SELECT count(*) FILTER (WHERE t.resolved_at >= date_trunc('week', now()))::int AS week, count(*) FILTER (WHERE t.resolved_at >= current_date)::int AS today FROM tickets t WHERE ${base} AND t.resolved_at IS NOT NULL AND t.resolved_at >= date_trunc('week', now())`);
  const queue = await withSla(ctx, await q<Row & { id: string }>(ctx, sql`
    SELECT ${TICKET_LIST_COLS}, st.key AS status_key, si.name AS site_name, t.due_at, (t.due_at >= current_date AND t.due_at < current_date + 1) AS due_today,
      v.number AS visit_number, v.id AS visit_id
    FROM tickets t ${TICKET_LIST_JOINS} LEFT JOIN sites si ON si.id = t.site_id
    LEFT JOIN LATERAL (SELECT fv.id, fv.number FROM field_visits fv WHERE fv.ticket_id = t.id ORDER BY fv.created_at DESC LIMIT 1) v ON true
    WHERE ${base} AND ${openCond()} ORDER BY pr.level NULLS LAST, t.created_at LIMIT 200`));
  const visitsWeek = await one<Row>(ctx, sql`
    SELECT count(*)::int AS n FROM field_visits v WHERE v.status IN ('scheduled', 'in_progress') AND v.scheduled_start >= date_trunc('week', now()) AND v.scheduled_start < date_trunc('week', now()) + interval '7 days'`);
  const visits = await q<Row>(ctx, sql`
    SELECT v.id, v.number, v.title, v.status, v.scheduled_start, v.scheduled_end, cu.name AS customer_name, si.name AS site_name, u.name AS engineer, t.number AS ticket_number, t.id AS ticket_id
    FROM field_visits v LEFT JOIN customers cu ON cu.id = v.customer_id LEFT JOIN sites si ON si.id = v.site_id LEFT JOIN users u ON u.id = v.engineer_id LEFT JOIN tickets t ON t.id = v.ticket_id
    WHERE v.status IN ('requested', 'scheduled', 'in_progress') AND coalesce(v.scheduled_start, now()) >= now() - interval '1 day' AND coalesce(v.scheduled_start, now()) < date_trunc('week', now()) + interval '14 days'
    ORDER BY (v.status = 'in_progress') DESC, v.scheduled_start NULLS LAST LIMIT 12`);
  const maintenance = await q<Row>(ctx, sql`
    SELECT o.id, p.name AS program, cu.name AS customer_name, si.name AS site, coalesce(o.scheduled_date, o.planned_date) AS due_date, o.status,
      (coalesce(o.scheduled_date, o.planned_date) < current_date) AS overdue, u.name AS engineer
    FROM pm_occurrences o JOIN pm_programs p ON p.id = o.program_id LEFT JOIN customers cu ON cu.id = o.customer_id LEFT JOIN sites si ON si.id = p.site_id LEFT JOIN users u ON u.id = coalesce(o.engineer_id, p.assigned_engineer_id)
    WHERE o.status IN ('planned', 'scheduled', 'rescheduled') AND coalesce(o.scheduled_date, o.planned_date) <= current_date + 14 ORDER BY coalesce(o.scheduled_date, o.planned_date) LIMIT 10`);
  const ents = ctx.can('contracts:read') ? await entitlementSummary(ctx, undefined, 500) : { total: 0, overThreshold: 0, exhausted: 0, items: [] };
  const entitlements = ents.items.filter((i) => (i.unit === 'visits' || i.unit === 'hours') && (i.utilization.pct >= 80 || i.utilization.exhausted)).slice(0, 6);
  return {
    generatedAt: new Date(),
    kpis: {
      open: num(totals.open),
      unassigned: num(totals.unassigned),
      breached: num(totals.breached),
      atRisk: num(totals.at_risk),
      dueToday: num(totals.due_today),
      awaitingCustomer: num(totals.awaiting_customer),
      openedToday: num(totals.opened_today),
      resolvedThisWeek: num(resolved.week),
      resolvedToday: num(resolved.today),
      visitsThisWeek: num(visitsWeek.n),
    },
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
  };
}
