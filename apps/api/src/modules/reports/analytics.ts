import { sql } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { ForbiddenError } from '@/core/errors';
import { BREACHED } from '@/modules/dashboards/common';
import { addDays, daysBetween, isValidTimezone, type DateRange } from './dates';
import { canRunReport, findReport, type ReportDefinition, type ReportParams, type ReportResult, type SummaryTile, type ValueUnit } from './registry';
import { rows, customerCond, rangeCond, socCond, ticketJoins, openCond, pct, num, round1 } from './definitions/helpers';

/**
 * Reusable server-side computations behind the report documents: the previous
 * period and the deltas every compared report carries, and the ticket, change,
 * satisfaction, known error and software figures the service review pack
 * composes. Every query runs through the caller's tenant transaction (RLS) and
 * hides SOC tickets from staff without soc:read.
 */

// ---------------------------------------------------------------- previous period and deltas

/** The same number of days ending the day before `from`; the last_month preset compares with the whole previous calendar month, labelled by its YYYY-MM. */
export function previousRange(r: DateRange): DateRange {
  if (r.preset === 'last_month' && r.from.endsWith('-01')) {
    const to = addDays(r.from, -1);
    return { from: `${to.slice(0, 7)}-01`, to, preset: 'custom', label: to.slice(0, 7) };
  }
  const days = daysBetween(r.from, r.to) + 1;
  const to = addDays(r.from, -1);
  const from = addDays(to, -(days - 1));
  return { from, to, preset: 'custom', label: `${from} to ${to}` };
}

/** Tile labels where a fall is an improvement. Word-bounded on purpose: a bare `age` would match "Average rating" and "Average utilization". */
export const LOWER_IS_BETTER = /\b(breach\w*|missed|exhausted|out of scope|unknown scope|unassigned|unlinked|expired|expiring|escalat\w*|low ratings?|failed|backed out|over-deployed|unlicensed|stale\b.*|reopen\w*|backlog|mttr|mtta|avg (response|resolution)|time to \w+|average age|age \(h\)|conflicts?|major incidents?|incidents|open|over threshold|alerts?)\b/i;

/** Tile labels whose rise or fall is neither good nor bad (demand, counts of records): their deltas print in gray and never make a trend insight good or bad. */
export const NEUTRAL = /^(opened|requests?|tickets|closed|changes|consumptions in period|entries|items|meetings|visits|responses|surveys sent|installations|titles|hosts|entitlements|assets|configuration items|users|entity types|occurrences planned|active programs|standard|emergency|from a template|from monitoring|problems|decisions|approved|deferred|pending|site visits|monitored|with root cause|work hours|engineering hours|customers affected|recommendations|known errors|linked incidents|published to portal|fix in progress|with incidents \(90d\)|auto-renew|expiring within \d+ days|top action|tickets opened|tickets resolved)$/i;
export const isNeutralLabel = (label: string) => NEUTRAL.test(label.trim());

