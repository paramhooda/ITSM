import { syncMajorOnStatus } from './major';
import { cancelPages } from '@/modules/oncall/paging';
import { eq, and, inArray } from 'drizzle-orm';
import { TICKET_TRANSITIONS, WAITING_ON, waitingOnLabels, type StatusCategory, type TicketType, type WaitingOn } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { onStatusChange } from '@/modules/sla/engine';
import { type TicketRow, type OptionRow, actorOf, addActivity, isWait, optionById, optionByKey, optionsOfType, reloadTicket, requireOption, statusApplies, userIdOf } from './common';
import { notifyTicketEvent } from './notify';
import { onTicketEnded, onTicketReopened } from '@/modules/surveys/service';

/** Why a wait ended (the words of the "Resumed" line and the customer-facing notification). */
export type ResumeTrigger = 'customer_reply' | 'approval' | 'rejection' | 'manual' | 'expiry';

export interface StatusChangeOptions {
  resolutionCodeId?: string | null;
  resolutionNotes?: string | null;
  closureCodeId?: string | null;
  comment?: string | null;
  /** Activity/audit label for the action (status, resolve, close, reopen, cancel, approval). */
  action?: string;
  /** Skip the ticket.status_changed / ticket.pending / ticket.resumed notification (caller sends a more specific one). */
  silent?: boolean;
  /** Replaces the default "Status changed from X to Y" activity line. */
  summary?: string;
  /** Entering a wait: what is being waited for (mandatory on every path, system ones included). */
  pendingReason?: string | null;
  /** Entering a wait: who is waited on. Derived from the status key when not given; `on_hold` must say agreement or internal. */
  waitingOn?: WaitingOn | null;
  /** When the wait is expected to end. */
  expectedAt?: Date | null;
  /** The supplier's or third party's reference, the change number (staff only). */
  pendingReference?: string | null;
  /** Post the reason as a reply the customer can read (default: a customer wait yes, anything else no; an internal hold never). */
  tellCustomer?: boolean;
  /** Post the reason as a comment at all (the composer passes false: its own reply is the reason). */
  postReason?: boolean;
  /** Leaving a wait: why (the "Resumed · …" line). */
  trigger?: ResumeTrigger;
}

const WAIT_BY_KEY: Record<string, WaitingOn> = { pending_customer: 'customer', pending_vendor: 'vendor', pending_change: 'change' };
const APPROVAL_KEY = 'awaiting_approval';

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
/** Where a ticket goes when its approval completes: the working status, except a change that is now approved. */
export const AFTER_APPROVAL_KEY: Record<TicketType, string> = { incident: 'in_progress', request: 'in_fulfilment', problem: 'under_investigation', change: 'approved' };
/** What a rejection does per type: request fulfilment and change enablement end as Rejected; an incident or problem returns to the engineer with the note. */
export const AFTER_REJECTION: Record<TicketType, 'rejected' | 'working'> = { incident: 'working', request: 'rejected', problem: 'working', change: 'rejected' };

/**
 * The transition matrix by category: a `ValidationError` naming both statuses when the move is not one the
 * lifecycle allows. One exception: the approvals service may resubmit a rejected request or change (cancelled →
 * Awaiting Approval), which the core treats as a reopen into the wait.
 */
export function assertTransition(ticket: Pick<TicketRow, 'number'>, from: OptionRow | null, to: OptionRow, action?: string) {
  if (!from || from.id === to.id) return;
  const fromCat = from.statusCategory as StatusCategory | null;
  const toCat = to.statusCategory as StatusCategory | null;
  if (!fromCat || !toCat) return;
  if (action === 'approval' && fromCat === 'cancelled' && to.key === APPROVAL_KEY) return;
  if (!TICKET_TRANSITIONS[fromCat].includes(toCat)) throw new ValidationError(`${ticket.number} cannot move from ${from.label} to ${to.label}`);
}

