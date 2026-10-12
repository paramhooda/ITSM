import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { eq, and, inArray, asc } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { getSetting } from '@/modules/config/service';
import { plannedChangeState } from '@/modules/changes/service';
import { windowOf } from '@/modules/changes/conflicts';
import { addDays } from '@/modules/contracts/common';

/**
 * The Upcoming numbers of the customer portal, one predicate each. The
 * portal home's "N visits · N maintenance · N changes · N approvals" line,
 * the navigator's visits badge (`me().counts.upcomingVisits`) and the
 * maintenance page's own `upcoming` flag all count through the functions
 * here, so a number on the home is the length of the list it opens.
 *
 * A visit is upcoming while it is still open (requested, scheduled or in
 * progress) and falls on or after today; a maintenance occurrence while it
 * is planned, scheduled or rescheduled on or after today, and listed on its
 * own only while no upcoming visit is booked for it (`occurrenceStandaloneCond`).
 * "Today" is the UTC day (`todayStr()`), the day the maintenance page cuts
 * its window on.
 */

/** The horizon the home's visits and maintenance counts look ahead: the maintenance page's default window. */
export const PORTAL_UPCOMING_DAYS = 90;

export const VISIT_OPEN_STATUSES = ['requested', 'scheduled', 'in_progress'] as const;
export const OCCURRENCE_OPEN_STATUSES = ['planned', 'scheduled', 'rescheduled'] as const;

/** The columns the predicates read; pass the drizzle columns (a query-builder statement) or raw aliased fragments (a `FROM field_visits v` statement). */
export interface VisitCols { status: SQLWrapper; scheduledStart: SQLWrapper; createdAt: SQLWrapper }
export interface OccurrenceCols { status: SQLWrapper; scheduledDate: SQLWrapper; plannedDate: SQLWrapper }

export const VISIT_V: VisitCols = { status: sql`v.status`, scheduledStart: sql`v.scheduled_start`, createdAt: sql`v.created_at` };
export const OCCURRENCE_O: OccurrenceCols = { status: sql`o.status`, scheduledDate: sql`o.scheduled_date`, plannedDate: sql`o.planned_date` };

const inList = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** The day a visit falls on: its scheduled start, else the day it was requested. */
export const visitDate = (v: VisitCols = VISIT_V): SQL => sql`coalesce(${v.scheduledStart}, ${v.createdAt})`;
/** The day an occurrence falls on: the scheduled date, else the planned one. */
export const occurrenceDate = (o: OccurrenceCols = OCCURRENCE_O): SQL => sql`coalesce(${o.scheduledDate}, ${o.plannedDate})`;

/** `status IN (open visit statuses) AND <visit day> >= today`. */
export const upcomingVisitCond = (today: string, v: VisitCols = VISIT_V): SQL => sql`${v.status} IN (${inList(VISIT_OPEN_STATUSES)}) AND ${visitDate(v)} >= ${today}::date`;
/** `status IN (open occurrence statuses) AND <occurrence day> >= today`. */
export const upcomingOccurrenceCond = (today: string, o: OccurrenceCols = OCCURRENCE_O): SQL => sql`${o.status} IN (${inList(OCCURRENCE_OPEN_STATUSES)}) AND ${occurrenceDate(o)} >= ${today}::date`;

/** The maintenance page's window over visits: `[from, to]` whole days on the visit day (a timestamp, so the upper bound is the next day's start). */
export const visitWindowCond = (from: string, to: string, v: VisitCols = VISIT_V): SQL => sql`${visitDate(v)} >= ${from}::date AND ${visitDate(v)} < (${to}::date + interval '1 day')`;
/** The maintenance page's window over occurrences: `[from, to]` on the occurrence day (a date). */
export const occurrenceWindowCond = (from: string, to: string, o: OccurrenceCols = OCCURRENCE_O): SQL => sql`${occurrenceDate(o)} >= ${from}::date AND ${occurrenceDate(o)} <= ${to}::date`;

const VISIT_FV: VisitCols = { status: sql`fv.status`, scheduledStart: sql`fv.scheduled_start`, createdAt: sql`fv.created_at` };
/**
 * An occurrence the maintenance page lists as itself: it has no engineer visit
 * booked for it, or the visit booked is not an upcoming visit of the window
 * (`today … to`). An occurrence whose visit is coming up folds into that visit
 * (the visit is the row and the home's "N visits" counts it), so the home's
 * "N maintenance" and the page's *Preventive maintenance* pill count the
 * same rows.
 */
export const occurrenceStandaloneCond = (today: string, to: string, fieldVisitId: SQLWrapper = sql`o.field_visit_id`): SQL =>
  sql`(${fieldVisitId} IS NULL OR NOT EXISTS (SELECT 1 FROM field_visits fv WHERE fv.id = ${fieldVisitId} AND ${upcomingVisitCond(today, VISIT_FV)} AND ${visitWindowCond(today, to, VISIT_FV)}))`;

/** The home's horizon for visits and maintenance: today … today + `PORTAL_UPCOMING_DAYS`. */
export const upcomingHorizon = (today: string) => ({ from: today, to: addDays(today, PORTAL_UPCOMING_DAYS) });