/** The unit a tile prints with, inferred from its label when the definition did not say. */
export function inferUnit(label: string): ValueUnit {
  const l = label.toLowerCase();
  if (/rating|satisfaction/.test(l)) return 'rating';
  if (/%|compliance|rate\b|share|satisfied|utili[sz]ation|success/.test(l)) return 'pct';
  if (/\(min\)|mttr|mtta|minutes/.test(l)) return 'minutes';
  if (/\(h\)|hours/.test(l)) return 'hours';
  return 'count';
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Numeric tiles of `current` matched by label to `previous` gain a delta; string tiles ('n/a', '3/5') are left alone. */
export function attachDeltas(current: ReportResult, previous: ReportResult): void {
  const prevByLabel = new Map((previous.summary ?? []).map((t) => [t.label, t]));
  for (const tile of current.summary ?? []) {
    if (!isNum(tile.value)) continue;
    if (!tile.unit) tile.unit = inferUnit(tile.label);
    const before = prevByLabel.get(tile.label);
    if (!before || !isNum(before.value)) continue;
    const change = round1(tile.value - before.value) ?? 0;
    tile.delta = { previous: before.value, change, deltaPct: before.value !== 0 ? round1((change / Math.abs(before.value)) * 100) : null, lowerIsBetter: LOWER_IS_BETTER.test(tile.label), unit: tile.unit, ...(isNeutralLabel(tile.label) ? { neutral: true } : {}) };
  }
}

/** The tile's sparkline from a weekly or daily series of the same figure (at most twelve points). */
export const sparkOf = (values: (number | null)[]): (number | null)[] => values.slice(-12);

export const tileNumber = (tiles: SummaryTile[] | undefined, label: string): number | null => {
  const v = tiles?.find((t) => t.label === label)?.value;
  if (isNum(v)) return v;
  if (typeof v === 'string') {
    const m = /^(-?\d+(?:\.\d+)?)/.exec(v.trim());
    return m ? Number(m[1]) : null;
  }
  return null;
};

// ---------------------------------------------------------------- ticket figures

export interface Scope {
  customerId: string | null;
  from: string;
  to: string;
  type?: 'incident' | 'request' | 'problem' | 'change';
}

export interface TicketKpis {
  opened: number;
  resolved: number;
  closed: number;
  backlogEnd: number;
  backlogStart: number;
  mttaMinutes: number | null;
  mttrMinutes: number | null;
  fcrPct: number | null;
  fcr: number;
  reopened: number;
  reopenPct: number | null;
  major: number;
  escalated: number;
  unassignedNow: number;
  outOfScope: number;
}

const typeCond = (s: Scope) => (s.type ? sql`AND t.type = ${s.type}::ticket_type` : sql``);
const within = (col: ReturnType<typeof sql>, s: Scope) => sql`${col} >= ${s.from}::date AND ${col} < ${s.to}::date + interval '1 day'`;
/** Assignments of a ticket resolved in the period; CASE keeps the subquery from running for the rest of the history the backlog counts need. */
const assignmentsInRange = (s: Scope) => sql`CASE WHEN ${within(sql`t.resolved_at`, s)} THEN (SELECT count(*)::int FROM ticket_activities a WHERE a.ticket_id = t.id AND a.activity_type = 'assignment') ELSE 0 END`;

/** One statement: opened, resolved, closed, backlog at both ends, MTTA, MTTR, first-contact resolution, reopens, majors, escalations, unassigned now and out of scope. */
export async function ticketKpis(ctx: Ctx, s: Scope): Promise<TicketKpis> {
  const [r] = await rows<Record<string, unknown>>(ctx, sql`
    SELECT
      count(*) FILTER (WHERE ${within(sql`t.created_at`, s)})::int AS opened,
      count(*) FILTER (WHERE ${within(sql`t.resolved_at`, s)})::int AS resolved,
      count(*) FILTER (WHERE ${within(sql`t.closed_at`, s)})::int AS closed,
      count(*) FILTER (WHERE t.created_at < ${s.to}::date + interval '1 day' AND (t.resolved_at IS NULL OR t.resolved_at >= ${s.to}::date + interval '1 day') AND (t.closed_at IS NULL OR t.closed_at >= ${s.to}::date + interval '1 day'))::int AS backlog_end,
      count(*) FILTER (WHERE t.created_at < ${s.from}::date AND (t.resolved_at IS NULL OR t.resolved_at >= ${s.from}::date) AND (t.closed_at IS NULL OR t.closed_at >= ${s.from}::date))::int AS backlog_start,
      round(avg(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at)) / 60) FILTER (WHERE ${within(sql`t.resolved_at`, s)} AND t.first_response_at IS NOT NULL)) AS mtta_minutes,
      round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60) FILTER (WHERE ${within(sql`t.resolved_at`, s)})) AS mttr_minutes,
      count(*) FILTER (WHERE ${within(sql`t.resolved_at`, s)} AND t.reopen_count = 0 AND t.escalation_level = 0 AND ${assignmentsInRange(s)} <= 1)::int AS fcr,
      count(*) FILTER (WHERE ${within(sql`t.resolved_at`, s)} AND t.reopen_count > 0)::int AS reopened,
      count(*) FILTER (WHERE ${within(sql`t.created_at`, s)} AND t.is_major)::int AS major,
      count(*) FILTER (WHERE ${within(sql`t.created_at`, s)} AND t.escalation_level > 0)::int AS escalated,
      count(*) FILTER (WHERE t.assignee_id IS NULL AND t.resolved_at IS NULL AND t.closed_at IS NULL ${openCond()})::int AS unassigned_now,
      count(*) FILTER (WHERE ${within(sql`t.created_at`, s)} AND t.scope_status = 'out_of_scope')::int AS out_of_scope
    FROM tickets t
    WHERE t.created_at < ${s.to}::date + interval '1 day' ${customerCond(s.customerId)} ${socCond(ctx)} ${typeCond(s)}`);
  const g = (k: string) => num(r?.[k]);
  const resolved = g('resolved');
  return {
    opened: g('opened'),
    resolved,
    closed: g('closed'),
    backlogEnd: g('backlog_end'),
    backlogStart: g('backlog_start'),
    mttaMinutes: r?.mtta_minutes === null || r?.mtta_minutes === undefined ? null : num(r.mtta_minutes),
    mttrMinutes: r?.mttr_minutes === null || r?.mttr_minutes === undefined ? null : num(r.mttr_minutes),
    fcr: g('fcr'),
    fcrPct: pct(g('fcr'), resolved),
    reopened: g('reopened'),
    reopenPct: pct(g('reopened'), resolved),
    major: g('major'),
    escalated: g('escalated'),
    unassignedNow: g('unassigned_now'),
    outOfScope: g('out_of_scope'),
  };
}

export type BreakdownDimension = 'priority' | 'service' | 'category' | 'engineer' | 'team' | 'site' | 'customer' | 'type' | 'source';
export interface BreakdownRow {
  label: string;
  opened: number;
  resolved: number;
  mttrMinutes: number | null;
  breaches: number;
  compliancePct: number | null;
}

const DIMENSION = {
  priority: { expr: sql`coalesce(pr.label, 'No priority')`, order: sql`min(coalesce(pr.level, 99)), 2 DESC` },
  service: { expr: sql`coalesce(sv.name, 'No service')`, order: sql`2 DESC` },
  category: { expr: sql`coalesce(cat.label, 'No category')`, order: sql`2 DESC` },
  engineer: { expr: sql`coalesce(asg.name, 'Unassigned')`, order: sql`2 DESC` },
  team: { expr: sql`coalesce(tm.name, 'No team')`, order: sql`2 DESC` },
  site: { expr: sql`coalesce(si.name, 'No site')`, order: sql`2 DESC` },
  customer: { expr: sql`coalesce(cu.name, 'No customer')`, order: sql`2 DESC` },
  type: { expr: sql`t.type::text`, order: sql`2 DESC` },
  source: { expr: sql`coalesce(src.label, 'Unknown')`, order: sql`2 DESC` },
} as const;

/** Tickets created in the period grouped by one dimension: opened, resolved, MTTR, resolution breaches and compliance; at most 20 rows. */
export async function breakdown(ctx: Ctx, s: Scope, by: BreakdownDimension): Promise<BreakdownRow[]> {
  const dim = DIMENSION[by];
  const list = await rows<Record<string, unknown>>(ctx, sql`
    SELECT ${dim.expr} AS label, count(*)::int AS opened, count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved,
      round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60) FILTER (WHERE t.resolved_at IS NOT NULL)) AS mttr_minutes,
      (SELECT count(*)::int FROM ticket_slas sl WHERE sl.ticket_id = ANY(array_agg(t.id)) AND sl.metric = 'resolution' AND sl.state = 'breached') AS breaches,
      (SELECT count(*)::int FROM ticket_slas sl WHERE sl.ticket_id = ANY(array_agg(t.id)) AND sl.metric = 'resolution' AND sl.state = 'met') AS met
    FROM tickets t ${ticketJoins} LEFT JOIN sites si ON si.id = t.site_id LEFT JOIN config_options src ON src.id = t.source_id
    WHERE true ${rangeCond(sql`t.created_at`, s.from, s.to)} ${customerCond(s.customerId)} ${socCond(ctx)} ${typeCond(s)}
    GROUP BY 1 ORDER BY ${dim.order} LIMIT 20`);
  return list.map((r) => ({ label: String(r.label), opened: num(r.opened), resolved: num(r.resolved), mttrMinutes: r.mttr_minutes === null || r.mttr_minutes === undefined ? null : num(r.mttr_minutes), breaches: num(r.breaches), compliancePct: pct(num(r.met), num(r.met) + num(r.breaches)) }));
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

/** Ticket arrivals by weekday and hour in a timezone (every cell present, zeros included); an invalid timezone falls back to UTC. */
export async function arrivalHeatmap(ctx: Ctx, s: Scope & { timezone: string }): Promise<{ row: string; col: string; value: number }[]> {
  const tz = isValidTimezone(s.timezone) ? s.timezone : 'UTC';
  const list = await rows<{ dow: number; hour: number; n: number }>(ctx, sql`
    SELECT EXTRACT(DOW FROM (t.created_at AT TIME ZONE ${tz}))::int AS dow, EXTRACT(HOUR FROM (t.created_at AT TIME ZONE ${tz}))::int AS hour, count(*)::int AS n
    FROM tickets t WHERE true ${rangeCond(sql`t.created_at`, s.from, s.to)} ${customerCond(s.customerId)} ${socCond(ctx)} ${typeCond(s)}
    GROUP BY 1, 2`);
  const counts = new Map(list.map((r) => [`${(num(r.dow) + 6) % 7}:${num(r.hour)}`, num(r.n)]));
  return WEEKDAYS.flatMap((row, d) => HOURS.map((col, h) => ({ row, col, value: counts.get(`${d}:${h}`) ?? 0 })));
}

export const AGE_ORDER = ['< 1 day', '1-3 days', '3-7 days', '7-30 days', '> 30 days'] as const;

/** Open tickets now, bucketed by age, with how many already breached a clock. */
export async function backlogAgeing(ctx: Ctx, s: Pick<Scope, 'customerId' | 'type'>): Promise<{ bucket: string; count: number; breached: number }[]> {
  const list = await rows<{ bucket: string; count: number; breached: number }>(ctx, sql`
    SELECT CASE WHEN now() - t.created_at < interval '1 day' THEN '< 1 day' WHEN now() - t.created_at < interval '3 days' THEN '1-3 days' WHEN now() - t.created_at < interval '7 days' THEN '3-7 days' WHEN now() - t.created_at < interval '30 days' THEN '7-30 days' ELSE '> 30 days' END AS bucket,
      count(*)::int AS count, count(*) FILTER (WHERE ${BREACHED})::int AS breached
    FROM tickets t WHERE true ${openCond()} ${customerCond(s.customerId)} ${socCond(ctx)} ${typeCond(s as Scope)}
    GROUP BY 1`);
  const byBucket = new Map(list.map((r) => [r.bucket, r]));
  return AGE_ORDER.map((bucket) => ({ bucket, count: num(byBucket.get(bucket)?.count), breached: num(byBucket.get(bucket)?.breached) }));
}

export interface ResponsivenessRow {
  priority: string;
  level: number;
  opened: number;
  resolved: number;
  mttaMinutes: number | null;
  mttrMinutes: number | null;
  fcrPct: number | null;
  reopenPct: number | null;
}

/** MTTA, MTTR, first-contact resolution and reopen rate per priority. */
export async function responsiveness(ctx: Ctx, s: Scope): Promise<ResponsivenessRow[]> {
  const list = await rows<Record<string, unknown>>(ctx, sql`
    SELECT coalesce(pr.label, 'No priority') AS priority, coalesce(pr.level, 99)::int AS level,
      count(*) FILTER (WHERE ${within(sql`t.created_at`, s)})::int AS opened,
      count(*) FILTER (WHERE ${within(sql`t.resolved_at`, s)})::int AS resolved,
      round(avg(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at)) / 60) FILTER (WHERE ${within(sql`t.resolved_at`, s)} AND t.first_response_at IS NOT NULL)) AS mtta_minutes,
      round(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60) FILTER (WHERE ${within(sql`t.resolved_at`, s)})) AS mttr_minutes,
      count(*) FILTER (WHERE ${within(sql`t.resolved_at`, s)} AND t.reopen_count = 0 AND t.escalation_level = 0 AND ${assignmentsInRange(s)} <= 1)::int AS fcr,
      count(*) FILTER (WHERE ${within(sql`t.resolved_at`, s)} AND t.reopen_count > 0)::int AS reopened
    FROM tickets t LEFT JOIN config_options pr ON pr.id = t.priority_id
    WHERE (${within(sql`t.created_at`, s)} OR ${within(sql`t.resolved_at`, s)}) ${customerCond(s.customerId)} ${socCond(ctx)} ${typeCond(s)}
    GROUP BY 1, 2 ORDER BY 2`);
  return list.map((r) => ({ priority: String(r.priority), level: num(r.level), opened: num(r.opened), resolved: num(r.resolved), mttaMinutes: r.mtta_minutes === null || r.mtta_minutes === undefined ? null : num(r.mtta_minutes), mttrMinutes: r.mttr_minutes === null || r.mttr_minutes === undefined ? null : num(r.mttr_minutes), fcrPct: pct(num(r.fcr), num(r.resolved)), reopenPct: pct(num(r.reopened), num(r.resolved)) }));
}

// ---------------------------------------------------------------- changes

export interface ChangeOutcomes {
  total: number;
  implemented: number;
  failed: number;
  backedOut: number;
  emergency: number;
  standard: number;
  successPct: number | null;
  failedList: { number: string; title: string; changeType: string; outcome: string; scheduledStart: unknown; assignee: string | null }[];
}

/** Changes that ended in the period (actual end, else the window, else creation): implemented, failed, backed out, by type, and the success rate. */
export async function changeOutcomes(ctx: Ctx, s: Scope): Promise<ChangeOutcomes> {
  const list = await rows<Record<string, unknown>>(ctx, sql`
    SELECT t.number, t.title, cd.change_type, st.key AS status_key, cd.pir_outcome, cd.scheduled_start, asg.name AS assignee
    FROM tickets t JOIN change_details cd ON cd.ticket_id = t.id LEFT JOIN config_options st ON st.id = t.status_id LEFT JOIN users asg ON asg.id = t.assignee_id
    WHERE t.type = 'change' AND st.status_category IN ('resolved', 'closed')
      AND coalesce(cd.actual_end, cd.scheduled_end, cd.scheduled_start, t.created_at) >= ${s.from}::date AND coalesce(cd.actual_end, cd.scheduled_end, cd.scheduled_start, t.created_at) < ${s.to}::date + interval '1 day'
      ${customerCond(s.customerId)} ${socCond(ctx)}
    ORDER BY coalesce(cd.actual_end, cd.scheduled_end, cd.scheduled_start, t.created_at) DESC LIMIT 2000`);
  // a change that reached resolved or closed without failing or being backed out was implemented (closed changes rarely keep the implemented key)
  const outcomeOf = (r: Record<string, unknown>) => (r.pir_outcome === 'backed_out' ? 'backed_out' : r.status_key === 'failed' || r.pir_outcome === 'failed' ? 'failed' : 'implemented');
  const outcomes = list.map(outcomeOf);
  const implemented = outcomes.filter((o) => o === 'implemented').length;
  const failed = outcomes.filter((o) => o === 'failed').length;
  const backedOut = outcomes.filter((o) => o === 'backed_out').length;
  return {
    total: list.length,
    implemented,
    failed,
    backedOut,
    emergency: list.filter((r) => r.change_type === 'emergency').length,
    standard: list.filter((r) => r.change_type === 'standard').length,
    successPct: pct(implemented, implemented + failed + backedOut),
    failedList: list.filter((_r, i) => outcomes[i] === 'failed' || outcomes[i] === 'backed_out').map((r, _i) => ({ number: String(r.number), title: String(r.title), changeType: String(r.change_type ?? 'normal'), outcome: outcomeOf(r) === 'backed_out' ? 'Backed out' : 'Failed', scheduledStart: r.scheduled_start, assignee: r.assignee === null || r.assignee === undefined ? null : String(r.assignee) })),
  };
}

// ---------------------------------------------------------------- parts composed from other definitions (null-safe)

/** A registered definition's run for the pack: null when the definition is missing or the caller may not run it (a permission the definition checks itself, such as portal:kedb, counts as "may not"). */
export async function runPart(ctx: Ctx, key: string, base: ReportParams, overrides: Record<string, unknown> = {}): Promise<{ def: ReportDefinition; result: ReportResult } | null> {
  const def = findReport(key);
  if (!def || !canRunReport(ctx, def, base.customerId)) return null;
  const defaults = Object.fromEntries(def.parameters.filter((p) => p.default !== undefined).map((p) => [p.key, p.default]));
  try {
    const result = await def.run(ctx, { ...defaults, ...base, ...overrides } as ReportParams);
    return { def, result };
  } catch (err) {
    // refused before any SQL ran (ctx.require inside the definition): the part is left out, the transaction is intact
    if (err instanceof ForbiddenError) return null;
    throw err;
  }
}

/** The timezone hour-of-day figures are shown in: the customer's when one is selected, else the caller's, else UTC. */
export async function scopeTimezone(ctx: Ctx, customerId: string | null | undefined): Promise<string> {
  if (customerId) {
    const [row] = await rows<{ timezone: string | null }>(ctx, sql`SELECT timezone FROM customers WHERE id = ${customerId}::uuid LIMIT 1`);
    if (row?.timezone && isValidTimezone(row.timezone)) return row.timezone;
  }
  const own = ctx.user.timezone;
  return own && isValidTimezone(own) ? own : 'UTC';
}

/** Share of arrivals outside 09:00-18:00 on weekdays (and anything at the weekend), from the heatmap cells. */
export function afterHoursShare(cells: { row: string; col: string; value: number }[]): number | null {
  const total = cells.reduce((s, c) => s + c.value, 0);
  if (!total) return null;
  const after = cells.filter((c) => c.row === 'Sat' || c.row === 'Sun' || Number(c.col) < 9 || Number(c.col) >= 18).reduce((s, c) => s + c.value, 0);
  return Math.round((after / total) * 1000) / 10;
}

export interface CsatPart {
  avg: number | null;
  responses: number;
  sent: number;
  responseRate: number | null;
  satisfiedPct: number | null;
  low: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
  series: { week: string; avg: number | null; responses: number }[];
  result: ReportResult;
}

/** The customer satisfaction figures from the csat_summary definition (tiles read by their frozen labels). */
export async function csatPart(ctx: Ctx, base: ReportParams): Promise<CsatPart | null> {
  const part = await runPart(ctx, 'csat_summary', base, { groupBy: 'service' });
  if (!part) return null;
  const { result } = part;
  const t = result.summary;
  const distribution: CsatPart['distribution'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const dist = result.sections?.find((x) => x.title === 'Rating distribution');
  if (dist) {
    const countCol = dist.columns.find((c) => c.type === 'number')?.key ?? dist.columns[1]?.key;
    for (const r of dist.rows) {
      const rating = Number(String(r[dist.columns[0]?.key ?? 'rating'] ?? '').replace(/\/5$/, ''));
      if (rating >= 1 && rating <= 5 && countCol) distribution[rating as 1 | 2 | 3 | 4 | 5] = num(r[countCol]);
    }
  }
  const trend = result.charts?.find((c) => c.title === 'Average rating per week');
  return {
    avg: tileNumber(t, 'Average rating'),
    responses: tileNumber(t, 'Responses') ?? 0,
    sent: tileNumber(t, 'Surveys sent') ?? 0,
    responseRate: tileNumber(t, 'Response rate'),
    satisfiedPct: tileNumber(t, 'Satisfied'),
    low: tileNumber(t, 'Low ratings') ?? 0,
    distribution,
    series: (trend?.data ?? []).map((d) => ({ week: String(d.week ?? ''), avg: d.avg === null || d.avg === undefined ? null : num(d.avg), responses: num(d.responses) })),
    result,
  };
}

export interface KnownErrorsPart {
  total: number;
  open: number;
  fixInProgress: number;
  published: number;
  linkedIncidents: number;
  result: ReportResult;
}

export async function knownErrorsPart(ctx: Ctx, base: ReportParams): Promise<KnownErrorsPart | null> {
  const part = await runPart(ctx, 'known_errors', base, { status: 'active' });
  if (!part) return null;
  const t = part.result.summary;
  return { total: tileNumber(t, 'Known errors') ?? 0, open: tileNumber(t, 'Open') ?? 0, fixInProgress: tileNumber(t, 'Fix in progress') ?? 0, published: tileNumber(t, 'Published to portal') ?? 0, linkedIncidents: tileNumber(t, 'Linked incidents') ?? 0, result: part.result };
}

export interface SoftwarePart {
  titles: number;
  overDeployed: number;
  unlicensed: number;
  underDeployed: number;
  ending: number;
  result: ReportResult;
}

export async function softwarePart(ctx: Ctx, base: ReportParams): Promise<SoftwarePart | null> {
  const part = await runPart(ctx, 'licence_compliance', base, { expiringDays: 90, includeCompliant: true });
  if (!part) return null;
  const t = part.result.summary;
  const ending = t?.find((x) => x.label.startsWith('Licences ending'));
  return { titles: tileNumber(t, 'Titles') ?? 0, overDeployed: tileNumber(t, 'Over-deployed') ?? 0, unlicensed: tileNumber(t, 'Unlicensed') ?? 0, underDeployed: tileNumber(t, 'Under-deployed') ?? 0, ending: ending && isNum(ending.value) ? ending.value : 0, result: part.result };
}

/** CAB decisions of the period (staff only: the definition is not portal-visible). */
export async function cabPart(ctx: Ctx, base: ReportParams): Promise<{ decisions: number; result: ReportResult } | null> {
  const part = await runPart(ctx, 'cab_decisions', base, { decision: '' });
  if (!part) return null;
  return { decisions: part.result.rows.length, result: part.result };
}
