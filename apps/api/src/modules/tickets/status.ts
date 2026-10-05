import { syncMajorOnStatus } from './major';
import { cancelPages } from '@/modules/oncall/paging';
import { eq } from 'drizzle-orm';
import type { TicketType } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { onStatusChange } from '@/modules/sla/engine';
import { type TicketRow, type OptionRow, actorOf, addActivity, optionById, optionByKey, optionsOfType, reloadTicket, requireOption, statusApplies, userIdOf } from './common';
import { notifyTicketEvent } from './notify';

export interface StatusChangeOptions {
  resolutionCodeId?: string | null;
  resolutionNotes?: string | null;
  closureCodeId?: string | null;
  comment?: string | null;
  /** Activity/audit label for the action (status, resolve, close, reopen, cancel, approval). */
  action?: string;
  /** Skip the ticket.status_changed notification (caller sends a more specific one). */
  silent?: boolean;
  /** Replaces the default "Status changed from X to Y" activity line. */
  summary?: string;
}

/**
 * Statuses that mean the service desk is waiting on the customer. A customer
 * reply on a ticket in one of these puts it straight back in the MSP queue.
 */
export const AWAITING_CUSTOMER_KEYS = ['pending_customer'] as const;
export const isAwaitingCustomer = (opt: Pick<OptionRow, 'key'> | null | undefined): boolean => !!opt && (AWAITING_CUSTOMER_KEYS as readonly string[]).includes(opt.key);

/** Status option by key, validated for the ticket type. */
export async function statusByKey(ctx: Ctx, key: string, type: TicketType): Promise<OptionRow> {
  const opt = await optionByKey(ctx.tx, 'ticket_status', key);
  if (!opt || !opt.isActive) throw new ValidationError(`Status "${key}" is not configured`);
  if (!statusApplies(opt, type)) throw new ValidationError(`Status "${opt.label}" does not apply to ${type} tickets`);
  return opt;
}

/** Statuses applicable to a ticket type (for the status dropdown). */
export async function applicableStatuses(ctx: Ctx, type: TicketType) {
  const all = await optionsOfType(ctx.tx, 'ticket_status');
  return all.filter((o) => o.isActive && statusApplies(o, type));
}

export const RESOLVE_KEY: Record<TicketType, string> = { incident: 'resolved', request: 'fulfilled', problem: 'resolved', change: 'implemented' };
export const REOPEN_KEY: Record<TicketType, string> = { incident: 'in_progress', request: 'in_fulfilment', problem: 'under_investigation', change: 'implementing' };

/**
 * Core status transition shared by the status endpoint, convenience actions,
 * approvals and the auto-close job. Sets lifecycle timestamps by category,
 * records the activity + audit, drives the SLA engine and notifies.
 */
