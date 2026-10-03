import { eq, and, inArray, or, isNull, sql } from 'drizzle-orm';
import type { SlaMetric } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { addWorkingMinutes, workingMinutesBetween, type CalendarDef } from '@/lib/calendar';
import { selectPolicy, resolveCalendar } from './select';

/**
 * SLA engine: creates one `ticket_slas` row per applicable metric, keeps the
 * clocks in sync with status changes (pause/resume/complete/reopen) and
 * computes live summaries. Every change is recorded in `ticket_sla_events`.
 *
 * All functions take a transaction so they run atomically with the ticket
 * operation that triggered them; the HTTP layer passes `ctx.tx`.
 */

export type TicketRow = typeof schema.tickets.$inferSelect;
export type SlaRow = typeof schema.ticketSlas.$inferSelect;
export type StatusOption = typeof schema.configOptions.$inferSelect;

export interface SlaActor {
  id: string | null;
  name: string | null;
}

export const SYSTEM_ACTOR: SlaActor = { id: null, name: 'System' };

const METRIC_LABEL: Record<SlaMetric, string> = { acknowledgement: 'Acknowledgement', response: 'Response', restoration: 'Restoration', resolution: 'Resolution' };
export const metricLabel = (m: string) => METRIC_LABEL[m as SlaMetric] ?? m;

/** Ticket timestamp that satisfies each metric. */
const SATISFIED_AT: Record<SlaMetric, 'acknowledgedAt' | 'firstResponseAt' | 'restoredAt' | 'resolvedAt'> = {
  acknowledgement: 'acknowledgedAt',
  response: 'firstResponseAt',
  restoration: 'restoredAt',
  resolution: 'resolvedAt',
};

export function calendarOf(row: Pick<SlaRow, 'calendarSnapshot' | 'calendarTime'>): CalendarDef {
  const s = (row.calendarSnapshot ?? {}) as Partial<CalendarDef>;
  return { timezone: s.timezone ?? 'UTC', is24x7: s.is24x7 ?? row.calendarTime, hours: s.hours ?? {}, holidays: s.holidays ?? [] };
}

const isOpenRow = (r: SlaRow) => (r.state === 'running' || r.state === 'paused' || r.state === 'breached') && !r.completedAt;

/** Working minutes consumed so far (live for open rows, frozen for completed ones). */
export function elapsedMinutes(row: SlaRow, now = new Date()): number {
  if (row.completedAt && row.elapsedMinutesAtCompletion !== null) return row.elapsedMinutesAtCompletion;
  if (row.state === 'cancelled') return row.elapsedMinutesAtCompletion ?? 0;
  const cal = calendarOf(row);
  const end = row.state === 'paused' && row.pausedAt ? row.pausedAt : now;
  return Math.max(0, workingMinutesBetween(row.startedAt, end, cal) - row.pausedMinutes);
}

async function addEvent(tx: Tx, row: Pick<SlaRow, 'id' | 'customerId'>, eventType: string, details: Record<string, unknown> = {}, at = new Date()) {
  await tx.insert(schema.ticketSlaEvents).values({ ticketSlaId: row.id, customerId: row.customerId, eventType, details, occurredAt: at });
}

async function addActivity(tx: Tx, ticket: Pick<TicketRow, 'id' | 'customerId'>, actor: SlaActor, summary: string, data: Record<string, unknown> = {}) {
  await tx.insert(schema.ticketActivities).values({ ticketId: ticket.id, customerId: ticket.customerId, actorId: actor.id, actorName: actor.name, activityType: 'sla', summary, data, customerVisible: false, createdAt: new Date() });
}

/** Keeps `tickets.due_at` = earliest open resolution/restoration due date (used for list sorting and "due today"). */
export async function refreshTicketDue(tx: Tx, ticketId: string) {
  const rows = await tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, ticketId));
  const open = rows.filter(isOpenRow);
  const primary = open.filter((r) => r.metric === 'resolution' || r.metric === 'restoration');
  const pool = primary.length ? primary : open;
  const due = pool.length ? new Date(Math.min(...pool.map((r) => r.dueAt.getTime()))) : null;
  await tx.update(schema.tickets).set({ dueAt: due }).where(eq(schema.tickets.id, ticketId));
  return due;
}

