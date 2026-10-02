/**
 * Backdating of seeded tickets. The ticket services stamp "now" on everything
 * they write; after a ticket's lifecycle has been replayed we map every row
 * written during a phase (creation, assignment, first response, ...) onto the
 * intended historical time and rewrite the SLA rows from the intended
 * timeline using the calendar snapshot the engine stored.
 */
import { eq, inArray, sql, and, gte } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { addWorkingMinutes, workingMinutesBetween } from '@/lib/calendar';
import { calendarOf, formatMinutes, metricLabel } from '@/modules/sla/engine';
import { MINUTE } from './rng';

export interface Phase {
  real: Date;
  at: Date;
}

export interface Timeline {
  createdAt: Date;
  acknowledgedAt: Date | null;
  firstResponseAt: Date | null;
  /** Pause intervals (pending / awaiting approval); `null` end = still paused. */
  pauses: [Date, Date | null][];
  /** First resolution (before a reopen). */
  firstResolvedAt: Date | null;
  reopenedAt: Date | null;
  /** Final resolution (null when open). */
  resolvedAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  lastActivityAt: Date;
}

export interface TicketRun {
  ticketId: string;
  customerId: string;
  number: string;
  phases: Phase[];
  tl: Timeline;
  /** Explicit times for rows whose timestamps come from the database clock. */
  timeEntries: { id: string; at: Date; consumptionId: string | null }[];
  tasks: { id: string; createdAt: Date; completedAt: Date | null }[];
  approvalsRequestedAt: Date | null;
  escalations: Date[];
  audit: { action: string; at: Date; userId: string | null; userName: string | null }[];
}

export function mapTime(phases: Phase[], real: Date): Date {
  let k = 0;
  const r = real.getTime();
  for (let i = 0; i < phases.length; i++) if (phases[i]!.real.getTime() <= r) k = i;
  const p = phases[k]!;
  const offset = Math.max(0, Math.min(r - p.real.getTime(), 90_000));
  return new Date(p.at.getTime() + offset);
}

type SlaRow = typeof schema.ticketSlas.$inferSelect;

interface SlaRewrite {
  id: string;
  state: SlaRow['state'];
  startedAt: Date;
  dueAt: Date;
  pausedAt: Date | null;
  pausedMinutes: number;
  warnedAt: Date | null;
  completedAt: Date | null;
  breachedAt: Date | null;
  elapsed: number | null;
  target: number;
  metric: SlaRow['metric'];
  ticketId: string;
  customerId: string;
}

function clip(a: Date, b: Date, lo: Date, hi: Date): [Date, Date] | null {
  const s = Math.max(a.getTime(), lo.getTime());
  const e = Math.min(b.getTime(), hi.getTime());
  return e > s ? [new Date(s), new Date(e)] : null;
}