export async function changeStatusCore(ctx: Ctx, ticket: TicketRow, to: OptionRow, opts: StatusChangeOptions = {}): Promise<TicketRow> {
  if (to.type !== 'ticket_status') throw new ValidationError('Invalid status');
  if (!statusApplies(to, ticket.type)) throw new ValidationError(`Status "${to.label}" does not apply to ${ticket.type} tickets`);
  const from = await optionById(ctx.tx, ticket.statusId);
  const now = new Date();
  const fromCat = from?.statusCategory ?? null;
  const toCat = to.statusCategory;
  const patch: Partial<typeof schema.tickets.$inferInsert> = { statusId: to.id, updatedAt: now, updatedBy: userIdOf(ctx), lastActivityAt: now };

  if (opts.resolutionCodeId !== undefined) {
    await requireOption(ctx.tx, 'resolution_code', opts.resolutionCodeId, 'resolution code');
    patch.resolutionCodeId = opts.resolutionCodeId;
  }
  if (opts.closureCodeId !== undefined) {
    await requireOption(ctx.tx, 'closure_code', opts.closureCodeId, 'closure code');
    patch.closureCodeId = opts.closureCodeId;
  }
  if (opts.resolutionNotes !== undefined && opts.resolutionNotes !== null) patch.resolutionNotes = opts.resolutionNotes;

  let reopened = false;
  if (toCat === 'resolved') {
    if (!ticket.resolvedAt || fromCat !== 'resolved') patch.resolvedAt = now;
    if (!ticket.restoredAt) patch.restoredAt = now;
    if (!ticket.firstResponseAt) patch.firstResponseAt = now;
    if (!ticket.acknowledgedAt) patch.acknowledgedAt = now;
  } else if (toCat === 'closed') {
    patch.closedAt = now;
    if (!ticket.resolvedAt) patch.resolvedAt = now;
    if (!ticket.restoredAt) patch.restoredAt = now;
    if (!ticket.closureCodeId && opts.closureCodeId === undefined) {
      const def = (await optionsOfType(ctx.tx, 'closure_code')).find((o) => o.isDefault && o.isActive);
      if (def) patch.closureCodeId = def.id;
    }
  } else if (toCat === 'cancelled') {
    patch.closedAt = now;
  } else if (fromCat === 'resolved' || fromCat === 'closed' || fromCat === 'cancelled') {
    reopened = true;
    patch.reopenCount = ticket.reopenCount + 1;
    patch.resolvedAt = null;
    patch.closedAt = null;
    patch.restoredAt = null;
    patch.resolutionCodeId = null;
    patch.closureCodeId = null;
  }

  await ctx.tx.update(schema.tickets).set(patch).where(eq(schema.tickets.id, ticket.id));
  const updated = await reloadTicket(ctx.tx, ticket.id);

  if (opts.comment) {
    await ctx.tx.insert(schema.ticketComments).values({
      ticketId: ticket.id,
      customerId: ticket.customerId,
      authorId: userIdOf(ctx),
      authorName: ctx.user.name,
      kind: toCat === 'resolved' ? 'resolution' : 'comment',
      isInternal: false,
      body: opts.comment,
      source: ctx.source,
      createdAt: new Date(),
    });
  }

  const action = opts.action ?? (toCat === 'resolved' ? 'resolve' : toCat === 'closed' ? 'close' : toCat === 'cancelled' ? 'cancel' : reopened ? 'reopen' : 'status');
  await addActivity(ctx, ticket, {
    type: 'status',
    summary: opts.summary ?? `Status changed from ${from?.label ?? '—'} to ${to.label}${reopened ? ' (reopened)' : ''}`,
    data: { from: from ? { id: from.id, key: from.key, label: from.label } : null, to: { id: to.id, key: to.key, label: to.label }, action, resolutionNotes: patch.resolutionNotes ?? null },
    customerVisible: true,
  });
  await ctx.audit({
    entityType: 'ticket',
    entityId: ticket.id,
    entityLabel: ticket.number,
    action: `ticket.${action}`,
    customerId: ticket.customerId,
    changes: { statusId: { old: ticket.statusId, new: to.id }, status: { old: from?.key ?? null, new: to.key } },
    metadata: { resolutionCodeId: patch.resolutionCodeId ?? null, closureCodeId: patch.closureCodeId ?? null },
  });

  await onStatusChange(ctx.tx, updated, from, to, actorOf(ctx));
  if (updated.isMajor || (ticket.isMajor && !updated.isMajor)) await syncMajorOnStatus(ctx, updated, toCat, fromCat, patch.resolutionNotes ?? null);
  if (ticket.type === 'change' && toCat === 'resolved') await (await import('@/modules/known-errors/service')).onChangeImplemented(ctx, updated);
  if (toCat === 'resolved' || toCat === 'closed' || toCat === 'cancelled') await cancelPages(ctx, updated, `the ticket is ${to.label.toLowerCase()}`);

  if (!opts.silent) {
    if (toCat === 'resolved') await notifyTicketEvent(ctx, 'ticket.resolved', updated, { previousStatus: from?.label ?? null, comment: opts.comment ?? opts.resolutionNotes ?? null });
    else if (toCat === 'closed') await notifyTicketEvent(ctx, 'ticket.closed', updated, { previousStatus: from?.label ?? null });
    else await notifyTicketEvent(ctx, 'ticket.status_changed', updated, { previousStatus: from?.label ?? null, comment: opts.comment ?? null });
  }
  return reloadTicket(ctx.tx, ticket.id);
}

/**
 * A customer reply on a ticket that is waiting on them ends the wait: the ticket
 * returns to the type's working status (so the SLA clocks resume through the SLA
 * engine) and the timeline says why. Returns null when the ticket was not waiting.
 */
export async function resumeAfterCustomerReply(ctx: Ctx, ticket: TicketRow): Promise<TicketRow | null> {
  const current = await optionById(ctx.tx, ticket.statusId);
  if (!isAwaitingCustomer(current)) return null;
  const to = await statusByKey(ctx, REOPEN_KEY[ticket.type], ticket.type);
  return changeStatusCore(ctx, ticket, to, { action: 'customer_reply', silent: true, summary: `Customer replied · back with the service desk as ${to.label}` });
}