export async function statusPausesSla(tx: Tx, statusId: string, policyId: string | null | undefined): Promise<boolean> {
  const [opt] = await tx.select({ pausesSla: schema.configOptions.pausesSla }).from(schema.configOptions).where(eq(schema.configOptions.id, statusId)).limit(1);
  if (opt?.pausesSla) return true;
  if (!policyId) return false;
  const [row] = await tx
    .select({ statusId: schema.slaPauseStatuses.statusId })
    .from(schema.slaPauseStatuses)
    .where(and(eq(schema.slaPauseStatuses.policyId, policyId), eq(schema.slaPauseStatuses.statusId, statusId)))
    .limit(1);
  return !!row;
}

export const activeSlaRows = (tx: Tx, ticketId: string) =>
  tx
    .select()
    .from(schema.ticketSlas)
    .where(and(eq(schema.ticketSlas.ticketId, ticketId), or(inArray(schema.ticketSlas.state, ['running', 'paused']), and(eq(schema.ticketSlas.state, 'breached'), isNull(schema.ticketSlas.completedAt)))));

/** Completes an open row: met when within target, breached otherwise. */
async function completeRow(tx: Tx, row: SlaRow, at: Date, actor: SlaActor, ticket: Pick<TicketRow, 'id' | 'customerId'>, reason: string) {
  const elapsed = Math.round(elapsedMinutes(row, at));
  const met = row.state === 'breached' ? false : row.state === 'paused' ? elapsed <= row.targetMinutes : at.getTime() <= row.dueAt.getTime();
  const state = met ? 'met' : 'breached';
  const [updated] = await tx
    .update(schema.ticketSlas)
    .set({ state, completedAt: at, breachedAt: met ? row.breachedAt : (row.breachedAt ?? at), elapsedMinutesAtCompletion: elapsed, pausedAt: null, updatedAt: at })
    .where(eq(schema.ticketSlas.id, row.id))
    .returning();
  await addEvent(tx, row, 'completed', { state, elapsedMinutes: elapsed, reason }, at);
  await addActivity(tx, ticket, actor, `${metricLabel(row.metric)} SLA ${met ? 'met' : 'breached'} (${formatMinutes(elapsed)} of ${formatMinutes(row.targetMinutes)})`, { metric: row.metric, state, elapsedMinutes: elapsed, targetMinutes: row.targetMinutes, slaId: row.id });
  return updated;
}