export type PlannedChangeBucket = 'upcoming' | 'in_progress' | 'past';

export interface PlannedChangeItem {
  id: string;
  number: string;
  title: string;
  changeType: string | null;
  state: ReturnType<typeof plannedChangeState>['state'];
  outcome: ReturnType<typeof plannedChangeState>['outcome'];
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  downtimeExpectedMinutes: number | null;
  service: { id: string; name: string | null } | null;
  businessServices: { id: string; name: string }[];
  isMine: boolean;
}

/**
 * The organisation's planned changes bucketed as the portal's planned-changes
 * page shows them (upcoming, in progress, past) over its window: the last 30
 * days and the next `changes.portal_horizon_days`. The page's tiles and the
 * home's "N changes" are the same `counts`. No permission gate here: the
 * caller resolved the organisation (`resolvePortalCustomer`, or the staff
 * customer scope) before asking.
 */
export async function plannedChangeBuckets(ctx: Ctx, customerId: string, opts: { serviceId?: string | null; preview?: boolean; now?: Date } = {}) {
  const horizon = Math.max(7, Math.min(365, Number(await getSetting(ctx, 'changes.portal_horizon_days', 60)) || 60));
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - 30 * 86_400_000);
  const to = new Date(now.getTime() + horizon * 86_400_000);
  const T = schema.tickets;
  const cd = schema.changeDetails;
  const st = alias(schema.configOptions, 'portal_chg_st');
  const conds: SQL[] = [eq(T.customerId, customerId), eq(T.type, 'change'), sql`${cd.scheduledStart} IS NOT NULL`, sql`${cd.scheduledStart} < ${to}`, sql`coalesce(${cd.scheduledEnd}, ${cd.scheduledStart} + interval '1 hour') > ${from}`];
  if (opts.serviceId) conds.push(eq(T.serviceId, opts.serviceId));
  const rows = await ctx.tx
    .select({ id: T.id, number: T.number, title: T.title, serviceId: T.serviceId, serviceName: schema.services.name, requesterUserId: T.requesterUserId, approvalStatus: T.approvalStatus, statusKey: st.key, statusCategory: st.statusCategory, changeType: cd.changeType, scheduledStart: cd.scheduledStart, scheduledEnd: cd.scheduledEnd, actualStart: cd.actualStart, actualEnd: cd.actualEnd, downtimeExpectedMinutes: cd.downtimeExpectedMinutes, pirOutcome: cd.pirOutcome })
    .from(cd)
    .innerJoin(T, eq(T.id, cd.ticketId))
    .leftJoin(st, eq(st.id, T.statusId))
    .leftJoin(schema.services, eq(schema.services.id, T.serviceId))
    .where(and(...conds))
    .orderBy(asc(cd.scheduledStart))
    .limit(500);
  const ids = rows.map((r) => r.id);
  const bsRows = ids.length
    ? await ctx.tx
        .select({ ticketId: schema.ticketCis.ticketId, id: schema.cis.id, name: schema.cis.name })
        .from(schema.ticketCis)
        .innerJoin(schema.cis, eq(schema.cis.id, schema.ticketCis.ciId))
        .innerJoin(schema.ciTypes, eq(schema.ciTypes.id, schema.cis.typeId))
        .where(and(inArray(schema.ticketCis.ticketId, ids), eq(schema.ciTypes.key, 'business_service')))
    : [];
  const all: { bucket: PlannedChangeBucket; item: PlannedChangeItem }[] = rows.map((r) => {
    const { state, outcome } = plannedChangeState({ statusKey: r.statusKey, statusCategory: r.statusCategory, approvalStatus: r.approvalStatus, pirOutcome: r.pirOutcome, start: r.scheduledStart!, end: r.scheduledEnd }, now);
    const w = windowOf(r.scheduledStart!, r.scheduledEnd);
    const bucket: PlannedChangeBucket = state === 'in_progress' ? 'in_progress' : state === 'implemented' || state === 'cancelled' || w.end.getTime() <= now.getTime() ? 'past' : 'upcoming';
    return {
      bucket,
      item: {
        id: r.id, number: r.number, title: r.title, changeType: r.changeType, state, outcome,
        scheduledStart: r.scheduledStart, scheduledEnd: r.scheduledEnd, actualStart: r.actualStart, actualEnd: r.actualEnd, downtimeExpectedMinutes: r.downtimeExpectedMinutes,
        service: r.serviceId ? { id: r.serviceId, name: r.serviceName } : null,
        businessServices: bsRows.filter((b) => b.ticketId === r.id).map((b) => ({ id: b.id, name: b.name })),
        isMine: !opts.preview && r.requesterUserId === ctx.user.id,
      },
    };
  });
  const counts = { upcoming: all.filter((x) => x.bucket === 'upcoming').length, inProgress: all.filter((x) => x.bucket === 'in_progress').length, past: all.filter((x) => x.bucket === 'past').length };
  return { window: { from, to }, all, counts };
}
