import { sql, and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { ForbiddenError } from '@/core/errors';
import { schema } from '@/db/client';
import { currentAndNext, type ShiftInstance } from '@/modules/handover/shifts';
import { visibleAnnouncements } from '@/modules/status/announcements';
import { entitlementSummary } from '@/modules/contracts/entitlements';
import { expiringContracts } from '@/modules/contracts/service';
import { csatFigures, hidesSoc } from '@/modules/surveys/figures';
import { loadSurveyDefaults } from '@/modules/surveys/policy';
import { arrivalHeatmap, backlogAgeing, responsiveness, changeOutcomes, scopeTimezone } from '@/modules/reports/analytics';
import { q, one, num, pct, isCustomerUser, openCond, custCond, socCond, BREACHED, AT_RISK, EMPTY, delta, toDay, addDays, clampDays, arrivalsWeek, attentionByCustomer, accountCounts } from './common';
import { nocTotals, socTotals, amcTotals, type NocTotals, type SocTotals, type AmcTotals } from './totals';

/**
 * The Overview every staff member lands on. One payload, scoped to the
 * caller's permissions: `me` (shift, my day, my queue by type) for everyone,
 * the announcements aimed at staff, the upcoming work the person may see,
 * the desk's health for the period (only with `tickets:read`), the
 * operations strips (each only with its dashboard permission, computed by
 * the same totals the dedicated dashboard shows) and the management extras
 * (only with `dashboards:management`). Every number that links is counted
 * live under the caller's fences (customer scope, security fence) with
 * exactly the predicates its link carries; the daily series draws the charts
 * and the deltas only.
 */

type Row = Record<string, unknown>;

const shiftView = (i: ShiftInstance<typeof schema.teamShifts.$inferSelect> | null) => (i ? { id: i.shift.id, name: i.shift.name, timezone: i.shift.timezone, shiftDate: i.shiftDate, startsAt: i.startsAt, endsAt: i.endsAt } : null);

/** The shift running now in one of the person's teams (their teams in order; the first with a shift running, else the first with one coming). */
async function myShift(ctx: Ctx, at: Date) {
  const teamIds = ctx.user.teams.map((t) => t.id);
  if (!teamIds.length) return null;
  const shifts = await ctx.tx.select().from(schema.teamShifts).where(and(inArray(schema.teamShifts.teamId, teamIds), eq(schema.teamShifts.isActive, true)));
  let fallback: { teamId: string; teamName: string; current: ReturnType<typeof shiftView>; next: ReturnType<typeof shiftView> } | null = null;
  for (const team of ctx.user.teams) {
    const own = shifts.filter((s) => s.teamId === team.id);
    if (!own.length) continue;
    const { current, next } = currentAndNext(own, at);
    const entry = { teamId: team.id, teamName: team.name, current: shiftView(current), next: shiftView(next) };
    if (current) return entry;
    fallback ??= entry;
  }
  return fallback;
}

export interface UpcomingItem {
  kind: 'visit' | 'maintenance' | 'cab' | 'change';
  id: string;
  title: string;
  subtitle: string | null;
  customerName: string | null;
  status: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  /** The day (YYYY-MM-DD) for items without a time (a maintenance occurrence). */
  day: string | null;
  href: string;
}

/** Visits, maintenance occurrences, CAB meetings and change windows today and tomorrow, each under its own permission (or the person's own when they lack it). */
async function upcoming(ctx: Ctx, customerId: string | null) {
  const me = ctx.user.id;
  const soc = socCond(ctx);
  const items: UpcomingItem[] = [];
  const dayOf = (v: unknown) => (v ? String(v).slice(0, 10) : null);
  const asDate = (v: unknown): Date | null => (v ? (v instanceof Date ? v : new Date(String(v))) : null);

  const ownVisits = !ctx.can('field:read', customerId);
  const visits = await q<Row>(ctx, sql`
    SELECT v.id, v.number, v.title, v.status, v.scheduled_start, v.scheduled_end, cu.name AS customer_name, si.name AS site_name, u.name AS engineer
    FROM field_visits v LEFT JOIN customers cu ON cu.id = v.customer_id LEFT JOIN sites si ON si.id = v.site_id LEFT JOIN users u ON u.id = v.engineer_id
    WHERE v.status IN ('requested', 'scheduled', 'in_progress') AND v.scheduled_start >= current_date AND v.scheduled_start < current_date + 2 ${custCond(customerId, sql`v.customer_id`)}
      ${ownVisits ? sql`AND (v.engineer_id = ${me}::uuid OR ${me}::uuid = ANY(v.additional_engineer_ids))` : EMPTY}
    ORDER BY v.scheduled_start LIMIT 12`);
  for (const v of visits) items.push({ kind: 'visit', id: String(v.id), title: `${String(v.number)} ${String(v.title)}`, subtitle: [v.site_name, v.engineer].filter(Boolean).map(String).join(' · ') || null, customerName: (v.customer_name as string | null) ?? null, status: String(v.status), startsAt: asDate(v.scheduled_start), endsAt: asDate(v.scheduled_end), day: dayOf(v.scheduled_start), href: `/field/${String(v.id)}` });

  const ownPm = !ctx.can('pm:read', customerId);
  const pm = await q<Row>(ctx, sql`
    SELECT o.id, p.name AS program, cu.name AS customer_name, si.name AS site_name, o.status, coalesce(o.scheduled_date, o.planned_date)::text AS due_date, u.name AS engineer
    FROM pm_occurrences o JOIN pm_programs p ON p.id = o.program_id LEFT JOIN customers cu ON cu.id = o.customer_id LEFT JOIN sites si ON si.id = p.site_id LEFT JOIN users u ON u.id = coalesce(o.engineer_id, p.assigned_engineer_id)
    WHERE o.status IN ('planned', 'scheduled', 'rescheduled') AND coalesce(o.scheduled_date, o.planned_date) BETWEEN current_date AND current_date + 1 ${custCond(customerId, sql`o.customer_id`)}
      ${ownPm ? sql`AND coalesce(o.engineer_id, p.assigned_engineer_id) = ${me}::uuid` : EMPTY}
    ORDER BY coalesce(o.scheduled_date, o.planned_date), p.name LIMIT 12`);
  for (const o of pm) items.push({ kind: 'maintenance', id: String(o.id), title: String(o.program), subtitle: [o.site_name, o.engineer].filter(Boolean).map(String).join(' · ') || null, customerName: (o.customer_name as string | null) ?? null, status: String(o.status), startsAt: null, endsAt: null, day: String(o.due_date), href: '/maintenance' });

  const canCab = ctx.can('changes:cab') || ctx.can('changes:approve') || ctx.can('changes:manage');
  const cab = canCab
    ? await q<Row>(ctx, sql`
      SELECT m.id, m.title, m.scheduled_at, m.status, m.location, u.name AS chair, (SELECT count(*)::int FROM cab_meeting_items i WHERE i.meeting_id = m.id) AS items
      FROM cab_meetings m LEFT JOIN users u ON u.id = m.chair_user_id
      WHERE m.status IN ('scheduled', 'in_progress') AND m.scheduled_at >= current_date AND m.scheduled_at < current_date + 2
        ${customerId ? sql`AND EXISTS (SELECT 1 FROM cab_meeting_items i WHERE i.meeting_id = m.id AND i.customer_id = ${customerId}::uuid)` : EMPTY}
      ORDER BY m.scheduled_at LIMIT 12`)
    : [];
  for (const m of cab) items.push({ kind: 'cab', id: String(m.id), title: String(m.title), subtitle: [m.chair ? `Chair ${String(m.chair)}` : null, `${num(m.items)} change${num(m.items) === 1 ? '' : 's'}`].filter(Boolean).join(' · '), customerName: null, status: String(m.status), startsAt: asDate(m.scheduled_at), endsAt: null, day: dayOf(m.scheduled_at), href: `/operations/cab/${String(m.id)}` });

  const changes = ctx.can('tickets:read', customerId)
    ? await q<Row>(ctx, sql`
      SELECT t.id, t.number, t.title, cd.change_type, cd.risk_level, cd.scheduled_start, cd.scheduled_end, cu.name AS customer_name, st.label AS status
      FROM tickets t JOIN change_details cd ON cd.ticket_id = t.id JOIN config_options st ON st.id = t.status_id LEFT JOIN customers cu ON cu.id = t.customer_id
      WHERE t.type = 'change' AND ${openCond()} AND cd.scheduled_start >= current_date AND cd.scheduled_start < current_date + 2 ${soc} ${custCond(customerId)}
      ORDER BY cd.scheduled_start LIMIT 12`)
    : [];
  for (const c of changes) items.push({ kind: 'change', id: String(c.id), title: `${String(c.number)} ${String(c.title)}`, subtitle: [c.change_type ? `${String(c.change_type)} change` : null, c.risk_level ? `${String(c.risk_level)} risk` : null].filter(Boolean).join(' · ') || null, customerName: (c.customer_name as string | null) ?? null, status: (c.status as string | null) ?? null, startsAt: asDate(c.scheduled_start), endsAt: asDate(c.scheduled_end), day: dayOf(c.scheduled_start), href: `/tickets/${String(c.id)}` });

  const key = (i: UpcomingItem) => (i.startsAt ? i.startsAt.getTime() : i.day ? Date.parse(`${i.day}T00:00:00Z`) : 0);
  items.sort((a, b) => key(a) - key(b));
  return {
    counts: { visits: visits.length, maintenance: pm.length, cab: cab.length, changes: changes.length },
    items: items.slice(0, 12),
  };
}

const DIMENSIONS = {
  team: { id: sql`tm.id`, label: sql`coalesce(tm.name, 'No team')`, join: sql`LEFT JOIN teams tm ON tm.id = t.assigned_team_id` },
  engineer: { id: sql`asg.id`, label: sql`coalesce(asg.name, 'Unassigned')`, join: sql`LEFT JOIN users asg ON asg.id = t.assignee_id` },
  service: { id: sql`sv.id`, label: sql`coalesce(sv.name, 'No service')`, join: sql`LEFT JOIN services sv ON sv.id = t.service_id` },
  customer: { id: sql`cu.id`, label: sql`coalesce(cu.name, 'No customer')`, join: sql`LEFT JOIN customers cu ON cu.id = t.customer_id` },
  category: { id: sql`cat.id`, label: sql`coalesce(cat.label, 'Uncategorised')`, join: sql`LEFT JOIN config_options cat ON cat.id = t.category_id` },
} as const;
export type LoadDimension = keyof typeof DIMENSIONS;

export interface LoadRow {
  id: string | null;
  label: string;
  open: number;
  breached: number;
  atRisk: number;
}

/** Open tickets now grouped by one dimension (the "who carries the load" panel), the shared SLA vocabulary on each row, largest first; every row, so the web can fold the tail into a true "Other". */
export async function openLoad(ctx: Ctx, by: LoadDimension, cond: ReturnType<typeof sql>): Promise<LoadRow[]> {
  const dim = DIMENSIONS[by];
  const rows = await q<Row>(ctx, sql`
    SELECT ${dim.id}::text AS id, ${dim.label} AS label, count(*)::int AS open, count(*) FILTER (WHERE ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk
    FROM tickets t ${dim.join} WHERE ${openCond()} ${cond} GROUP BY 1, 2 ORDER BY open DESC, label`);
  return rows.map((r) => ({ id: r.id === null || r.id === undefined ? null : String(r.id), label: String(r.label), open: num(r.open), breached: num(r.breached), atRisk: num(r.at_risk) }));
}

/** Opened, resolved, breaches and resolution clocks met or breached per day for one slice (live, fenced like the tiles); every day of [from, to] is present. */
async function deskSeries(ctx: Ctx, from: string, to: string, cond: ReturnType<typeof sql>) {
  const win = (col: ReturnType<typeof sql>) => sql`${col} >= ${from}::date AND ${col} < ${to}::date + interval '1 day'`;
  const rows = await q<Row>(ctx, sql`
    WITH d AS (SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day),
    o AS (SELECT t.created_at::date AS day, count(*)::int AS opened FROM tickets t WHERE ${win(sql`t.created_at`)} ${cond} GROUP BY 1),
    r AS (SELECT t.resolved_at::date AS day, count(*)::int AS resolved FROM tickets t WHERE ${win(sql`t.resolved_at`)} ${cond} GROUP BY 1),
    b AS (SELECT s.breached_at::date AS day, count(*)::int AS breaches, count(*) FILTER (WHERE s.metric = 'resolution')::int AS res_breached FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id WHERE s.state = 'breached' AND ${win(sql`s.breached_at`)} ${cond} GROUP BY 1),
    m AS (SELECT s.completed_at::date AS day, count(*)::int AS res_met FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id WHERE s.state = 'met' AND s.metric = 'resolution' AND ${win(sql`s.completed_at`)} ${cond} GROUP BY 1)
    SELECT d.day::text AS day, coalesce(o.opened, 0) AS opened, coalesce(r.resolved, 0) AS resolved, coalesce(b.breaches, 0) AS breaches, coalesce(b.res_breached, 0) AS res_breached, coalesce(m.res_met, 0) AS res_met
    FROM d LEFT JOIN o ON o.day = d.day LEFT JOIN r ON r.day = d.day LEFT JOIN b ON b.day = d.day LEFT JOIN m ON m.day = d.day ORDER BY d.day`);
  return rows.map((r) => ({ day: String(r.day), opened: num(r.opened), resolved: num(r.resolved), breaches: num(r.breaches), resolutionMet: num(r.res_met), resolutionBreached: num(r.res_breached), compliancePct: pct(num(r.res_met), num(r.res_met) + num(r.res_breached)) }));
}

export async function overview(ctx: Ctx, opts: { days?: number; customerId?: string | null } = {}) {
  if (isCustomerUser(ctx)) throw new ForbiddenError('The overview is for MSP users; the portal home is the customer dashboard');
  const customerId = opts.customerId ?? null;
  if (customerId) ctx.requireCustomer(customerId);
  const days = clampDays(opts.days);
  const now = new Date();
  const today = toDay(now);
  const from = addDays(today, -(days - 1));
  const prevFrom = addDays(from, -days);
  const prevTo = addDays(from, -1);
  const me = ctx.user.id;
  const cust = custCond(customerId);
  const soc = socCond(ctx);
  const fence = sql`${cust} ${soc}`;
  const timezone = await scopeTimezone(ctx, customerId);
  const period = { days, from, to: today, previousFrom: prevFrom, previousTo: prevTo };

  // ---- me: the person's own work, always (their tickets are theirs to see; the security fence still applies)
  const mineCond = sql`t.assignee_id = ${me}::uuid ${fence}`;
  const mine = await one<Row>(ctx, sql`
    SELECT count(*) FILTER (WHERE ${openCond()})::int AS assigned, count(*) FILTER (WHERE ${openCond()} AND ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${openCond()} AND ${AT_RISK})::int AS at_risk,
      count(*) FILTER (WHERE ${openCond()} AND t.due_at >= current_date AND t.due_at < current_date + 1)::int AS due_today, count(*) FILTER (WHERE t.resolved_at >= current_date)::int AS resolved_today
    FROM tickets t WHERE ${mineCond} AND (${openCond()} OR t.resolved_at >= current_date)`);
  const myTypes = await q<Row>(ctx, sql`SELECT t.type, count(*)::int AS count FROM tickets t WHERE ${mineCond} AND ${openCond()} GROUP BY 1 ORDER BY 2 DESC, 1`);
  const teamIds = ctx.user.teams.map((t) => t.id);
  const approvals = await one<Row>(ctx, sql`SELECT count(*)::int AS n FROM approvals a WHERE a.status = 'pending' AND (a.approver_user_id = ${me}::uuid ${teamIds.length ? sql`OR a.approver_team_id = ANY(ARRAY[${sql.join(teamIds.map((id) => sql`${id}::uuid`), sql`, `)}])` : EMPTY})`);
  const shift = await myShift(ctx, now);

  // ---- announcements aimed at staff
  const announcements = (await visibleAnnouncements(ctx.tx, { staff: true, customerId: null, now, limit: 5 })).map((a) => ({ id: a.id, title: a.title, body: a.body, type: a.type, pinned: a.pinned, startsAt: a.startsAt, endsAt: a.endsAt, sourceTicket: a.sourceTicket }));

  const upcomingWork = await upcoming(ctx, customerId);

  // ---- desk health (tickets:read): every linking number counted live under the caller's fences
  let desk: Record<string, unknown> | null = null;
  if (ctx.can('tickets:read', customerId)) {
    const inRange = (col: ReturnType<typeof sql>, f: string, t: string) => sql`${col} >= ${f}::date AND ${col} < ${t}::date + interval '1 day'`;
    const live = await one<Row>(ctx, sql`
      SELECT count(*) FILTER (WHERE ${openCond()})::int AS open, count(*) FILTER (WHERE ${openCond()} AND ${BREACHED})::int AS breached, count(*) FILTER (WHERE ${openCond()} AND ${AT_RISK})::int AS at_risk,
        count(*) FILTER (WHERE ${openCond()} AND t.assignee_id IS NULL)::int AS unassigned, count(*) FILTER (WHERE ${openCond()} AND t.is_major)::int AS major,
        count(*) FILTER (WHERE ${inRange(sql`t.created_at`, from, today)})::int AS opened_period, count(*) FILTER (WHERE ${inRange(sql`t.resolved_at`, from, today)})::int AS resolved_period,
        count(*) FILTER (WHERE ${inRange(sql`t.created_at`, prevFrom, prevTo)})::int AS opened_previous, count(*) FILTER (WHERE ${inRange(sql`t.resolved_at`, prevFrom, prevTo)})::int AS resolved_previous,
        count(*) FILTER (WHERE t.created_at < ${from}::date AND (t.resolved_at IS NULL OR t.resolved_at >= ${from}::date) AND (t.closed_at IS NULL OR t.closed_at >= ${from}::date))::int AS open_at_start,
        count(*) FILTER (WHERE t.created_at >= current_date)::int AS opened_today
      FROM tickets t WHERE (${openCond()} OR t.created_at >= ${prevFrom}::date OR t.resolved_at >= ${prevFrom}::date OR t.closed_at >= ${prevFrom}::date OR (t.resolved_at IS NULL AND t.closed_at IS NULL)) ${fence}`);
    // Resolution clocks met or breached in the period (compliance) and every clock breached in the period (the breaches delta), this period and the previous one.
    const sla = await one<Row>(ctx, sql`
      SELECT count(*) FILTER (WHERE s.metric = 'resolution' AND s.state = 'met' AND ${inRange(sql`s.completed_at`, from, today)})::int AS met, count(*) FILTER (WHERE s.metric = 'resolution' AND s.state = 'breached' AND ${inRange(sql`s.breached_at`, from, today)})::int AS breached,
        count(*) FILTER (WHERE s.metric = 'resolution' AND s.state = 'met' AND ${inRange(sql`s.completed_at`, prevFrom, prevTo)})::int AS met_previous, count(*) FILTER (WHERE s.metric = 'resolution' AND s.state = 'breached' AND ${inRange(sql`s.breached_at`, prevFrom, prevTo)})::int AS breached_previous,
        count(*) FILTER (WHERE s.state = 'breached' AND ${inRange(sql`s.breached_at`, from, today)})::int AS breaches, count(*) FILTER (WHERE s.state = 'breached' AND ${inRange(sql`s.breached_at`, prevFrom, prevTo)})::int AS breaches_previous
      FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id WHERE (s.completed_at >= ${prevFrom}::date OR s.breached_at >= ${prevFrom}::date) ${fence}`);
    const series = await deskSeries(ctx, from, today, fence);
    const byType = await q<Row>(ctx, sql`SELECT t.type, count(*)::int AS count, count(*) FILTER (WHERE ${BREACHED})::int AS breached FROM tickets t WHERE ${openCond()} ${fence} GROUP BY 1 ORDER BY 2 DESC, 1`);
    const ageing = await backlogAgeing(ctx, { customerId }, now);
    const arrivals = { timezone, week: await arrivalsWeek(ctx, fence, { from, to: today, timezone }), pattern: { from, to: today, cells: await arrivalHeatmap(ctx, { customerId, from, to: today, timezone }) } };
    const breakdowns = {
      team: await openLoad(ctx, 'team', fence),
      engineer: await openLoad(ctx, 'engineer', fence),
      service: await openLoad(ctx, 'service', fence),
      customer: await openLoad(ctx, 'customer', fence),
      category: await openLoad(ctx, 'category', fence),
    };
    const byPriority = await responsiveness(ctx, { customerId, from, to: today });
    const changes = await one<Row>(ctx, sql`SELECT count(*)::int AS open FROM tickets t WHERE t.type = 'change' AND ${openCond()} ${fence}`);
    const outcomes = await changeOutcomes(ctx, { customerId, from, to: today });
    const compliance = pct(num(sla.met), num(sla.met) + num(sla.breached));
    const compliancePrevious = pct(num(sla.met_previous), num(sla.met_previous) + num(sla.breached_previous));
    desk = {
      kpis: {
        open: num(live.open),
        breached: num(live.breached),
        atRisk: num(live.at_risk),
        unassigned: num(live.unassigned),
        major: num(live.major),
        openedInPeriod: num(live.opened_period),
        resolvedInPeriod: num(live.resolved_period),
        openedToday: num(live.opened_today),
        slaCompliancePct: compliance,
        resolutionMet: num(sla.met),
        resolutionBreached: num(sla.breached),
      },
      /** Period-over-period movement: open against the backlog at the start of the period, the period counts against the previous period. */
      deltas: {
        open: delta(num(live.open), num(live.open_at_start)),
        openedInPeriod: delta(num(live.opened_period), num(live.opened_previous)),
        resolvedInPeriod: delta(num(live.resolved_period), num(live.resolved_previous)),
        slaCompliancePct: delta(compliance, compliancePrevious),
        breaches: delta(num(sla.breaches), num(sla.breaches_previous)),
      },
      series,
      byType: byType.map((r) => ({ type: String(r.type), count: num(r.count), breached: num(r.breached) })),
      ageing,
      arrivals,
      breakdowns,
      byPriority,
      changes: { open: num(changes.open), outcomes },
    };
  }

  // ---- operations strips: the same totals the dedicated dashboards show
  const strips: { noc?: NocTotals; soc?: SocTotals; amc?: AmcTotals } = {};
  if (ctx.can('dashboards:noc', customerId)) strips.noc = await nocTotals(ctx, { customerId });
  if (ctx.can('dashboards:soc', customerId) && ctx.can('soc:read', customerId)) strips.soc = await socTotals(ctx, { customerId });
  if (ctx.can('dashboards:amc', customerId)) strips.amc = await amcTotals(ctx, { customerId });

  // ---- management extras
  let management: Record<string, unknown> | null = null;
  if (ctx.can('dashboards:management', customerId)) {
    const counts = await accountCounts(ctx, customerId);
    const needsAttention = (await attentionByCustomer(ctx, { from, to: today, customerId })).sort((a, b) => b.slaBreached - a.slaBreached || b.major - a.major || b.out_of_scope - a.out_of_scope || b.tickets - a.tickets);
    const canContracts = ctx.can('contracts:read', customerId);
    const ents = canContracts ? await entitlementSummary(ctx, customerId ?? undefined, 1000) : { total: 0, overThreshold: 0, exhausted: 0, items: [] };
    const expiring = canContracts ? await expiringContracts(ctx, 90, customerId ?? undefined) : { items: [], total: 0, days: 90 };
    const thresholds = await loadSurveyDefaults(ctx.tx);
    const csatFilter = { from: new Date(`${from}T00:00:00.000Z`), to: new Date(`${today}T23:59:59.999Z`), excludeSoc: hidesSoc(ctx), satisfiedThreshold: thresholds.satisfiedThreshold, lowThreshold: thresholds.lowRatingThreshold, customerId };
    const csat = await csatFigures(ctx.tx, csatFilter);
    const csatPrevious = await csatFigures(ctx.tx, { ...csatFilter, from: new Date(`${prevFrom}T00:00:00.000Z`), to: new Date(`${prevTo}T23:59:59.999Z`) });
    management = {
      kpis: { ...counts, entitlementsOverThreshold: ents.overThreshold, entitlementsExhausted: ents.exhausted, expiringContracts: expiring.total },
      needsAttention,
      expiringContracts: expiring.items.slice(0, 10).map((c) => ({ id: c.id, number: c.number, name: c.name, customerId: c.customerId, customerName: c.customerName, status: c.status, endDate: c.endDate, daysToExpiry: c.daysToExpiry, autoRenew: c.autoRenew })),
      entitlementAlerts: ents.items.filter((i) => i.utilization.overThreshold || i.utilization.exhausted).slice(0, 10),
      csat: { avg: csat.avg, satisfiedPct: csat.satisfiedPct, responseRate: csat.responseRate, responses: csat.responses, low: csat.low, series: csat.series, trendAvg: delta(csat.avg, csatPrevious.avg) },
    };
  }

  return {
    generatedAt: now,
    period,
    customerId,
    timezone,
    me: {
      name: ctx.user.name,
      shift,
      assigned: num(mine.assigned),
      breached: num(mine.breached),
      atRisk: num(mine.at_risk),
      dueToday: num(mine.due_today),
      resolvedToday: num(mine.resolved_today),
      approvals: num(approvals.n),
      byType: myTypes.map((r) => ({ type: String(r.type), count: num(r.count) })),
    },
    announcements,
    upcoming: upcomingWork,
    desk,
    strips,
    management,
  };
}