export function formatMinutes(min: number) {
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

export interface ApplyOptions {
  /** Known pause state of the current status (skips a lookup). */
  statusPausesSla?: boolean;
  reason?: string;
}

/**
 * (Re)applies SLA targets to a ticket: selects the policy, creates or
 * recalculates one row per metric. Rows already completed (met/breached with
 * a completion time) are preserved so history is never rewritten; metrics
 * already satisfied by ticket timestamps complete immediately.
 */
export async function applySlas(tx: Tx, ticket: TicketRow, actor: SlaActor, opts: ApplyOptions = {}): Promise<SlaRow[]> {
  const existing = await tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, ticket.id));
  const byMetric = new Map(existing.map((r) => [r.metric, r]));
  const now = new Date();
  const sel = await selectPolicy(tx, { ticketType: ticket.type, customerId: ticket.customerId, serviceId: ticket.serviceId, contractId: ticket.contractId, catalogItemId: ticket.catalogItemId, explicitPolicyId: ticket.slaPolicyId });
  const cancelOrphans = async (keep: Set<string>) => {
    for (const prev of existing) {
      if (keep.has(prev.metric) || !isOpenRow(prev)) continue;
      await tx.update(schema.ticketSlas).set({ state: 'cancelled', completedAt: now, elapsedMinutesAtCompletion: Math.round(elapsedMinutes(prev, now)), pausedAt: null, updatedAt: now }).where(eq(schema.ticketSlas.id, prev.id));
      await addEvent(tx, prev, 'cancelled', { reason: 'no_target' }, now);
    }
  };
  if (!sel) {
    await cancelOrphans(new Set());
    await refreshTicketDue(tx, ticket.id);
    return [];
  }
  const [policy] = await tx.select().from(schema.slaPolicies).where(eq(schema.slaPolicies.id, sel.policyId)).limit(1);
  if (!policy) {
    await cancelOrphans(new Set());
    await refreshTicketDue(tx, ticket.id);
    return [];
  }
  const targets = await tx
    .select()
    .from(schema.slaTargets)
    .where(and(eq(schema.slaTargets.policyId, policy.id), eq(schema.slaTargets.ticketType, ticket.type), ticket.priorityId ? or(eq(schema.slaTargets.priorityId, ticket.priorityId), isNull(schema.slaTargets.priorityId)) : isNull(schema.slaTargets.priorityId)));
  // Priority-specific targets win over the NULL-priority fallback.
  const chosen = new Map<SlaMetric, (typeof targets)[number]>();
  for (const t of targets) {
    const cur = chosen.get(t.metric);
    if (!cur || (cur.priorityId === null && t.priorityId !== null)) chosen.set(t.metric, t);
  }
  const paused = opts.statusPausesSla ?? (await statusPausesSla(tx, ticket.statusId, policy.id));
  const result: SlaRow[] = [];
  const applied: string[] = [];
  for (const [metric, t] of chosen) {
    const prev = byMetric.get(metric);
    if (prev && prev.completedAt) {
      result.push(prev);
      continue;
    }
    const cal = await resolveCalendar(tx, { policy, contractId: ticket.contractId, serviceId: ticket.serviceId, calendarTime: t.calendarTime });
    const pausedMinutes = prev?.pausedMinutes ?? 0;
    const startedAt = prev?.startedAt ?? ticket.createdAt;
    const dueAt = addWorkingMinutes(startedAt, t.minutes + pausedMinutes, cal);
    const satisfiedAt = ticket[SATISFIED_AT[metric]];
    const values: typeof schema.ticketSlas.$inferInsert = {
      ticketId: ticket.id,
      customerId: ticket.customerId,
      policyId: policy.id,
      metric,
      targetMinutes: t.minutes,
      warnPct: t.warnPct,
      calendarTime: t.calendarTime,
      calendarSnapshot: cal as unknown as Record<string, unknown>,
      startedAt,
      dueAt,
      pausedMinutes,
      pausedAt: null,
      state: 'running',
      warnedAt: null,
      completedAt: null,
      breachedAt: null,
      elapsedMinutesAtCompletion: null,
      updatedAt: now,
    };
    if (satisfiedAt) {
      const elapsed = Math.max(0, Math.round(workingMinutesBetween(startedAt, satisfiedAt, cal) - pausedMinutes));
      const met = elapsed <= t.minutes;
      Object.assign(values, { state: met ? 'met' : 'breached', completedAt: satisfiedAt, breachedAt: met ? null : satisfiedAt, elapsedMinutesAtCompletion: elapsed });
    } else if (paused) {
      Object.assign(values, { state: 'paused', pausedAt: prev?.pausedAt ?? now });
    } else if (dueAt.getTime() < now.getTime()) {
      // Recalculated into the past (e.g. priority raised late): the processor would breach it on the next tick; do it now for consistency.
      Object.assign(values, { state: 'breached', breachedAt: now });
    }
    let row: SlaRow;
    if (prev) {
      [row] = await tx.update(schema.ticketSlas).set(values).where(eq(schema.ticketSlas.id, prev.id)).returning();
      await addEvent(tx, row, 'recalculated', { targetMinutes: t.minutes, dueAt, source: sel.source, reason: opts.reason ?? 'recalculated' }, now);
    } else {
      [row] = await tx.insert(schema.ticketSlas).values(values).returning();
      await addEvent(tx, row, 'started', { targetMinutes: t.minutes, dueAt, source: sel.source, state: row.state }, now);
    }
    applied.push(`${metricLabel(metric)} ${formatMinutes(t.minutes)}`);
    result.push(row);
  }
  await cancelOrphans(new Set(chosen.keys()));
  await refreshTicketDue(tx, ticket.id);
  if (applied.length) await addActivity(tx, ticket, actor, `SLA ${opts.reason === 'recalculated' || existing.length ? 'recalculated' : 'applied'} (${policy.name}): ${applied.join(', ')}`, { policyId: policy.id, policyName: policy.name, source: sel.source, metrics: result.map((r) => ({ metric: r.metric, dueAt: r.dueAt, state: r.state })) });
  return result;
}

