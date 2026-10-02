import { eq, and, lt, isNull, sql } from 'drizzle-orm';
import { registerProcessor, registerSchedule } from '../workers';
import { withSystem, schema } from '@/db/client';
import { logger } from '@/core/logger';
import { markBreached, markWarned, summarizeRow, metricLabel, formatMinutes, type SlaRow } from '@/modules/sla/engine';
import { systemCtx, addActivity, reloadTicket } from '@/modules/tickets/common';
import { notifyTicketEvent } from '@/modules/tickets/notify';
import { applyEscalationRules } from '@/modules/tickets/escalation';
import { autoCloseResolved } from './tickets';

const BATCH = 200;
const WARN_HORIZON_MS = 2 * 24 * 60 * 60_000;

/**
 * SLA tick (every minute):
 *  1. running rows past due → breached (+ events, activity, escalation rules, sla.breached)
 *  2. running rows past their warning threshold → warnedAt (+ escalation rules, sla.warning)
 * Each row is processed in its own system transaction so one failure never blocks the rest.
 */
export async function slaTick(now = new Date()) {
  const breachCandidates = await withSystem((tx) =>
    tx.select({ id: schema.ticketSlas.id }).from(schema.ticketSlas).where(and(eq(schema.ticketSlas.state, 'running'), lt(schema.ticketSlas.dueAt, now))).orderBy(schema.ticketSlas.dueAt).limit(BATCH),
  );
  let breached = 0;
  for (const { id } of breachCandidates) {
    try {
      await withSystem(async (tx) => {
        const [row] = await tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.id, id)).limit(1);
        if (!row || row.state !== 'running') return;
        const updated = await markBreached(tx, row, now);
        if (!updated) return;
        const ctx = systemCtx(tx, 'sla-tick');
        const ticket = await reloadTicket(tx, row.ticketId);
        await addActivity(ctx, ticket, { type: 'sla', summary: `${metricLabel(row.metric)} SLA breached (target ${formatMinutes(row.targetMinutes)}, due ${row.dueAt.toISOString()})`, data: { metric: row.metric, slaId: row.id, dueAt: row.dueAt }, customerVisible: false });
        await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'sla.breach', customerId: ticket.customerId, metadata: { metric: row.metric, dueAt: row.dueAt } });
        const summary = summarizeRow(updated, now);
        await notifyTicketEvent(ctx, 'sla.breached', ticket, { sla: { metric: metricLabel(row.metric), dueAt: row.dueAt, pct: summary.pctConsumed } });
        await applyEscalationRules(ctx, ticket, { kind: 'breach', metric: row.metric, pct: summary.pctConsumed, slaId: row.id, dueAt: row.dueAt });
        breached++;
      });
    } catch (err) {
      logger.error({ err, slaId: id }, 'sla breach processing failed');
    }
  }

  const warnCandidates = await withSystem((tx) =>
    tx
      .select()
      .from(schema.ticketSlas)
      .where(and(eq(schema.ticketSlas.state, 'running'), isNull(schema.ticketSlas.warnedAt), lt(schema.ticketSlas.dueAt, new Date(now.getTime() + WARN_HORIZON_MS))))
      .orderBy(schema.ticketSlas.dueAt)
      .limit(BATCH * 2),
  );
  let warned = 0;
  for (const row of warnCandidates as SlaRow[]) {
    const summary = summarizeRow(row, now);
    if (summary.pctConsumed < row.warnPct) continue;
    try {
      await withSystem(async (tx) => {
        const updated = await markWarned(tx, row, summary.pctConsumed, now);
        if (!updated) return;
        const ctx = systemCtx(tx, 'sla-tick');
        const ticket = await reloadTicket(tx, row.ticketId);
        await addActivity(ctx, ticket, { type: 'sla', summary: `${metricLabel(row.metric)} SLA at ${Math.round(summary.pctConsumed)}% (due ${row.dueAt.toISOString()})`, data: { metric: row.metric, slaId: row.id, pct: summary.pctConsumed, dueAt: row.dueAt }, customerVisible: false });
        await notifyTicketEvent(ctx, 'sla.warning', ticket, { sla: { metric: metricLabel(row.metric), dueAt: row.dueAt, pct: summary.pctConsumed } });
        await applyEscalationRules(ctx, ticket, { kind: 'warning', metric: row.metric, pct: summary.pctConsumed, slaId: row.id, dueAt: row.dueAt });
        warned++;
      });
    } catch (err) {
      logger.error({ err, slaId: row.id }, 'sla warning processing failed');
    }
  }
  if (breached || warned) logger.info({ breached, warned }, 'sla tick');
  return { breached, warned };
}

registerSchedule({ queue: 'sla', jobName: 'sla-tick', pattern: '* * * * *' });
registerProcessor({ queue: 'sla', jobName: 'sla-tick', concurrency: 1, processor: async () => slaTick() });

/** Daily auto-close of resolved tickets (see processors/tickets.ts). */
registerSchedule({ queue: 'sla', jobName: 'auto-close-resolved', pattern: '20 1 * * *' });
registerProcessor({ queue: 'sla', jobName: 'auto-close-resolved', concurrency: 1, processor: async () => autoCloseResolved() });

export const slaQueueHealth = async () => withSystem(async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM ticket_slas WHERE state = 'running' AND due_at < now()`)).rows[0]);