/**
 * The party a wait is waiting on: the caller's choice, else derived from the status key.
 * `on_hold` has no default (agreed with the customer, or an internal hold: the clocks differ);
 * Awaiting Approval is set by the approvals service from the step's addressee.
 */
export function deriveWaitingOn(to: OptionRow, opts: Pick<StatusChangeOptions, 'waitingOn' | 'action'>): WaitingOn {
  if (opts.waitingOn) {
    if (!(WAITING_ON as readonly string[]).includes(opts.waitingOn)) throw new ValidationError(`Unknown party "${opts.waitingOn}"`);
    return opts.waitingOn;
  }
  if (WAIT_BY_KEY[to.key]) return WAIT_BY_KEY[to.key]!;
  if (to.key === 'on_hold') throw new ValidationError('Say who the hold waits on: agreed with the customer, or internal');
  // Awaiting Approval (the approvals service always names the party) and any custom wait: internal unless told otherwise.
  return 'internal';
}

/** The rules of entering a wait, shared with the assistant's preview: the matrix, the mandatory reason, the approval guard. */
export function assertWaitEntry(ticket: Pick<TicketRow, 'number'>, from: OptionRow | null, to: OptionRow, opts: StatusChangeOptions): { toWait: boolean; waitingOn: WaitingOn | null; reason: string | null } {
  if (to.key === APPROVAL_KEY && opts.action !== 'approval') throw new ValidationError('Use Request approval to move a ticket to Awaiting Approval');
  assertTransition(ticket, from, to, opts.action);
  const toWait = isWait(to);
  if (!toWait) return { toWait, waitingOn: null, reason: null };
  const reason = opts.pendingReason?.trim() ?? '';
  if (!reason) throw new ValidationError(`A reason is required to put ${ticket.number} on hold (${to.label})`);
  return { toWait, waitingOn: deriveWaitingOn(to, opts), reason };
}

const fmtDay = (d: Date | null | undefined) => (d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null);

const resumeWords = (ctx: Ctx, trigger: ResumeTrigger | undefined, comment: string | null | undefined): string => {
  switch (trigger) {
    case 'customer_reply':
      return 'the customer replied';
    case 'approval':
      return 'the approval was decided';
    case 'rejection':
      return 'the request was rejected';
    case 'expiry':
      return 'the approval expired without a decision';
    default:
      return `by ${ctx.user.name}${comment ? `: ${comment}` : ''}`;
  }
};

/**
 * Core status transition shared by the status endpoint, convenience actions,
 * approvals, the CAB, the auto-close job, the portal's confirm, the customer-reply
 * hook and the composer's reply-and-wait. Applies the transition matrix, the
 * mandatory reason of a wait, sets the lifecycle timestamps and the pending block,
 * records the activity + audit (the customer-visible rows never carry a reason
 * the engineer kept internal), drives the SLA engine and notifies. It never
 * short-circuits a same-status call: a wait called again with a reason is a
 * rewrite of the wait (the approvals service re-points the party this way).
 */