export function rewriteSla(row: SlaRow, tl: Timeline, now: Date): SlaRewrite {
  const cal = calendarOf(row);
  const restart = !!tl.reopenedAt && (row.metric === 'resolution' || row.metric === 'restoration');
  const started = restart ? tl.reopenedAt! : tl.createdAt;
  const firstDone = tl.firstResolvedAt ?? tl.resolvedAt;
  let satisfied: Date | null;
  switch (row.metric) {
    case 'acknowledgement':
      satisfied = tl.acknowledgedAt ?? tl.firstResponseAt ?? firstDone;
      break;
    case 'response':
      satisfied = tl.firstResponseAt ?? firstDone;
      break;
    default:
      satisfied = tl.resolvedAt;
  }
  if (satisfied && satisfied.getTime() < started.getTime()) satisfied = started;
  const end = satisfied ?? tl.cancelledAt ?? now;
  // Completed pauses before the end of the clock.
  let pausedMinutes = 0;
  let openPause: Date | null = null;
  for (const [a, b] of tl.pauses) {
    if (!b) {
      if (!satisfied && !tl.cancelledAt && a.getTime() >= started.getTime()) openPause = a;
      continue;
    }
    const c = clip(a, b, started, end);
    if (c) pausedMinutes += Math.round(workingMinutesBetween(c[0], c[1], cal));
  }
  const dueAt = addWorkingMinutes(started, row.targetMinutes + pausedMinutes, cal);
  const warnMinutes = (row.targetMinutes * row.warnPct) / 100;
  const base = { id: row.id, startedAt: started, dueAt, pausedMinutes, target: row.targetMinutes, metric: row.metric, ticketId: row.ticketId, customerId: row.customerId };
  if (!satisfied && tl.cancelledAt) {
    const elapsed = Math.max(0, Math.round(workingMinutesBetween(started, tl.cancelledAt, cal) - pausedMinutes));
    return { ...base, state: 'cancelled', pausedAt: null, warnedAt: null, completedAt: tl.cancelledAt, breachedAt: null, elapsed };
  }
  if (satisfied) {
    const elapsed = Math.max(0, Math.round(workingMinutesBetween(started, satisfied, cal) - pausedMinutes));
    const met = elapsed <= row.targetMinutes;
    const warnedAt = elapsed >= warnMinutes ? addWorkingMinutes(started, warnMinutes + pausedMinutes, cal) : null;
    return { ...base, state: met ? 'met' : 'breached', pausedAt: null, warnedAt, completedAt: satisfied, breachedAt: met ? null : dueAt.getTime() < satisfied.getTime() ? dueAt : satisfied, elapsed };
  }
  const measuredTo = openPause ?? now;
  const elapsed = Math.max(0, Math.round(workingMinutesBetween(started, measuredTo, cal) - pausedMinutes));
  const warnedAt = elapsed >= warnMinutes ? addWorkingMinutes(started, warnMinutes + pausedMinutes, cal) : null;
  if (openPause) return { ...base, state: 'paused', pausedAt: openPause, warnedAt, completedAt: null, breachedAt: null, elapsed: null };
  if (dueAt.getTime() < now.getTime()) return { ...base, state: 'breached', pausedAt: null, warnedAt: warnedAt ?? dueAt, completedAt: null, breachedAt: dueAt, elapsed: null };
  return { ...base, state: 'running', pausedAt: null, warnedAt, completedAt: null, breachedAt: null, elapsed: null };
}

const ts = (d: Date | null) => sql`${d ? d.toISOString() : null}::timestamptz`;

async function batchTimestamp(tx: Tx, table: string, column: string, pairs: [string, Date][]) {
  for (let i = 0; i < pairs.length; i += 400) {
    const chunk = pairs.slice(i, i + 400);
    const values = sql.join(chunk.map(([id, d]) => sql`(${id}::uuid, ${d.toISOString()}::timestamptz)`), sql`, `);
    await tx.execute(sql`UPDATE ${sql.raw(table)} AS tgt SET ${sql.raw(column)} = v.ts FROM (VALUES ${values}) AS v(id, ts) WHERE tgt.id = v.id`);
  }
}

