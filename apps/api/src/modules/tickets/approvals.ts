import { eq, and, asc, desc, inArray, or, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { type TicketRow, addActivity, isCustomerUser, loadTicket, reloadTicket, requireAction, userIdOf, optionMap, toLabel } from './common';
import { notifyTicketEvent } from './notify';
import { changeStatusCore, statusByKey } from './status';

export type ApprovalRow = typeof schema.approvals.$inferSelect;

interface WorkflowStep {
  name?: string;
  approverType?: 'customer_admin' | 'customer_contact' | 'role' | 'user' | 'team' | 'account_manager' | string;
  approverRef?: string | null;
  required?: 'all' | 'any';
}

const CUSTOMER_ROLE_KEYS = ['customer_admin', 'customer_user'];

/**
 * Creates one `approvals` row per workflow step and moves the ticket to awaiting_approval.
 * Steps run in order: only the first is `pending`; the rest wait (`waiting`) and are
 * released one at a time as each step is approved. A rejection anywhere ends the
 * workflow and skips whatever is left.
 */
export async function startApproval(ctx: Ctx, ticket: TicketRow, workflowId: string, opts: { silent?: boolean } = {}): Promise<ApprovalRow[]> {
  const [wf] = await ctx.tx.select().from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.id, workflowId)).limit(1);
  if (!wf) throw new NotFoundError('Approval workflow');
  const steps = (wf.steps ?? []) as WorkflowStep[];
  if (!steps.length) throw new ValidationError('The approval workflow has no steps');
  // Supersede any previous open steps (re-request).
  await ctx.tx.update(schema.approvals).set({ status: 'superseded', decidedAt: new Date() }).where(and(eq(schema.approvals.ticketId, ticket.id), inArray(schema.approvals.status, ['pending', 'waiting'])));
  const [customer] = await ctx.tx.select({ accountManagerId: schema.customers.accountManagerId }).from(schema.customers).where(eq(schema.customers.id, ticket.customerId)).limit(1);
  const rows: ApprovalRow[] = [];
  let i = 0;
  for (const step of steps) {
    i++;
    const values: typeof schema.approvals.$inferInsert = { ticketId: ticket.id, customerId: ticket.customerId, step: i, stepName: step.name ?? `Step ${i}`, status: i === 1 ? 'pending' : 'waiting' };
    switch (step.approverType) {
      case 'customer_admin':
      case 'customer_contact':
        values.approverRoleKey = 'customer_admin';
        break;
      case 'role':
        values.approverRoleKey = step.approverRef ?? 'service_manager';
        break;
      case 'user':
        values.approverUserId = step.approverRef ?? null;
        break;
      case 'team':
        values.approverTeamId = step.approverRef ?? null;
        break;
      case 'account_manager':
        if (customer?.accountManagerId) values.approverUserId = customer.accountManagerId;
        else values.approverRoleKey = 'account_manager';
        break;
      default:
        values.approverRoleKey = step.approverRef ?? 'service_manager';
    }
    const [row] = await ctx.tx.insert(schema.approvals).values(values).returning();
    rows.push(row);
  }
  await ctx.tx.update(schema.tickets).set({ approvalStatus: 'pending', updatedAt: new Date(), lastActivityAt: new Date() }).where(eq(schema.tickets.id, ticket.id));
  let current = await reloadTicket(ctx.tx, ticket.id);
  await addActivity(ctx, ticket, { type: 'approval', summary: `Approval requested (${wf.name}): ${steps.map((s) => s.name ?? 'step').join(' → ')}`, data: { workflowId: wf.id, workflowName: wf.name, steps: rows.map((r) => ({ id: r.id, step: r.step, stepName: r.stepName })) }, customerVisible: true });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'approval.request', customerId: ticket.customerId, metadata: { workflowId: wf.id, steps: rows.length } });
  const awaiting = await statusByKey(ctx, 'awaiting_approval', ticket.type).catch(() => null);
  if (awaiting && current.statusId !== awaiting.id) current = await changeStatusCore(ctx, current, awaiting, { action: 'approval', silent: true });
  if (!opts.silent) await notifyTicketEvent(ctx, ticket.type === 'change' ? 'change.approval_requested' : 'request.approval_requested', current, {});
  return rows;
}