/**
 * Status transition hook. Pausing statuses stop running clocks; leaving them
 * resumes with the paused working time added to the target; resolved/closed
 * complete the clocks; cancelled cancels them; reopening restarts
 * resolution/restoration from now.
 */
export async function onStatusChange(tx: Tx, ticket: TicketRow, fromStatus: StatusOption | null, toStatus: StatusOption, actor: SlaActor) {
  const now = new Date();
  const rows = await tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, ticket.id));
  if (!rows.length) return;
  const policyId = rows[0]?.policyId ?? ticket.slaPolicyId;
  const toCat = toStatus.statusCategory;
  const fromCat = fromStatus?.statusCategory ?? null;
  const open = rows.filter(isOpenRow);

  if (toCat === 'resolved' || toCat === 'closed') {
    for (const r of open) await completeRow(tx, r, now, actor, ticket, toCat);
  } else if (toCat === 'cancelled') {
    for (const r of open) {
      const elapsed = Math.round(elapsedMinutes(r, now));
      const state = r.state === 'breached' ? 'breached' : 'cancelled';
      await tx.update(schema.ticketSlas).set({ state, completedAt: now, elapsedMinutesAtCompletion: elapsed, pausedAt: null, updatedAt: now }).where(eq(schema.ticketSlas.id, r.id));
      await addEvent(tx, r, 'cancelled', { reason: 'ticket_cancelled', elapsedMinutes: elapsed }, now);
    }
    await addActivity(tx, ticket, actor, 'SLA clocks cancelled', { reason: 'ticket_cancelled' });
  } else {
    const toPauses = await statusPausesSla(tx, toStatus.id, policyId);
    const reopened = fromCat === 'resolved' || fromCat === 'closed' || fromCat === 'cancelled';
    if (reopened) {
      for (const metric of ['resolution', 'restoration'] as SlaMetric[]) {
        const r = rows.find((x) => x.metric === metric);
        if (!r || isOpenRow(r)) continue;
        const cal = calendarOf(r);
        const dueAt = addWorkingMinutes(now, r.targetMinutes, cal);
        await tx
          .update(schema.ticketSlas)
          .set({ state: toPauses ? 'paused' : 'running', startedAt: now, dueAt, pausedMinutes: 0, pausedAt: toPauses ? now : null, warnedAt: null, completedAt: null, breachedAt: null, elapsedMinutesAtCompletion: null, updatedAt: now })
          .where(eq(schema.ticketSlas.id, r.id));
        await addEvent(tx, r, 'reopened', { dueAt, previousState: r.state }, now);
      }
      await addActivity(tx, ticket, actor, 'SLA clocks restarted after reopen', { reopenCount: ticket.reopenCount });
    }
    if (toPauses) {
      const running = open.filter((r) => r.state === 'running');
      for (const r of running) {
        await tx.update(schema.ticketSlas).set({ state: 'paused', pausedAt: now, updatedAt: now }).where(eq(schema.ticketSlas.id, r.id));
        await addEvent(tx, r, 'paused', { status: toStatus.key }, now);
      }
      if (running.length) await addActivity(tx, ticket, actor, `SLA clock paused (${toStatus.label})`, { status: toStatus.key, metrics: running.map((r) => r.metric) });
    } else {
      const paused = open.filter((r) => r.state === 'paused' && r.pausedAt);
      for (const r of paused) {
        const cal = calendarOf(r);
        const pausedMinutes = r.pausedMinutes + Math.round(workingMinutesBetween(r.pausedAt!, now, cal));
        const dueAt = addWorkingMinutes(r.startedAt, r.targetMinutes + pausedMinutes, cal);
        await tx.update(schema.ticketSlas).set({ state: 'running', pausedAt: null, pausedMinutes, dueAt, updatedAt: now }).where(eq(schema.ticketSlas.id, r.id));
        await addEvent(tx, r, 'resumed', { status: toStatus.key, pausedMinutes, dueAt }, now);
      }
      if (paused.length) await addActivity(tx, ticket, actor, `SLA clock resumed (${toStatus.label})`, { status: toStatus.key, metrics: paused.map((r) => r.metric) });
    }
  }
  await refreshTicketDue(tx, ticket.id);
}