export async function changeStatusCore(ctx: Ctx, ticket: TicketRow, to: OptionRow, opts: StatusChangeOptions = {}): Promise<TicketRow> {
  if (to.type !== 'ticket_status') throw new ValidationError('Invalid status');
  if (!statusApplies(to, ticket.type)) throw new ValidationError(`Status "${to.label}" does not apply to ${ticket.type} tickets`);
  const from = await optionById(ctx.tx, ticket.statusId);
  const { toWait, waitingOn, reason } = assertWaitEntry(ticket, from, to, opts);
  const fromWait = isWait(from) && !!ticket.pendingWaitingOn;
  const fromWaitingOn = (fromWait ? ticket.pendingWaitingOn : null) as WaitingOn | null;
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

  // The pending block: written on every entry into a wait (and rewritten on a wait-to-wait move), cleared on every exit.
  const isInternal = waitingOn === 'internal';
  const tellCustomer = toWait && !isInternal && (opts.tellCustomer ?? waitingOn === 'customer');
  const postReason = opts.postReason ?? true;
  const approval = to.key === APPROVAL_KEY;
  // A rewrite of the same wait (the reason, the date or the party edited; the approvals service re-pointing a step) keeps who put the ticket on hold and since when.
  const rewrite = fromWait && from?.id === to.id;
  if (toWait) {
    Object.assign(patch, {
      pendingReason: reason,
      pendingWaitingOn: waitingOn,
      pendingExpectedAt: opts.expectedAt ?? null,
      pendingReference: opts.pendingReference ?? null,
      pendingReasonVisible: tellCustomer,
      pendingSetBy: rewrite ? ticket.pendingSetBy : userIdOf(ctx),
      pendingSetAt: rewrite ? (ticket.pendingSetAt ?? now) : now,
    });
  } else if (fromWait || ticket.pendingWaitingOn) {
    Object.assign(patch, { pendingReason: null, pendingWaitingOn: null, pendingExpectedAt: null, pendingReference: null, pendingReasonVisible: null, pendingSetBy: null, pendingSetAt: null });
  }

  // Ending the ticket withdraws an approval that is still pending (rows and status only; the approvals module tells the approvers from 1b).
  if ((toCat === 'resolved' || toCat === 'closed' || toCat === 'cancelled') && ticket.approvalStatus === 'pending') {
    await cancelPendingApprovals(ctx, ticket, `the ticket was ${toCat}`);
    patch.approvalStatus = 'withdrawn';
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
  // The reason of a wait: a reply the customer can read, or a work note.
  if (toWait && postReason && reason) {
    await ctx.tx.insert(schema.ticketComments).values({
      ticketId: ticket.id,
      customerId: ticket.customerId,
      authorId: userIdOf(ctx),
      authorName: ctx.user.name,
      kind: tellCustomer ? 'comment' : 'work_note',
      isInternal: !tellCustomer,
      body: reason,
      source: ctx.source,
      createdAt: new Date(),
    });
  }

  const action = opts.action ?? (toCat === 'resolved' ? 'resolve' : toCat === 'closed' ? 'close' : toCat === 'cancelled' ? 'cancel' : reopened ? 'reopen' : 'status');
  // The status row is internal when an internal hold is on either side: the customer reads the working status and no wait.
  const internalSide = (toWait && isInternal) || (fromWait && fromWaitingOn === 'internal');
  const labels = toWait && waitingOn ? waitingOnLabels(waitingOn, { approval }) : null;
  const expected = fmtDay(opts.expectedAt);
  await addActivity(ctx, ticket, {
    type: 'status',
    summary: opts.summary ?? `Status changed from ${from?.label ?? '—'} to ${to.label}${reopened ? ' (reopened)' : ''}`,
    data: {
      from: from ? { id: from.id, key: from.key, label: from.label } : null,
      to: { id: to.id, key: to.key, label: to.label },
      action,
      resolutionNotes: patch.resolutionNotes ?? null,
      pending: toWait ? { waitingOn, expectedAt: opts.expectedAt ?? null, visible: tellCustomer } : null,
    },
    customerVisible: !internalSide,
  });
  if (toWait && waitingOn && labels) {
    // The customer-visible row carries the customer's words and the reason only when it was shown to them; the staff row carries everything.
    if (!isInternal) {
      await addActivity(ctx, ticket, {
        type: 'pending',
        summary: [labels.customer, tellCustomer ? reason : null, expected ? `expected ${expected}` : null].filter(Boolean).join(' · '),
        data: { waitingOn, visible: tellCustomer, expectedAt: opts.expectedAt ?? null, approval, ...(tellCustomer ? { reason } : {}) },
        customerVisible: true,
      });
    }
    await addActivity(ctx, ticket, {
      type: 'pending',
      summary: [labels.staff, reason, opts.pendingReference ? `ref ${opts.pendingReference}` : null, expected ? `expected ${expected}` : null, isInternal ? 'clocks keep running' : null].filter(Boolean).join(' · '),
      data: { waitingOn, reason, reference: opts.pendingReference ?? null, expectedAt: opts.expectedAt ?? null, visible: tellCustomer, approval, internal: true },
      customerVisible: false,
    });
  } else if (fromWait && fromWaitingOn && (toCat === 'open' || toCat === 'new')) {
    // Only a return to work is a resume: a wait that ends in Resolved, Closed, Cancelled or Rejected has its own status row.
    await addActivity(ctx, ticket, {
      type: 'pending',
      summary: `Resumed · ${resumeWords(ctx, opts.trigger, opts.comment)}`,
      data: { resumed: true, from: fromWaitingOn, trigger: opts.trigger ?? 'manual' },
      customerVisible: fromWaitingOn !== 'internal',
    });
  }
  await ctx.audit({
    entityType: 'ticket',
    entityId: ticket.id,
    entityLabel: ticket.number,
    action: `ticket.${action}`,
    customerId: ticket.customerId,
    changes: { statusId: { old: ticket.statusId, new: to.id }, status: { old: from?.key ?? null, new: to.key } },
    metadata: { resolutionCodeId: patch.resolutionCodeId ?? null, closureCodeId: patch.closureCodeId ?? null, pending: toWait ? { waitingOn, reason, expectedAt: opts.expectedAt ?? null, reference: opts.pendingReference ?? null, visible: tellCustomer } : null },
  });

  await onStatusChange(ctx.tx, updated, from, to, actorOf(ctx));
  if (updated.isMajor || (ticket.isMajor && !updated.isMajor)) await syncMajorOnStatus(ctx, updated, toCat, fromCat, patch.resolutionNotes ?? null);
  if (ticket.type === 'change' && toCat === 'resolved') await (await import('@/modules/known-errors/service')).onChangeImplemented(ctx, updated);
  if (toCat === 'resolved' || toCat === 'closed' || toCat === 'cancelled') await cancelPages(ctx, updated, `the ticket is ${to.label.toLowerCase()}`);

  if (!opts.silent) {
    const common = { previousStatus: from?.label ?? null, comment: opts.comment ?? null, channels: ['email', 'in_app', 'whatsapp'] as ('email' | 'in_app' | 'whatsapp')[], recipientFallback: { requester: true, watchers: true } };
    if (toCat === 'resolved') await notifyTicketEvent(ctx, 'ticket.resolved', updated, { previousStatus: from?.label ?? null, comment: opts.comment ?? opts.resolutionNotes ?? null });
    else if (toCat === 'closed') await notifyTicketEvent(ctx, 'ticket.closed', updated, { previousStatus: from?.label ?? null });
    else if (toWait && !isInternal && labels) await notifyTicketEvent(ctx, 'ticket.pending', updated, { ...common, waitingOnLabel: labels.customer, reason: tellCustomer ? reason : null, expectedAt: opts.expectedAt ?? null });
    else if (toWait && isInternal) await notifyTicketEvent(ctx, 'ticket.status_changed', updated, { previousStatus: from?.label ?? null, comment: opts.comment ?? null, staffOnly: true });
    else if (fromWait && fromWaitingOn && fromWaitingOn !== 'internal' && toCat !== 'cancelled') await notifyTicketEvent(ctx, 'ticket.resumed', updated, { ...common, waitingOnLabel: 'Back with the service desk' });
    else await notifyTicketEvent(ctx, 'ticket.status_changed', updated, { previousStatus: from?.label ?? null, comment: opts.comment ?? null, staffOnly: fromWait && fromWaitingOn === 'internal' });
  }
  // Satisfaction survey: issued when the ticket ends, withdrawn when it is reopened or cancelled (never fails the transition).
  if (toCat === 'resolved' || toCat === 'closed') await onTicketEnded(ctx, updated, { category: toCat, from: fromCat, action });
  else if (reopened || toCat === 'cancelled') await onTicketReopened(ctx, updated, toCat === 'cancelled' ? 'cancelled' : 'reopened');
  return reloadTicket(ctx.tx, ticket.id);
}

/**
 * Ending a ticket (resolved, closed, cancelled) withdraws the approval that was
 * still pending: the steps still pending or waiting become `cancelled` with the
 * reason, and the timeline says so. Lives here because the approvals module
 * imports this file (a static import back would be a cycle). The approvals
 * module notifies the approvers before calling this, since the recipient flag
 * `approvers` reads the rows while they are still pending.
 */
export async function cancelPendingApprovals(ctx: Ctx, ticket: TicketRow, why: string) {
  if (ticket.approvalStatus !== 'pending') return 0;
  const rows = await ctx.tx
    .update(schema.approvals)
    .set({ status: 'cancelled', decidedAt: new Date(), comment: why })
    .where(and(eq(schema.approvals.ticketId, ticket.id), inArray(schema.approvals.status, ['pending', 'waiting'])))
    .returning({ id: schema.approvals.id });
  if (rows.length) {
    await addActivity(ctx, ticket, { type: 'approval', summary: `Approval request withdrawn: ${why}`, data: { withdrawn: rows.map((r) => r.id), why }, customerVisible: ticket.pendingWaitingOn === 'customer' });
    await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'approval.withdraw', customerId: ticket.customerId, metadata: { why, steps: rows.length } });
  }
  return rows.length;
}