/** Applies the intended timeline to every row the services wrote for the given tickets. */
export async function backdateRuns(tx: Tx, runs: TicketRun[], now: Date) {
  if (!runs.length) return { slaRows: 0 };
  const byTicket = new Map(runs.map((r) => [r.ticketId, r]));
  const ids = runs.map((r) => r.ticketId);

  // --- activities, comments, SLA events (Node-clock timestamps → phase mapping)
  const activities = await tx.select({ id: schema.ticketActivities.id, ticketId: schema.ticketActivities.ticketId, createdAt: schema.ticketActivities.createdAt, type: schema.ticketActivities.activityType, data: schema.ticketActivities.data }).from(schema.ticketActivities).where(inArray(schema.ticketActivities.ticketId, ids));
  await batchTimestamp(tx, 'ticket_activities', 'created_at', activities.map((a) => [a.id, mapTime(byTicket.get(a.ticketId)!.phases, a.createdAt)]));
  const comments = await tx.select({ id: schema.ticketComments.id, ticketId: schema.ticketComments.ticketId, createdAt: schema.ticketComments.createdAt }).from(schema.ticketComments).where(inArray(schema.ticketComments.ticketId, ids));
  await batchTimestamp(tx, 'ticket_comments', 'created_at', comments.map((c) => [c.id, mapTime(byTicket.get(c.ticketId)!.phases, c.createdAt)]));
  const slaRows = await tx.select().from(schema.ticketSlas).where(inArray(schema.ticketSlas.ticketId, ids));
  const slaIds = slaRows.map((r) => r.id);
  const events = slaIds.length ? await tx.select({ id: schema.ticketSlaEvents.id, slaId: schema.ticketSlaEvents.ticketSlaId, type: schema.ticketSlaEvents.eventType, at: schema.ticketSlaEvents.occurredAt }).from(schema.ticketSlaEvents).where(inArray(schema.ticketSlaEvents.ticketSlaId, slaIds)) : [];
  const slaTicket = new Map(slaRows.map((r) => [r.id, r.ticketId]));
  await batchTimestamp(tx, 'ticket_sla_events', 'occurred_at', events.map((e) => [e.id, mapTime(byTicket.get(slaTicket.get(e.slaId)!)!.phases, e.at)]));
  // Approval decisions and task completion were stamped with the Node clock too.
  const approvals = await tx.select({ id: schema.approvals.id, ticketId: schema.approvals.ticketId, decidedAt: schema.approvals.decidedAt }).from(schema.approvals).where(inArray(schema.approvals.ticketId, ids));
  await batchTimestamp(tx, 'approvals', 'decided_at', approvals.filter((a) => a.decidedAt).map((a) => [a.id, mapTime(byTicket.get(a.ticketId)!.phases, a.decidedAt!)]));
  await batchTimestamp(tx, 'approvals', 'created_at', approvals.map((a) => [a.id, byTicket.get(a.ticketId)!.approvalsRequestedAt ?? byTicket.get(a.ticketId)!.tl.createdAt]));

  // --- SLA rows from the intended timeline
  const rewrites = slaRows.map((row) => rewriteSla(row, byTicket.get(row.ticketId)!.tl, now));
  for (let i = 0; i < rewrites.length; i += 200) {
    const chunk = rewrites.slice(i, i + 200);
    const values = sql.join(
      chunk.map((r) => sql`(${r.id}::uuid, ${r.state}::sla_state, ${ts(r.startedAt)}, ${ts(r.dueAt)}, ${ts(r.pausedAt)}, ${r.pausedMinutes}::int, ${ts(r.warnedAt)}, ${ts(r.completedAt)}, ${ts(r.breachedAt)}, ${r.elapsed}::int)`),
      sql`, `,
    );
    await tx.execute(sql`UPDATE ticket_slas AS s SET state = v.state, started_at = v.started_at, due_at = v.due_at, paused_at = v.paused_at, paused_minutes = v.paused_minutes, warned_at = v.warned_at, completed_at = v.completed_at, breached_at = v.breached_at, elapsed_minutes_at_completion = v.elapsed, updated_at = coalesce(v.completed_at, v.breached_at, v.paused_at, v.started_at), created_at = v.started_at
      FROM (VALUES ${values}) AS v(id, state, started_at, due_at, paused_at, paused_minutes, warned_at, completed_at, breached_at, elapsed) WHERE s.id = v.id`);
  }
  // SLA event details and engine activities must tell the same story as the rows.
  for (const r of rewrites) {
    if (r.completedAt && (r.state === 'met' || r.state === 'breached')) {
      await tx.execute(sql`UPDATE ticket_sla_events SET details = details || jsonb_build_object('state', ${r.state}::text, 'elapsedMinutes', ${r.elapsed}::int) WHERE ticket_sla_id = ${r.id}::uuid AND event_type = 'completed'`);
      await tx.execute(sql`UPDATE ticket_activities SET summary = ${`${metricLabel(r.metric)} SLA ${r.state === 'met' ? 'met' : 'breached'} (${formatMinutes(r.elapsed ?? 0)} of ${formatMinutes(r.target)})`}, data = data || jsonb_build_object('state', ${r.state}::text, 'elapsedMinutes', ${r.elapsed}::int) WHERE ticket_id = ${r.ticketId}::uuid AND activity_type = 'sla' AND data->>'slaId' = ${r.id}`);
    }
    await tx.execute(sql`UPDATE ticket_sla_events SET details = details || jsonb_build_object('dueAt', ${r.dueAt.toISOString()}::text) WHERE ticket_sla_id = ${r.id}::uuid AND event_type IN ('started', 'recalculated', 'reopened', 'resumed')`);
    if (r.state === 'breached' && r.breachedAt) {
      await tx.insert(schema.ticketSlaEvents).values({ ticketSlaId: r.id, customerId: r.customerId, eventType: 'breached', details: { dueAt: r.dueAt, source: 'processor' }, occurredAt: r.breachedAt });
    }
    if (r.warnedAt) await tx.insert(schema.ticketSlaEvents).values({ ticketSlaId: r.id, customerId: r.customerId, eventType: 'warning', details: { pct: 75, dueAt: r.dueAt }, occurredAt: r.warnedAt });
  }

  // --- tickets
  const dueByTicket = new Map<string, Date>();
  for (const r of rewrites) {
    if (r.metric === 'resolution') dueByTicket.set(r.ticketId, r.dueAt);
    else if (r.metric === 'restoration' && !dueByTicket.has(r.ticketId)) dueByTicket.set(r.ticketId, r.dueAt);
  }
  for (const run of runs) {
    const tl = run.tl;
    const firstResponse = tl.firstResponseAt ?? tl.firstResolvedAt ?? tl.resolvedAt;
    const acknowledged = tl.acknowledgedAt ?? firstResponse;
    await tx
      .update(schema.tickets)
      .set({
        createdAt: tl.createdAt,
        updatedAt: tl.lastActivityAt,
        lastActivityAt: tl.lastActivityAt,
        firstResponseAt: firstResponse,
        acknowledgedAt: acknowledged,
        restoredAt: tl.resolvedAt,
        resolvedAt: tl.resolvedAt,
        closedAt: tl.closedAt ?? tl.cancelledAt,
        dueAt: dueByTicket.get(run.ticketId) ?? null,
      })
      .where(eq(schema.tickets.id, run.ticketId));
  }

  // --- rows stamped by the database clock
  const te = runs.flatMap((r) => r.timeEntries);
  if (te.length) {
    await batchTimestamp(tx, 'time_entries', 'created_at', te.map((e) => [e.id, e.at]));
    await batchTimestamp(tx, 'time_entries', 'updated_at', te.map((e) => [e.id, e.at]));
    await batchTimestamp(tx, 'time_entries', 'started_at', te.map((e) => [e.id, e.at]));
    const cons = te.filter((e) => e.consumptionId).map((e): [string, Date] => [e.consumptionId!, e.at]);
    if (cons.length) {
      await batchTimestamp(tx, 'entitlement_consumptions', 'consumed_at', cons);
      await batchTimestamp(tx, 'entitlement_consumptions', 'created_at', cons);
    }
  }
  const tasks = runs.flatMap((r) => r.tasks);
  if (tasks.length) {
    await batchTimestamp(tx, 'ticket_tasks', 'created_at', tasks.map((t) => [t.id, t.createdAt]));
    await batchTimestamp(tx, 'ticket_tasks', 'updated_at', tasks.map((t) => [t.id, t.completedAt ?? t.createdAt]));
    await batchTimestamp(tx, 'ticket_tasks', 'completed_at', tasks.filter((t) => t.completedAt).map((t) => [t.id, t.completedAt!]));
  }
  for (const run of runs) {
    if (!run.escalations.length) continue;
    const rows = await tx.select({ id: schema.escalationLog.id }).from(schema.escalationLog).where(eq(schema.escalationLog.ticketId, run.ticketId)).orderBy(schema.escalationLog.occurredAt, schema.escalationLog.level);
    await batchTimestamp(tx, 'escalation_log', 'occurred_at', rows.map((row, i): [string, Date] => [row.id, run.escalations[Math.min(i, run.escalations.length - 1)]!]));
  }

  // --- audit: the services audited everything "now"; replace with a compact backdated trail.
  await tx.delete(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'ticket'), inArray(schema.auditLog.entityId, ids), gte(schema.auditLog.occurredAt, new Date(now.getTime() - 24 * 60 * MINUTE))));
  const auditRows = runs.flatMap((r) =>
    r.audit.map((a) => ({ occurredAt: a.at, userId: a.userId, userName: a.userName, customerId: r.customerId, entityType: 'ticket', entityId: r.ticketId, entityLabel: r.number, action: a.action, changes: {}, source: a.userId ? 'ui' : 'system', requestId: 'demo-seed', metadata: { seeded: true } })),
  );
  for (let i = 0; i < auditRows.length; i += 500) await tx.insert(schema.auditLog).values(auditRows.slice(i, i + 500));
  return { slaRows: rewrites.length };
}