/** Re-starts approval for a ticket (changes without catalog items, or re-submission). */
export async function requestApproval(ctx: Ctx, ticketId: string, workflowId?: string | null) {
  const ticket = await loadTicket(ctx, ticketId);
  requireAction(ctx, ticket, ticket.type === 'change' ? 'changes:manage' : 'tickets:update');
  // Dynamic import: changes/service imports `decide` from this file, a static import back would be a cycle.
  if (ticket.type === 'change') await (await import('@/modules/changes/service')).requireAssessment(ctx, ticket.id);
  let wfId = workflowId ?? null;
  if (!wfId && ticket.catalogItemId) {
    const [item] = await ctx.tx.select({ approvalWorkflowId: schema.catalogItems.approvalWorkflowId }).from(schema.catalogItems).where(eq(schema.catalogItems.id, ticket.catalogItemId)).limit(1);
    wfId = item?.approvalWorkflowId ?? null;
  }
  if (!wfId) {
    const [wf] = await ctx.tx.select({ id: schema.approvalWorkflows.id }).from(schema.approvalWorkflows).where(and(eq(schema.approvalWorkflows.isActive, true), ticket.type === 'change' ? eq(schema.approvalWorkflows.name, 'CAB approval') : eq(schema.approvalWorkflows.name, 'Customer approval'))).limit(1);
    wfId = wf?.id ?? null;
  }
  if (!wfId) {
    const [wf] = await ctx.tx.select({ id: schema.approvalWorkflows.id }).from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.isActive, true)).orderBy(asc(schema.approvalWorkflows.name)).limit(1);
    wfId = wf?.id ?? null;
  }
  if (!wfId) throw new ValidationError('No approval workflow is configured');
  const rows = await startApproval(ctx, ticket, wfId);
  return { items: await decorate(ctx, rows), ticket: await reloadTicket(ctx.tx, ticket.id) };
}

async function decorate(ctx: Ctx, rows: ApprovalRow[]) {
  const userIds = [...new Set(rows.flatMap((r) => [r.approverUserId, r.decidedBy]).filter((x): x is string => !!x))];
  const teamIds = [...new Set(rows.map((r) => r.approverTeamId).filter((x): x is string => !!x))];
  const roleKeys = [...new Set(rows.map((r) => r.approverRoleKey).filter((x): x is string => !!x))];
  const [users, teams, roles] = await Promise.all([
    userIds.length ? ctx.tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds)) : [],
    teamIds.length ? ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(inArray(schema.teams.id, teamIds)) : [],
    roleKeys.length ? ctx.tx.select({ key: schema.roles.key, name: schema.roles.name }).from(schema.roles).where(inArray(schema.roles.key, roleKeys)) : [],
  ]);
  return rows.map((r) => ({
    ...r,
    approverUser: users.find((u) => u.id === r.approverUserId) ?? null,
    approverTeam: teams.find((t) => t.id === r.approverTeamId) ?? null,
    approverRole: roles.find((x) => x.key === r.approverRoleKey) ?? (r.approverRoleKey ? { key: r.approverRoleKey, name: r.approverRoleKey } : null),
    decidedByUser: users.find((u) => u.id === r.decidedBy) ?? null,
    canDecide: r.status === 'pending' && isEligible(ctx, r),
  }));
}

/** Is the caller one of the addressees of this step? */
export function isEligible(ctx: Ctx, a: ApprovalRow): boolean {
  if (a.approverUserId && a.approverUserId === ctx.user.id) return true;
  if (a.approverRoleKey) {
    const hit = ctx.user.roles.some((r) => r.key === a.approverRoleKey && (r.customerId === null || r.customerId === a.customerId));
    if (hit) {
      if (isCustomerUser(ctx)) return ctx.user.customerId === a.customerId;
      return true;
    }
  }
  if (a.approverTeamId && ctx.user.teams.some((t) => t.id === a.approverTeamId)) return true;
  return false;
}