async function completeMetrics(tx: Tx, ticket: TicketRow, metrics: SlaMetric[], actor: SlaActor, at: Date, reason: string) {
  const rows = await activeSlaRows(tx, ticket.id);
  const out: SlaRow[] = [];
  for (const r of rows) if (metrics.includes(r.metric)) out.push(await completeRow(tx, r, at, actor, ticket, reason));
  if (out.length) await refreshTicketDue(tx, ticket.id);
  return out;
}

/** First MSP response: completes response + acknowledgement clocks. */
export const markResponded = (tx: Tx, ticket: TicketRow, actor: SlaActor, at = new Date()) => completeMetrics(tx, ticket, ['response', 'acknowledgement'], actor, at, 'responded');
export const markAcknowledged = (tx: Tx, ticket: TicketRow, actor: SlaActor, at = new Date()) => completeMetrics(tx, ticket, ['acknowledgement'], actor, at, 'acknowledged');
export const markRestored = (tx: Tx, ticket: TicketRow, actor: SlaActor, at = new Date()) => completeMetrics(tx, ticket, ['restoration'], actor, at, 'restored');

/** Marks a running row as breached (processor). */
export async function markBreached(tx: Tx, row: SlaRow, at = new Date()) {
  const [updated] = await tx.update(schema.ticketSlas).set({ state: 'breached', breachedAt: at, updatedAt: at }).where(and(eq(schema.ticketSlas.id, row.id), eq(schema.ticketSlas.state, 'running'))).returning();
  if (updated) await addEvent(tx, row, 'breached', { dueAt: row.dueAt }, at);
  return updated ?? null;
}

export async function markWarned(tx: Tx, row: SlaRow, pct: number, at = new Date()) {
  const [updated] = await tx.update(schema.ticketSlas).set({ warnedAt: at, updatedAt: at }).where(and(eq(schema.ticketSlas.id, row.id), isNull(schema.ticketSlas.warnedAt))).returning();
  if (updated) await addEvent(tx, row, 'warning', { pct, dueAt: row.dueAt }, at);
  return updated ?? null;
}

// ---------------------------------------------------------------- summaries

export interface SlaMetricSummary {
  id: string;
  metric: SlaMetric;
  label: string;
  state: SlaRow['state'];
  policyId: string | null;
  targetMinutes: number;
  warnPct: number;
  calendarTime: boolean;
  startedAt: Date;
  dueAt: Date;
  pausedAt: Date | null;
  pausedMinutes: number;
  elapsedMinutes: number;
  remainingMinutes: number;
  pctConsumed: number;
  breached: boolean;
  warned: boolean;
  completedAt: Date | null;
  breachedAt: Date | null;
}

