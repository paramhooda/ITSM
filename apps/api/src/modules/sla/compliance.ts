import { sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '@/core/context';

/**
 * The one definition of "SLA compliance · N days" every dashboard, record
 * page, briefing headline and assistant fact shows: the resolution clocks
 * that ENDED in the period. Met = `ticket_slas.metric = 'resolution' AND
 * state = 'met'` with `completed_at` in the window; breached = `state =
 * 'breached'` with `breached_at` in the window (an open ticket whose clock the
 * sweep flagged in the window counts, as the Overview always did). The
 * percentage is `met / (met + breached)` to one decimal, `null` when nothing
 * ended. A reopened ticket's clock has `completed_at` and `breached_at`
 * cleared, so it counts nowhere until it ends again.
 *
 * The window is whole UTC days `[from, to]` (YYYY-MM-DD), the very cut the
 * ticket list applies to a date-only `slaEndedFrom`/`slaEndedTo` bound, so the
 * two segments reproduce on the list they open whatever the database
 * session's time zone. `(ticket_id, metric)` is unique on `ticket_slas`, so a
 * count of resolution clocks is a count of tickets and the doors are exact.
 *
 * `fence` is a leading-`AND` fragment over the alias `t` (`custCond`,
 * `socCond`, `teamCond`, `AND t.assignee_id = …`); a bare predicate such as
 * `nocScope(s)` is wrapped `sql\`AND ${scope}\`` by the caller. The helper
 * takes no customer id of its own: every caller pins the fence (`custCond`
 * after `requireCustomer`, the portal's own organisation), and `ticket_slas`
 * and `tickets` are under row-level security in the same transaction, so a
 * customer principal can never read another organisation's clocks even with a
 * wrong fence.
 *
 * The printed reports and the policy screens keep `slaCompliance()`
 * (`sla/policies.ts`): clocks STARTED in the period, every metric, so a
 * monthly document is reproducible after the month closes. They say so in
 * their labels; this helper answers "what ended in the last N days".
 */

export interface ComplianceWindow {
  /** First day, YYYY-MM-DD, inclusive. */
  from: string;
  /** Last day, YYYY-MM-DD, inclusive. */
  to: string;
}

export interface ComplianceFigures {
  met: number;
  breached: number;
  /** `met / (met + breached)` to one decimal; null when nothing ended. */
  compliancePct: number | null;
}

export interface ResolutionCompliance extends ComplianceFigures {
  /** The same figures over the previous window, when one was asked for. */
  previous?: ComplianceFigures;
}

export interface PriorityCompliance extends ComplianceFigures {
  id: string | null;
  key: string | null;
  label: string;
  color: string | null;
  level: number;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
export const compliancePct = (met: number, breached: number) => (met + breached > 0 ? Math.round((met / (met + breached)) * 1000) / 10 : null);
const figures = (met: unknown, breached: unknown): ComplianceFigures => ({ met: num(met), breached: num(breached), compliancePct: compliancePct(num(met), num(breached)) });

/** `col` inside the whole UTC days `[from, to]`: the list's cut for a date-only bound. */
const inDays = (col: SQL, from: string, to: string) => sql`${col} >= (${from}::date)::timestamp AT TIME ZONE 'UTC' AND ${col} < (${to}::date + interval '1 day')::timestamp AT TIME ZONE 'UTC'`;
const MET = (from: string, to: string) => sql`s.state = 'met' AND ${inDays(sql`s.completed_at`, from, to)}`;
const BREACHED = (from: string, to: string) => sql`s.state = 'breached' AND ${inDays(sql`s.breached_at`, from, to)}`;
/** The statement's WHERE: resolution clocks whose end date (either column) falls in the widest window asked for; served by the date-leading partial indexes. */
const ENDED_IN = (from: string, to: string) => sql`s.metric = 'resolution' AND (${inDays(sql`s.completed_at`, from, to)} OR ${inDays(sql`s.breached_at`, from, to)})`;

/** Resolution clocks met and breached in the window under the fence, with the previous window's figures when asked. */
export async function resolutionCompliance(ctx: Ctx, opts: ComplianceWindow & { fence: SQL; previous?: ComplianceWindow }): Promise<ResolutionCompliance> {
  const { from, to, fence, previous } = opts;
  const lo = previous && previous.from < from ? previous.from : from;
  const hi = previous && previous.to > to ? previous.to : to;
  const [row] = (await ctx.tx.execute(sql`
    SELECT count(*) FILTER (WHERE ${MET(from, to)})::int AS met, count(*) FILTER (WHERE ${BREACHED(from, to)})::int AS breached
      ${previous ? sql`, count(*) FILTER (WHERE ${MET(previous.from, previous.to)})::int AS met_previous, count(*) FILTER (WHERE ${BREACHED(previous.from, previous.to)})::int AS breached_previous` : sql``}
    FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id WHERE ${ENDED_IN(lo, hi)} ${fence}`)).rows as Row[];
  const out: ResolutionCompliance = figures(row?.met, row?.breached);
  if (previous) out.previous = figures(row?.met_previous, row?.breached_previous);
  return out;
}

/** The same figures per customer (keyed by customer id) for the rows of a customer table; customers without an ended clock are absent. */
export async function resolutionComplianceByCustomer(ctx: Ctx, opts: ComplianceWindow & { fence: SQL }): Promise<Map<string, ComplianceFigures>> {
  const { from, to, fence } = opts;
  const rows = (await ctx.tx.execute(sql`
    SELECT t.customer_id, count(*) FILTER (WHERE ${MET(from, to)})::int AS met, count(*) FILTER (WHERE ${BREACHED(from, to)})::int AS breached
    FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id WHERE ${ENDED_IN(from, to)} ${fence} GROUP BY t.customer_id`)).rows as Row[];
  return new Map(rows.map((r) => [String(r.customer_id), figures(r.met, r.breached)]));
}

/** The same figures per ticket priority (level order, "No priority" last), every priority with an ended clock. */
export async function resolutionComplianceByPriority(ctx: Ctx, opts: ComplianceWindow & { fence: SQL }): Promise<PriorityCompliance[]> {
  const { from, to, fence } = opts;
  const rows = (await ctx.tx.execute(sql`
    SELECT pr.id, pr.key, coalesce(pr.label, 'No priority') AS label, pr.color, coalesce(pr.level, 99)::int AS level,
      count(*) FILTER (WHERE ${MET(from, to)})::int AS met, count(*) FILTER (WHERE ${BREACHED(from, to)})::int AS breached
    FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id LEFT JOIN config_options pr ON pr.id = t.priority_id
    WHERE ${ENDED_IN(from, to)} ${fence} GROUP BY pr.id, pr.key, pr.label, pr.color, pr.level ORDER BY level, label`)).rows as Row[];
  return rows.map((r) => ({ id: r.id === null || r.id === undefined ? null : String(r.id), key: (r.key as string | null) ?? null, label: String(r.label), color: (r.color as string | null) ?? null, level: num(r.level), ...figures(r.met, r.breached) }));
}