export async function listForTicket(ctx: Ctx, ticketId: string) {
  const ticket = await loadTicket(ctx, ticketId);
  const rows = await ctx.tx.select().from(schema.approvals).where(eq(schema.approvals.ticketId, ticket.id)).orderBy(desc(schema.approvals.createdAt), asc(schema.approvals.step));
  return { items: await decorate(ctx, rows), approvalStatus: ticket.approvalStatus };
}

/** Pending approvals addressed to the caller (user, role for the customer, or team). */
export async function listMine(ctx: Ctx) {
  const roleKeys = [...new Set(ctx.user.roles.map((r) => r.key))];
  const teamIds = ctx.user.teams.map((t) => t.id);
  const conds = [eq(schema.approvals.approverUserId, ctx.user.id)];
  if (roleKeys.length) {
    const scopedRoles = ctx.user.roles.filter((r) => r.customerId);
    const globalKeys = ctx.user.roles.filter((r) => !r.customerId).map((r) => r.key);
    if (globalKeys.length && !isCustomerUser(ctx)) conds.push(inArray(schema.approvals.approverRoleKey, globalKeys));
    for (const r of scopedRoles) conds.push(and(eq(schema.approvals.approverRoleKey, r.key), eq(schema.approvals.customerId, r.customerId!))!);
    if (isCustomerUser(ctx) && ctx.user.customerId) conds.push(and(inArray(schema.approvals.approverRoleKey, roleKeys), eq(schema.approvals.customerId, ctx.user.customerId))!);
  }
  if (teamIds.length) conds.push(inArray(schema.approvals.approverTeamId, teamIds));
  const rows = await ctx.tx
    .select({ approval: schema.approvals, ticket: { id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title, type: schema.tickets.type, customerId: schema.tickets.customerId, priorityId: schema.tickets.priorityId, statusId: schema.tickets.statusId, createdAt: schema.tickets.createdAt, requesterUserId: schema.tickets.requesterUserId, description: schema.tickets.description }, customerName: schema.customers.name })
    .from(schema.approvals)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.approvals.ticketId))
    .leftJoin(schema.customers, eq(schema.customers.id, schema.tickets.customerId))
    .where(and(eq(schema.approvals.status, 'pending'), or(...conds)))
    .orderBy(asc(schema.approvals.createdAt));
  const opts = await optionMap(ctx.tx, rows.flatMap((r) => [r.ticket.priorityId, r.ticket.statusId]));
  const requesterIds = [...new Set(rows.map((r) => r.ticket.requesterUserId).filter((x): x is string => !!x))];
  const requesters = requesterIds.length ? await ctx.tx.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, requesterIds)) : [];
  return {
    items: rows.map((r) => ({
      ...r.approval,
      ticket: { ...r.ticket, customerName: r.customerName, priority: toLabel(opts.get(r.ticket.priorityId ?? '')), status: toLabel(opts.get(r.ticket.statusId)), requesterName: requesters.find((u) => u.id === r.ticket.requesterUserId)?.name ?? null },
    })),
    total: rows.length,
  };
}