/**
 * Ends a wait: the ticket returns to the type's working status (after an
 * approval, a change goes to Approved), the clocks resume through the SLA
 * engine and the timeline says why. Returns null when the ticket is not in a
 * wait. A customer's reply resumes only a customer *reply* wait: when an
 * approval is pending, their words are a comment, not a decision (the approval
 * wait ends through a decision, a withdrawal, the expiry or the auto-cancel).
 */
export async function resumeFromPending(ctx: Ctx, ticket: TicketRow, opts: { trigger: ResumeTrigger; note?: string | null }): Promise<TicketRow | null> {
  const current = await optionById(ctx.tx, ticket.statusId);
  if (!current || !isWait(current)) return null;
  if (opts.trigger === 'customer_reply' && (ticket.pendingWaitingOn !== 'customer' || ticket.approvalStatus === 'pending')) return null;
  const key = opts.trigger === 'approval' ? AFTER_APPROVAL_KEY[ticket.type] : REOPEN_KEY[ticket.type];
  const to = await statusByKey(ctx, key, ticket.type);
  const summary =
    opts.trigger === 'customer_reply'
      ? `Customer replied · back with the service desk as ${to.label}`
      : opts.trigger === 'approval'
        ? `Approved by ${ctx.user.name} · back with the service desk as ${to.label}`
        : opts.trigger === 'rejection'
          ? `Rejected by ${ctx.user.name}${opts.note ? `: ${opts.note}` : ''} · back with the service desk as ${to.label}`
          : opts.trigger === 'expiry'
            ? `Approval expired without a decision · back with the service desk as ${to.label}`
            : `Resumed by ${ctx.user.name}${opts.note ? `: ${opts.note}` : ''} · back with the service desk as ${to.label}`;
  const action = opts.trigger === 'customer_reply' ? 'customer_reply' : opts.trigger === 'approval' || opts.trigger === 'rejection' || opts.trigger === 'expiry' ? 'approval' : 'status';
  return changeStatusCore(ctx, ticket, to, {
    action,
    silent: opts.trigger !== 'manual',
    summary,
    trigger: opts.trigger,
    comment: opts.trigger === 'rejection' || opts.trigger === 'manual' ? (opts.note ?? undefined) : undefined,
  });
}
