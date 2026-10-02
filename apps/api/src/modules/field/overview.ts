import { and, asc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { FIELD_VISIT_STATUSES, PM_STATUSES } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { type Bucket, fixedBuckets, VISIT_STATUS_COLORS, PM_STATUS_COLORS, num, todayStr, addDays, monthStart } from '@/core/overview';
import { dailySeries } from '@/modules/dashboards/common';
import { visibilityConds } from './service';
import { isCustomerUser, sequential, countSql } from './common';

const V = schema.fieldVisits;
const O = schema.pmOccurrences;
const engineer = alias(schema.users, 'ov_engineer');

const OPEN_PM = ['planned', 'scheduled', 'rescheduled'];

/** Monday (UTC) of the week containing `day`. */
function weekStart(day: string) {
  const d = new Date(day + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

/** GET /field/overview: today's work, the pipeline, overdue / unassigned visits, engineer load, PM state and a 30-day trend. */
export async function fieldOverview(ctx: Ctx, customerId?: string) {
  const base = visibilityConds(ctx, customerId);
  const whereBase = base.length ? and(...base) : undefined;
  const w = (...extra: (SQL | undefined)[]) => and(...base, ...extra.filter((x): x is SQL => !!x));
  const today = todayStr();
  const tomorrow = addDays(today, 1);
  const wk = weekStart(today);
  const wkEnd = addDays(wk, 7);
  const inDays = (from: string, to: string) => and(sql`${V.scheduledStart} >= ${from}::date`, sql`${V.scheduledStart} < ${to}::date`);
  const status = (s: string) => sql`${V.status} = ${s}`;
  const f = (cond: SQL) => sql<number>`count(*) filter (where ${cond})::int`;

  const [[tiles], statusRows, engineerRows, upcomingRows] = await sequential([
    () => ctx.tx
      .select({
        todayScheduled: f(and(inDays(today, tomorrow), status('scheduled'))!),
        todayInProgress: f(and(inDays(today, tomorrow), status('in_progress'))!),
        todayCompleted: f(and(inDays(today, tomorrow), status('completed'))!),
        weekScheduled: f(and(inDays(wk, wkEnd), status('scheduled'))!),
        weekCompleted: f(and(inDays(wk, wkEnd), status('completed'))!),
        weekCancelled: f(and(inDays(wk, wkEnd), status('cancelled'))!),
        overdue: f(and(status('scheduled'), sql`${V.scheduledStart} < now()`)!),
        unassigned: f(and(inArray(V.status, ['requested', 'scheduled']), isNull(V.engineerId))!),
        awaitingAcknowledgement: f(and(status('completed'), isNull(V.customerAckAt))!),
      })
      .from(V)
      .where(whereBase),
    () => ctx.tx.select({ key: V.status, count: countSql }).from(V).where(w(inDays(today, addDays(today, 31)))).groupBy(V.status),
    () => ctx.tx
      .select({ id: V.engineerId, name: engineer.name, scheduled: f(status('scheduled')), inProgress: f(status('in_progress')) })
      .from(V)
      .leftJoin(engineer, eq(engineer.id, V.engineerId))
      .where(w(inDays(today, addDays(today, 7)), inArray(V.status, ['scheduled', 'in_progress']), isNotNull(V.engineerId)))
      .groupBy(V.engineerId, engineer.name)
      .orderBy(sql`count(*) desc`, asc(engineer.name))
      .limit(10),
    () => ctx.tx
      .select({ id: V.id, number: V.number, title: V.title, customerName: schema.customers.name, siteName: schema.sites.name, engineerName: engineer.name, scheduledStart: V.scheduledStart, status: V.status })
      .from(V)
      .leftJoin(schema.customers, eq(schema.customers.id, V.customerId))
      .leftJoin(schema.sites, eq(schema.sites.id, V.siteId))
      .leftJoin(engineer, eq(engineer.id, V.engineerId))
      .where(w(inArray(V.status, ['requested', 'scheduled', 'in_progress']), isNotNull(V.scheduledStart), sql`${V.scheduledStart} >= ${today}::date`))
      .orderBy(asc(V.scheduledStart), asc(V.number))
      .limit(10),
  ]);

  // Preventive maintenance figures are only shown to people who may read PM data.
  const canPm = !isCustomerUser(ctx) && (ctx.can('pm:read', customerId ?? null) || ctx.can('pm:manage', customerId ?? null));
  let pm: { dueThisMonth: number; overdue: number; completedThisMonth: number; byStatus: Bucket[] } = { dueThisMonth: 0, overdue: 0, completedThisMonth: 0, byStatus: fixedBuckets(PM_STATUSES, [], { colors: PM_STATUS_COLORS }) };
  if (canPm) {
    const mStart = monthStart(today);
    const mEnd = monthStart(today, 1);
    const due = sql`coalesce(${O.scheduledDate}, ${O.plannedDate})`;
    const pmBase: SQL[] = customerId ? [eq(O.customerId, customerId)] : [];
    const [[pmTiles], pmStatusRows] = await sequential([
      () => ctx.tx
        .select({
          dueThisMonth: f(and(inArray(O.status, OPEN_PM), sql`${due} >= ${mStart}::date`, sql`${due} < ${mEnd}::date`)!),
          overdue: f(and(inArray(O.status, OPEN_PM), lt(due, sql`${today}::date`))!),
          completedThisMonth: f(and(eq(O.status, 'completed'), sql`${O.completedAt} >= ${mStart}::date`, sql`${O.completedAt} < ${mEnd}::date`)!),
        })
        .from(O)
        .where(pmBase.length ? and(...pmBase) : undefined),
      () => ctx.tx.select({ key: O.status, count: countSql }).from(O).where(and(...pmBase, sql`${due} >= ${mStart}::date`, sql`${due} < ${mEnd}::date`)).groupBy(O.status),
    ]);
    pm = { dueThisMonth: pmTiles?.dueThisMonth ?? 0, overdue: pmTiles?.overdue ?? 0, completedThisMonth: pmTiles?.completedThisMonth ?? 0, byStatus: fixedBuckets(PM_STATUSES, pmStatusRows, { colors: PM_STATUS_COLORS }) };
  }

  const days = await dailySeries(ctx, addDays(today, -29), today, customerId ?? null);

  return {
    today: { scheduled: tiles?.todayScheduled ?? 0, inProgress: tiles?.todayInProgress ?? 0, completed: tiles?.todayCompleted ?? 0 },
    week: { scheduled: tiles?.weekScheduled ?? 0, completed: tiles?.weekCompleted ?? 0, cancelled: tiles?.weekCancelled ?? 0 },
    byStatus: fixedBuckets(FIELD_VISIT_STATUSES, statusRows, { colors: VISIT_STATUS_COLORS }),
    overdue: tiles?.overdue ?? 0,
    unassigned: tiles?.unassigned ?? 0,
    awaitingAcknowledgement: tiles?.awaitingAcknowledgement ?? 0,
    byEngineer: engineerRows.map((r) => ({ id: r.id!, name: r.name ?? 'Unknown', scheduled: r.scheduled, inProgress: r.inProgress })),
    pm,
    series: days.map((d) => ({ day: d.day, visitsCompleted: num(d.visitsCompleted), pmCompleted: canPm ? num(d.pmCompleted) : 0 })),
    upcoming: upcomingRows.map((r) => ({ id: r.id, number: r.number, title: r.title, customerName: r.customerName ?? '', siteName: r.siteName, engineerName: r.engineerName, scheduledStart: r.scheduledStart!.toISOString(), status: r.status })),
  };
}
