import { eq, and, lt, inArray, sql } from 'drizzle-orm';
import { withSystem, schema } from '@/db/client';
import { logger } from '@/core/logger';
import { systemCtx, optionByKey, reloadTicket } from '@/modules/tickets/common';
import { changeStatusCore } from '@/modules/tickets/status';

/**
 * Auto-closes tickets that have been in a `resolved` status for longer than
 * `tickets.auto_close_days` (closure code `resolved_auto`). Runs as the system
 * actor; each ticket gets its own transaction with activity, audit and the
 * ticket.closed notification. Scheduled from processors/sla.ts (single
 * dispatcher for the sla queue).
 */
export async function autoCloseResolved(now = new Date()) {
  const settings = await withSystem(async (tx) => {
    const [row] = await tx.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'tickets.auto_close_days')).limit(1);
    return { days: Number(row?.value ?? 5) };
  });
  if (!settings.days || settings.days <= 0) return { closed: 0 };
  const cutoff = new Date(now.getTime() - settings.days * 86_400_000);
  const candidates = await withSystem(async (tx) => {
    const resolvedStatuses = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.statusCategory, 'resolved')));
    if (!resolvedStatuses.length) return [];
    return tx
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(and(inArray(schema.tickets.statusId, resolvedStatuses.map((s) => s.id)), lt(schema.tickets.resolvedAt, cutoff)))
      .orderBy(schema.tickets.resolvedAt)
      .limit(500);
  });
  let closed = 0;
  for (const { id } of candidates) {
    try {
      await withSystem(async (tx) => {
        const ctx = systemCtx(tx, 'auto-close');
        const ticket = await reloadTicket(tx, id);
        const current = await tx.select({ statusCategory: schema.configOptions.statusCategory }).from(schema.configOptions).where(eq(schema.configOptions.id, ticket.statusId)).limit(1);
        if (current[0]?.statusCategory !== 'resolved' || !ticket.resolvedAt || ticket.resolvedAt > cutoff) return;
        const closedStatus = await optionByKey(tx, 'ticket_status', 'closed');
        if (!closedStatus) throw new Error('No "closed" status configured');
        const code = await optionByKey(tx, 'closure_code', 'resolved_auto');
        await changeStatusCore(ctx, ticket, closedStatus, { closureCodeId: code?.id ?? null, action: 'auto_close' });
        closed++;
      });
    } catch (err) {
      logger.error({ err, ticketId: id }, 'auto-close failed');
    }
  }
  if (closed) logger.info({ closed, days: settings.days }, 'auto-closed resolved tickets');
  return { closed };
}

export const resolvedBacklog = async () => withSystem(async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM tickets t JOIN config_options s ON s.id = t.status_id WHERE s.status_category = 'resolved'`)).rows[0]);