export function summarizeRow(row: SlaRow, now = new Date()): SlaMetricSummary {
  const elapsed = Math.round(elapsedMinutes(row, now));
  const remaining = row.targetMinutes - elapsed;
  const pct = row.targetMinutes > 0 ? Math.round((elapsed / row.targetMinutes) * 1000) / 10 : 0;
  const breached = row.state === 'breached' || (row.state === 'running' && now.getTime() > row.dueAt.getTime());
  return {
    id: row.id,
    metric: row.metric,
    label: metricLabel(row.metric),
    state: row.state,
    policyId: row.policyId,
    targetMinutes: row.targetMinutes,
    warnPct: row.warnPct,
    calendarTime: row.calendarTime,
    startedAt: row.startedAt,
    dueAt: row.dueAt,
    pausedAt: row.pausedAt,
    pausedMinutes: row.pausedMinutes,
    elapsedMinutes: elapsed,
    remainingMinutes: remaining,
    pctConsumed: pct,
    breached,
    warned: !!row.warnedAt || pct >= row.warnPct,
    completedAt: row.completedAt,
    breachedAt: row.breachedAt,
  };
}

const METRIC_ORDER: SlaMetric[] = ['acknowledgement', 'response', 'restoration', 'resolution'];

export async function slaSummary(tx: Tx, ticketId: string, now = new Date()): Promise<SlaMetricSummary[]> {
  const rows = await tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, ticketId));
  return rows.map((r) => summarizeRow(r, now)).sort((a, b) => METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric));
}

export async function slaSummariesFor(tx: Tx, ticketIds: string[], now = new Date()): Promise<Map<string, SlaMetricSummary[]>> {
  const map = new Map<string, SlaMetricSummary[]>();
  if (!ticketIds.length) return map;
  const rows = await tx.select().from(schema.ticketSlas).where(inArray(schema.ticketSlas.ticketId, ticketIds));
  for (const r of rows) {
    const list = map.get(r.ticketId) ?? [];
    list.push(summarizeRow(r, now));
    map.set(r.ticketId, list);
  }
  return map;
}

export interface SlaCompact {
  metric: SlaMetric;
  state: SlaRow['state'];
  dueAt: Date;
  pctConsumed: number;
  remainingMinutes: number;
  breached: boolean;
  paused: boolean;
}

/** The worst open metric (breached first, then highest consumption); falls back to the worst completed one. */
export function worstSummary(summaries: SlaMetricSummary[] | undefined): SlaMetricSummary | null {
  if (!summaries?.length) return null;
  const open = summaries.filter((s) => (s.state === 'running' || s.state === 'paused' || s.state === 'breached') && !s.completedAt);
  const pool = open.length ? open : summaries.filter((s) => s.state !== 'cancelled');
  if (!pool.length) return null;
  return [...pool].sort((a, b) => Number(b.breached) - Number(a.breached) || b.pctConsumed - a.pctConsumed)[0]!;
}

/** Compact shape of the worst metric for list rows. */
export function worstSla(summaries: SlaMetricSummary[] | undefined): SlaCompact | null {
  const pick = worstSummary(summaries);
  if (!pick) return null;
  return { metric: pick.metric, state: pick.state, dueAt: pick.dueAt, pctConsumed: pick.pctConsumed, remainingMinutes: pick.remainingMinutes, breached: pick.breached, paused: pick.state === 'paused' };
}

/** Lightweight SQL fragment helpers for list filters. */
export const slaStateFilterSql = {
  breached: sql`EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = tickets.id AND s.state = 'breached')`,
  atRisk: sql`EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = tickets.id AND s.state = 'running' AND (s.warned_at IS NOT NULL OR s.due_at < now())) AND NOT EXISTS (SELECT 1 FROM ticket_slas s2 WHERE s2.ticket_id = tickets.id AND s2.state = 'breached')`,
  ok: sql`NOT EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = tickets.id AND (s.state = 'breached' OR (s.state = 'running' AND (s.warned_at IS NOT NULL OR s.due_at < now()))))`,
};