export async function decide(ctx: Ctx, ticketId: string, approvalId: string, decision: 'approved' | 'rejected', comment?: string | null) {
  const ticket = await loadTicket(ctx, ticketId);
  const [a] = await ctx.tx.select().from(schema.approvals).where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.ticketId, ticket.id))).limit(1);
  if (!a) throw new NotFoundError('Approval step');
  if (a.status === 'waiting') {
    // Steps are sequential: an earlier step must be decided first.
    const [earlier] = await ctx.tx.select({ step: schema.approvals.step }).from(schema.approvals).where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'pending'))).orderBy(asc(schema.approvals.step)).limit(1);
    throw new ValidationError(`Step ${earlier?.step ?? a.step - 1} must be decided before ${a.stepName ?? `step ${a.step}`}`);
  }
  if (a.status !== 'pending') throw new ValidationError('This approval step has already been decided');
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:approve', ticket.customerId) || ctx.user.customerId !== ticket.customerId) throw new ForbiddenError('Missing permission: portal:approve');
    const addressedToCustomer = (a.approverRoleKey && CUSTOMER_ROLE_KEYS.includes(a.approverRoleKey)) || a.approverUserId === ctx.user.id;
    if (!addressedToCustomer || !isEligible(ctx, a)) throw new ForbiddenError('This approval step is not addressed to you');
  } else {
    ctx.require(ticket.type === 'change' ? 'changes:approve' : 'requests:approve', ticket.customerId);
  }
  const now = new Date();
  await ctx.tx.update(schema.approvals).set({ status: decision, decidedBy: userIdOf(ctx), decidedAt: now, comment: comment ?? null }).where(eq(schema.approvals.id, a.id));
  await addActivity(ctx, ticket, { type: 'approval', summary: `${a.stepName ?? `Step ${a.step}`} ${decision} by ${ctx.user.name}${comment ? `: ${comment}` : ''}`, data: { approvalId: a.id, step: a.step, decision, comment: comment ?? null }, customerVisible: true });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: `approval.${decision}`, customerId: ticket.customerId, metadata: { approvalId: a.id, step: a.step, comment: comment ?? null } });

  let current = await reloadTicket(ctx.tx, ticket.id);
  if (decision === 'rejected') {
    await ctx.tx.update(schema.approvals).set({ status: 'skipped', decidedAt: now }).where(and(eq(schema.approvals.ticketId, ticket.id), inArray(schema.approvals.status, ['pending', 'waiting'])));
    await ctx.tx.update(schema.tickets).set({ approvalStatus: 'rejected', updatedAt: now }).where(eq(schema.tickets.id, ticket.id));
    current = await reloadTicket(ctx.tx, ticket.id);
    const rejected = await statusByKey(ctx, 'rejected', ticket.type).catch(() => null);
    if (rejected) current = await changeStatusCore(ctx, current, rejected, { action: 'approval', silent: true, comment: comment ?? undefined });
    await notifyTicketEvent(ctx, ticket.type === 'change' ? 'change.rejected' : 'request.rejected', current, { comment: comment ?? null });
  } else {
    // Release the next waiting step, if any; otherwise the workflow is complete.
    const [nextStep] = await ctx.tx.select().from(schema.approvals).where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'waiting'))).orderBy(asc(schema.approvals.step)).limit(1);
    if (nextStep) {
      await ctx.tx.update(schema.approvals).set({ status: 'pending' }).where(eq(schema.approvals.id, nextStep.id));
      await addActivity(ctx, ticket, { type: 'approval', summary: `${nextStep.stepName ?? `Step ${nextStep.step}`} is now awaiting approval`, data: { approvalId: nextStep.id, step: nextStep.step }, customerVisible: true });
      await notifyTicketEvent(ctx, ticket.type === 'change' ? 'change.approval_requested' : 'request.approval_requested', current, {});
    }
    const [{ pending }] = await ctx.tx.select({ pending: sql<number>`count(*)::int` }).from(schema.approvals).where(and(eq(schema.approvals.ticketId, ticket.id), inArray(schema.approvals.status, ['pending', 'waiting'])));
    if (pending === 0) {
      await ctx.tx.update(schema.tickets).set({ approvalStatus: 'approved', updatedAt: now }).where(eq(schema.tickets.id, ticket.id));
      current = await reloadTicket(ctx.tx, ticket.id);
      const next = await statusByKey(ctx, ticket.type === 'change' ? 'approved' : 'in_fulfilment', ticket.type).catch(() => null);
      if (next) current = await changeStatusCore(ctx, current, next, { action: 'approval', silent: true });
      await notifyTicketEvent(ctx, ticket.type === 'change' ? 'change.approved' : 'request.approved', current, { comment: comment ?? null });
    }
  }
  return listForTicket(ctx, ticket.id);
}
