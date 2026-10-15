import { eq, and, asc, desc, inArray, or, sql, isNull, lt } from 'drizzle-orm';
import { schema, withSystem } from '@/db/client';
import type { Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { logger } from '@/core/logger';
import { waitingOnLabels, type WaitingOn } from '@itsm/shared';
import { type OptionRow, type TicketRow, CUSTOMER_ROLE_KEYS, ORG_APPROVERS_KEY, addActivity, isCustomerUser, isWait, loadTicket, optionById, reloadTicket, requireAction, systemCtx, userIdOf, optionMap, toLabel } from './common';
import { notifyTicketEvent, resolveRecipients } from './notify';
import { AFTER_APPROVAL_KEY, REJECTED_RETURN_KEY, REOPEN_KEY, afterRejection, changeStatusCore, resumeFromPending, statusByKey, type ResumeTrigger } from './status';
import { loadLifecycleSettings, rejectionNoteRequired, type LifecycleSettings } from './settings';
import type { RequestApprovalInput } from './schemas';

export type ApprovalRow = typeof schema.approvals.$inferSelect;

export interface WorkflowStep {
  name?: string;
  approverType?: 'customer' | 'customer_admin' | 'customer_contact' | 'role' | 'user' | 'team' | 'account_manager' | string;
  approverRef?: string | null;
  required?: 'all' | 'any';
}

/** Where the steps of an approval come from: a configured workflow, or the one step named on the request. */
export type ApprovalSource = { workflowId: string } | { steps: WorkflowStep[]; name: string };

export interface StartApprovalOptions {
  /** What needs approving; shown to the approver and to the requester, and the reason of the wait. */
  purpose: string;
  /** When a decision is expected (default the end of the day `approvals.default_due_days` from now). */
  dueAt?: Date | null;
  /** Queue no notification (the demo seed backdates its own). */
  silent?: boolean;
  /** Who asked (default the caller). */
  requestedBy?: string | null;
}

/** The organisation step's stored key and the portal role keys a step may be addressed to (defined beside the fence helpers). */
export { CUSTOMER_ROLE_KEYS, ORG_APPROVERS_KEY };
const CHANNELS: ('email' | 'in_app' | 'whatsapp')[] = ['email', 'in_app', 'whatsapp'];
const ENDED = ['resolved', 'closed', 'cancelled'];
const fmtDay = (d: Date | null | undefined) => (d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The end (UTC) of the day `days` from now: a due date is a calendar day, so a default of 0 days means "today", never "this instant". */
const endOfDayFrom = (now: Date, days: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 23, 59, 59, 999));

// ---------------------------------------------------------------- settings

export type ExpiryPolicy = 'return' | 'reject' | 'none';
export interface ApprovalSettings {
  defaultDueDays: number;
  reminderHours: number;
  expiryDays: number;
  expiryPolicy: ExpiryPolicy;
}
export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = { defaultDueDays: 3, reminderHours: 24, expiryDays: 7, expiryPolicy: 'return' };

const num = (v: unknown, def: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

/** The four `approvals.*` settings with their defaults (an unset or malformed value falls back). */
export async function loadApprovalSettings(tx: Tx): Promise<ApprovalSettings> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, ['approvals.default_due_days', 'approvals.reminder_hours', 'approvals.expiry_days', 'approvals.expiry_policy']));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const policy = get('approvals.expiry_policy');
  return {
    defaultDueDays: num(get('approvals.default_due_days'), DEFAULT_APPROVAL_SETTINGS.defaultDueDays, 0, 365),
    reminderHours: num(get('approvals.reminder_hours'), DEFAULT_APPROVAL_SETTINGS.reminderHours, 0, 24 * 90),
    expiryDays: num(get('approvals.expiry_days'), DEFAULT_APPROVAL_SETTINGS.expiryDays, 0, 365),
    expiryPolicy: policy === 'reject' || policy === 'none' ? policy : 'return',
  };
}

// ---------------------------------------------------------------- parties and labels

/**
 * The party an approval step waits on: the customer when the step is addressed to a customer role or a customer user,
 * else the desk itself. A customer party pauses the resolution clock; an internal one never does.
 */
export async function partyOf(ctx: Ctx, step: Pick<ApprovalRow, 'approverRoleKey' | 'approverUserId'>): Promise<WaitingOn> {
  if (step.approverRoleKey && CUSTOMER_ROLE_KEYS.includes(step.approverRoleKey)) return 'customer';
  if (step.approverUserId) {
    const [u] = await ctx.tx.select({ userType: schema.users.userType }).from(schema.users).where(eq(schema.users.id, step.approverUserId)).limit(1);
    if (u?.userType === 'customer') return 'customer';
  }
  return 'internal';
}

/** "Manish Agarwal", "the approvers of ABC Manufacturing", "the Service Manager role", "team NOC". */
export async function approverLabel(ctx: Ctx, step: Pick<ApprovalRow, 'approverRoleKey' | 'approverUserId' | 'approverTeamId' | 'customerId'>): Promise<string> {
  if (step.approverUserId) {
    const [u] = await ctx.tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, step.approverUserId)).limit(1);
    if (u) return u.name;
  }
  if (step.approverTeamId) {
    const [t] = await ctx.tx.select({ name: schema.teams.name }).from(schema.teams).where(eq(schema.teams.id, step.approverTeamId)).limit(1);
    if (t) return `team ${t.name}`;
  }
  if (step.approverRoleKey) {
    if (CUSTOMER_ROLE_KEYS.includes(step.approverRoleKey)) {
      const [c] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, step.customerId)).limit(1);
      return `the approvers of ${c?.name ?? 'the customer'}`;
    }
    const [r] = await ctx.tx.select({ name: schema.roles.name }).from(schema.roles).where(eq(schema.roles.key, step.approverRoleKey)).limit(1);
    return `the ${r?.name ?? step.approverRoleKey} role`;
  }
  return 'an approver';
}

/** The user ids a pending step reaches (the step's user, the role's holders for the customer, the team's members). */
async function approverUserIds(tx: Tx, ticket: TicketRow): Promise<string[]> {
  const { msp, portal } = await resolveRecipients(tx, ticket, { approvers: true });
  return [...msp, ...portal].map((r) => r.userId).filter((x): x is string => !!x);
}

// ---------------------------------------------------------------- the ad-hoc approver

/**
 * Turns the approver named on a request into one workflow step, validated: a user must be active and either staff or an
 * approver of the ticket's organisation (a customer user of that organisation holding `portal:approve`); a role key and
 * a team id must exist. The kind `customer` is the organisation step (any approver) or one approver by id; `customer_admin`
 * is kept as its alias.
 */
async function adHocStep(ctx: Ctx, ticket: TicketRow, approver: NonNullable<RequestApprovalInput['approver']>): Promise<{ step: WorkflowStep; name: string }> {
  const [customer] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, ticket.customerId)).limit(1);
  const ref = approver.ref?.trim() || null;
  // A user or a team is named by id (the assistant resolves names before it gets here); anything else is a request error, not a database one.
  const idRef = (what: string) => {
    if (!ref) throw new ValidationError(`Name the ${what} that should approve`);
    if (!UUID.test(ref)) throw new ValidationError(`Name the ${what} by id`);
    return ref;
  };
  switch (approver.kind) {
    case 'customer':
    case 'customer_admin': {
      if (!ref) return { step: { name: 'Customer approval', approverType: 'customer' }, name: 'Customer approval' };
      const u = await requireCustomerApprover(ctx, ticket, idRef('approver'), customer?.name ?? 'the customer');
      return { step: { name: `Approval by ${u.name}`, approverType: 'user', approverRef: u.id }, name: `Approval by ${u.name}` };
    }
    case 'user': {
      const [u] = await ctx.tx.select({ id: schema.users.id, name: schema.users.name, userType: schema.users.userType, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, idRef('user'))).limit(1);
      if (!u) throw new NotFoundError('User');
      if (u.status !== 'active') throw new ValidationError(`${u.name} is not an active user and cannot approve`);
      if (u.userType === 'customer') await requireCustomerApprover(ctx, ticket, u.id, customer?.name ?? 'the customer');
      return { step: { name: `Approval by ${u.name}`, approverType: 'user', approverRef: u.id }, name: `Approval by ${u.name}` };
    }
    case 'role': {
      if (!ref) throw new ValidationError('Name the role that should approve');
      const [r] = await ctx.tx.select({ key: schema.roles.key, name: schema.roles.name, userType: schema.roles.userType }).from(schema.roles).where(eq(schema.roles.key, ref)).limit(1);
      if (!r) throw new NotFoundError('Role', `No role "${ref}"`);
      // A customer role is the organisation step: its administrators and its approvers are both "the approvers of the organisation".
      const orgStep = r.userType === 'customer' && (r.key === ORG_APPROVERS_KEY || r.key === 'customer_approver');
      if (r.userType === 'customer' && !orgStep) throw new ValidationError(`The ${r.name} role cannot approve; ask the organisation's approvers`);
      const name = orgStep ? 'Customer approval' : `${r.name} approval`;
      return { step: { name, approverType: orgStep ? 'customer' : 'role', approverRef: orgStep ? ORG_APPROVERS_KEY : r.key }, name };
    }
    case 'team': {
      const [t] = await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(eq(schema.teams.id, idRef('team'))).limit(1);
      if (!t) throw new NotFoundError('Team');
      return { step: { name: `${t.name} approval`, approverType: 'team', approverRef: t.id }, name: `${t.name} approval` };
    }
    default:
      throw new ValidationError('Unknown approver kind');
  }
}

/**
 * A customer user may be named as an approver only when they are an active customer user **of the ticket's organisation**
 * (`users.user_type = 'customer'` and `users.customer_id = ticket.customerId`, the fence) holding `portal:approve` for it:
 * a role (scoped to that customer or unscoped) whose permissions include it, an administrator or a customer approver.
 * One message for every refusal: it never says which organisation the person belongs to.
 */
export async function requireCustomerApprover(ctx: Ctx, ticket: TicketRow, userId: string, customerName: string) {
  const [u] = await ctx.tx.select({ id: schema.users.id, name: schema.users.name, userType: schema.users.userType, customerId: schema.users.customerId, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u) throw new NotFoundError('User');
  if (u.status !== 'active') throw new ValidationError(`${u.name} is not an active user and cannot approve`);
  const [holder] = u.userType === 'customer' && u.customerId === ticket.customerId
    ? await ctx.tx
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .innerJoin(schema.rolePermissions, eq(schema.rolePermissions.roleId, schema.userRoles.roleId))
        .where(and(eq(schema.userRoles.userId, u.id), eq(schema.rolePermissions.permission, 'portal:approve'), or(isNull(schema.userRoles.customerId), eq(schema.userRoles.customerId, ticket.customerId))))
        .limit(1)
    : [];
  if (!holder) throw new ValidationError(`${u.name} cannot approve for ${customerName}: give them the approval right first`);
  return u;
}

/** The addressee columns of one workflow step. */
function addressee(step: WorkflowStep, accountManagerId: string | null): Pick<typeof schema.approvals.$inferInsert, 'approverRoleKey' | 'approverUserId' | 'approverTeamId'> {
  switch (step.approverType) {
    case 'customer':
    case 'customer_admin':
    case 'customer_contact':
      return { approverRoleKey: ORG_APPROVERS_KEY };
    case 'role':
      // A workflow step on a customer role (an administrator's or an approver's) is the organisation step, one stored key.
      return { approverRoleKey: step.approverRef && CUSTOMER_ROLE_KEYS.includes(step.approverRef) ? ORG_APPROVERS_KEY : step.approverRef ?? 'service_manager' };
    case 'user':
      return { approverUserId: step.approverRef ?? null };
    case 'team':
      return { approverTeamId: step.approverRef ?? null };
    case 'account_manager':
      return accountManagerId ? { approverUserId: accountManagerId } : { approverRoleKey: 'account_manager' };
    default:
      return { approverRoleKey: step.approverRef ?? 'service_manager' };
  }
}

export interface ApprovalPlan {
  source: ApprovalSource;
  /** The workflow's or the ad-hoc step's name. */
  name: string;
  steps: WorkflowStep[];
  purpose: string;
  dueAt: Date | null;
  /** The first step's addressee and the party it makes the ticket wait on. */
  who: string;
  party: WaitingOn;
  /** The ticket was rejected and the request resubmits it: reopened first (a change to Draft, a request to its working status), then requested. */
  resubmits: boolean;
}

/** A ticket that was rejected (the Rejected status, or any ended status reached by a rejection): a new request resubmits it. */
const isRejected = (status: OptionRow | null, ticket: Pick<TicketRow, 'approvalStatus'>) => !!status && status.statusCategory === 'cancelled' && (status.key === 'rejected' || ticket.approvalStatus === 'rejected');

/**
 * Validates a request without writing anything (the assistant's preview and the request share it): the ticket must be
 * open or rejected (a rejected ticket is resubmitted: reopened, then requested), a change must be assessed, the
 * approver or the workflow must resolve, and the purpose defaults to the title.
 */
export async function planApproval(ctx: Ctx, ticket: TicketRow, input: RequestApprovalInput = {}): Promise<ApprovalPlan> {
  requireAction(ctx, ticket, ticket.type === 'change' ? 'changes:manage' : 'tickets:update');
  const status = await optionById(ctx.tx, ticket.statusId);
  const resubmits = isRejected(status, ticket);
  if (!resubmits && status && ENDED.includes(status.statusCategory ?? '')) throw new ValidationError(`${ticket.number} is ${status.label.toLowerCase()}; reopen it before requesting an approval`);
  // One approval at a time: the approvers of the open steps would lose their inbox row without a word. Withdraw first (they are told), then ask again.
  if (ticket.approvalStatus === 'pending') throw new ValidationError(`An approval is already pending on ${ticket.number}; withdraw it before requesting another`);
  if (input.approvalWorkflowId && input.approver) throw new ValidationError('Name either a workflow or an approver, not both');
  // Dynamic import: changes/service imports `decide` from this file, a static import back would be a cycle.
  if (ticket.type === 'change') await (await import('@/modules/changes/service')).requireAssessment(ctx, ticket.id);
  const purpose = (input.purpose?.trim() || `Approval for ${ticket.title}`).slice(0, 2000);
  // Any due date is accepted (the record's dialog keeps the picker on or after today; the demo seed backdates its own): an overdue step is the expiry job's business.
  const dueAt = input.dueAt ?? null;
  let source: ApprovalSource;
  let steps: WorkflowStep[];
  let name: string;
  if (input.approver) {
    const adHoc = await adHocStep(ctx, ticket, input.approver);
    steps = [adHoc.step];
    name = adHoc.name;
    source = { steps, name };
  } else {
    let wfId = input.approvalWorkflowId ?? null;
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
    const [wf] = await ctx.tx.select().from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.id, wfId)).limit(1);
    if (!wf) throw new NotFoundError('Approval workflow');
    steps = (wf.steps ?? []) as WorkflowStep[];
    if (!steps.length) throw new ValidationError('The approval workflow has no steps');
    name = wf.name;
    source = { workflowId: wf.id };
  }
  const [customer] = await ctx.tx.select({ accountManagerId: schema.customers.accountManagerId }).from(schema.customers).where(eq(schema.customers.id, ticket.customerId)).limit(1);
  const first = { customerId: ticket.customerId, approverRoleKey: null, approverUserId: null, approverTeamId: null, ...addressee(steps[0]!, customer?.accountManagerId ?? null) };
  return { source, name, steps, purpose, dueAt, who: await approverLabel(ctx, first), party: await partyOf(ctx, first), resubmits };
}

/** Where a resubmitted ticket reopens to: a change to Draft (its approval is not got yet), the other types to their working status. */
export const resubmitKey = (type: TicketRow['type']) => REJECTED_RETURN_KEY[type] ?? REOPEN_KEY[type];

// ---------------------------------------------------------------- start

/**
 * Creates one `approvals` row per step and moves the ticket of any type to Awaiting Approval with the purpose as the
 * reason of the wait and the first step's addressee as the party (a customer approver pauses the resolution and
 * restoration clocks, an internal one pauses nothing). Steps run in order: only the first is `pending`; the rest wait
 * and are released one at a time as each step is approved. A rejection anywhere ends the workflow and skips what is
 * left. Fails loudly when the status is not configured for the type.
 */
export async function startApproval(ctx: Ctx, ticket: TicketRow, source: ApprovalSource, opts: StartApprovalOptions): Promise<ApprovalRow[]> {
  let steps: WorkflowStep[];
  let name: string;
  let workflowId: string | null = null;
  if ('workflowId' in source) {
    const [wf] = await ctx.tx.select().from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.id, source.workflowId)).limit(1);
    if (!wf) throw new NotFoundError('Approval workflow');
    steps = (wf.steps ?? []) as WorkflowStep[];
    name = wf.name;
    workflowId = wf.id;
  } else {
    steps = source.steps;
    name = source.name;
  }
  if (!steps.length) throw new ValidationError('The approval workflow has no steps');
  const purpose = opts.purpose.trim();
  if (purpose.length < 3) throw new ValidationError('Say what needs approving (the purpose)');
  const settings = await loadApprovalSettings(ctx.tx);
  const now = new Date();
  const dueAt = opts.dueAt ?? endOfDayFrom(now, settings.defaultDueDays);
  const requestedBy = opts.requestedBy === undefined ? userIdOf(ctx) : opts.requestedBy;
  // The status is required before anything is written: an incident whose Awaiting Approval is not configured fails here, never silently.
  const awaiting = await statusByKey(ctx, 'awaiting_approval', ticket.type);

  // Supersede any open steps left behind (a request refuses while an approval is pending; this covers rows out of step with the ticket).
  await ctx.tx.update(schema.approvals).set({ status: 'superseded', decidedAt: now }).where(and(eq(schema.approvals.ticketId, ticket.id), inArray(schema.approvals.status, ['pending', 'waiting'])));
  const [customer] = await ctx.tx.select({ accountManagerId: schema.customers.accountManagerId }).from(schema.customers).where(eq(schema.customers.id, ticket.customerId)).limit(1);
  const rows: ApprovalRow[] = [];
  let i = 0;
  for (const step of steps) {
    i++;
    const values: typeof schema.approvals.$inferInsert = { ticketId: ticket.id, customerId: ticket.customerId, step: i, stepName: step.name ?? `Step ${i}`, status: i === 1 ? 'pending' : 'waiting', requestedBy, purpose, dueAt, ...addressee(step, customer?.accountManagerId ?? null) };
    const [row] = await ctx.tx.insert(schema.approvals).values(values).returning();
    rows.push(row);
  }
  await ctx.tx.update(schema.tickets).set({ approvalStatus: 'pending', updatedAt: now, lastActivityAt: now }).where(eq(schema.tickets.id, ticket.id));
  let current = await reloadTicket(ctx.tx, ticket.id);
  const first = rows[0]!;
  const party = await partyOf(ctx, first);
  const who = await approverLabel(ctx, first);
  // The request's activity is customer-visible only when the approver is a customer party (an internal approver is no wait the customer sees).
  await addActivity(ctx, ticket, {
    type: 'approval',
    summary: `Approval requested from ${who}: ${purpose}${dueAt ? ` · by ${fmtDay(dueAt)}` : ''}${rows.length > 1 ? ` (${name}: ${steps.map((s) => s.name ?? 'step').join(' → ')})` : ''}`,
    data: { workflowId, workflowName: name, purpose, dueAt, steps: rows.map((r) => ({ id: r.id, step: r.step, stepName: r.stepName })) },
    customerVisible: party === 'customer',
  });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'approval.request', customerId: ticket.customerId, metadata: { workflowId, workflowName: name, steps: rows.length, purpose, dueAt } });
  // The purpose is shown to a customer approver by design (the reason reads in the portal); no comment is posted for it, and an internal party keeps it with the desk.
  current = await changeStatusCore(ctx, current, awaiting, { action: 'approval', silent: true, flowSet: true, pendingReason: purpose, waitingOn: party, expectedAt: dueAt, tellCustomer: party === 'customer', postReason: false });
  if (!opts.silent) await notifyStepRequested(ctx, current, first, party);
  return rows;
}

/**
 * Tells the step's approvers (`approval.requested`) and, when the party is the customer, the requester that the ticket
 * waits on their organisation (`ticket.pending`), without a second message to an administrator who both raised the
 * ticket and must approve it.
 */
async function notifyStepRequested(ctx: Ctx, ticket: TicketRow, step: ApprovalRow, party: WaitingOn) {
  const who = await approverLabel(ctx, step);
  // A step released by a decision is still "requested by" the person who asked, not by the previous approver.
  const [requester] = step.requestedBy && step.requestedBy !== ctx.user.id ? await ctx.tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, step.requestedBy)).limit(1) : [];
  const actorName = requester?.name ?? null;
  await notifyTicketEvent(ctx, 'approval.requested', ticket, { recipientFallback: { approvers: true }, channels: CHANNELS, purpose: step.purpose, dueAt: step.dueAt, approver: who, actorName });
  if (party === 'customer') {
    const excludeUserIds = await approverUserIds(ctx.tx, ticket);
    await notifyTicketEvent(ctx, 'ticket.pending', ticket, { recipientFallback: { requester: true, watchers: true }, channels: CHANNELS, waitingOnLabel: waitingOnLabels('customer', { approval: true, canApprove: false }).customer, reason: step.purpose, expectedAt: step.dueAt, purpose: step.purpose, dueAt: step.dueAt, approver: who, actorName, excludeUserIds });
  }
}

/**
 * Requests an approval on any open ticket: a catalog workflow, the one named, or an approver named on the request
 * (an approver of the organisation, a user, a role or a team), with the purpose and a due date. A rejected
 * ticket is resubmitted: reopened first (a change to Draft, never to its working status; a request to In Fulfilment)
 * with the comment "Resubmitted for approval", the approvals service's own move, then requested.
 */
export async function requestApproval(ctx: Ctx, ticketId: string, input: RequestApprovalInput = {}) {
  let ticket = await loadTicket(ctx, ticketId);
  const plan = await planApproval(ctx, ticket, input);
  if (plan.resubmits) {
    const back = await statusByKey(ctx, resubmitKey(ticket.type), ticket.type);
    ticket = await changeStatusCore(ctx, ticket, back, { action: 'reopen', comment: `Resubmitted for approval: ${plan.purpose}`, silent: true, flowSet: true });
  }
  const rows = await startApproval(ctx, ticket, plan.source, { purpose: plan.purpose, dueAt: plan.dueAt });
  return { items: await decorate(ctx, rows), ticket: await reloadTicket(ctx.tx, ticket.id) };
}

// ---------------------------------------------------------------- reads

async function decorate(ctx: Ctx, rows: ApprovalRow[]) {
  const userIds = [...new Set(rows.flatMap((r) => [r.approverUserId, r.decidedBy, r.requestedBy]).filter((x): x is string => !!x))];
  const teamIds = [...new Set(rows.map((r) => r.approverTeamId).filter((x): x is string => !!x))];
  const roleKeys = [...new Set(rows.map((r) => r.approverRoleKey).filter((x): x is string => !!x))];
  const [users, teams, roles] = await Promise.all([
    userIds.length ? ctx.tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, userType: schema.users.userType }).from(schema.users).where(inArray(schema.users.id, userIds)) : [],
    teamIds.length ? ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(inArray(schema.teams.id, teamIds)) : [],
    roleKeys.length ? ctx.tx.select({ key: schema.roles.key, name: schema.roles.name }).from(schema.roles).where(inArray(schema.roles.key, roleKeys)) : [],
  ]);
  const lite = (id: string | null) => {
    const u = id ? users.find((x) => x.id === id) : undefined;
    return u ? { id: u.id, name: u.name, email: u.email } : null;
  };
  return rows.map((r) => ({
    ...r,
    approverUser: lite(r.approverUserId),
    approverTeam: teams.find((t) => t.id === r.approverTeamId) ?? null,
    approverRole: roles.find((x) => x.key === r.approverRoleKey) ?? (r.approverRoleKey ? { key: r.approverRoleKey, name: r.approverRoleKey } : null),
    decidedByUser: lite(r.decidedBy),
    requestedByUser: lite(r.requestedBy),
    /** Addressed to the customer (an administrator role or a customer user): the only steps a portal user may see. */
    customerParty: isCustomerParty(r, users.find((u) => u.id === r.approverUserId)?.userType ?? null),
    canDecide: r.status === 'pending' && isEligible(ctx, r),
  }));
}

/** A step addressed to a customer role, or to a user of the customer. */
const isCustomerParty = (r: Pick<ApprovalRow, 'approverRoleKey' | 'approverUserId'>, approverUserType: string | null) => (!!r.approverRoleKey && CUSTOMER_ROLE_KEYS.includes(r.approverRoleKey)) || (!!r.approverUserId && approverUserType === 'customer');
export type ApprovalView = Awaited<ReturnType<typeof decorate>>[number];

/**
 * Is the caller one of the addressees of this step? The organisation step (`ORG_APPROVERS_KEY`) is addressed to every
 * customer user of the step's organisation (`users.customer_id`, the principal's `customerId`) who holds `portal:approve`
 * for it, whatever role grants the right; any other role key is matched by the role itself.
 */
export function isEligible(ctx: Ctx, a: ApprovalRow): boolean {
  if (a.approverUserId && a.approverUserId === ctx.user.id) return true;
  if (a.approverRoleKey === ORG_APPROVERS_KEY && isCustomerUser(ctx)) return ctx.user.customerId === a.customerId && ctx.can('portal:approve', a.customerId);
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

/**
 * Pending approvals addressed to the caller (user, role for the customer, or team), with the purpose, the due date and
 * who asked. A customer user sees the organisation step only for their own organisation (`users.customer_id`) and only
 * when they hold `portal:approve` for it; a customer role of theirs never reaches another organisation's rows.
 */
export async function listMine(ctx: Ctx) {
  const roleKeys = [...new Set(ctx.user.roles.map((r) => r.key))];
  const teamIds = ctx.user.teams.map((t) => t.id);
  const conds = [eq(schema.approvals.approverUserId, ctx.user.id)];
  if (isCustomerUser(ctx)) {
    const own = ctx.user.customerId;
    if (own && ctx.can('portal:approve', own)) conds.push(and(eq(schema.approvals.approverRoleKey, ORG_APPROVERS_KEY), eq(schema.approvals.customerId, own))!);
    const otherKeys = roleKeys.filter((k) => !CUSTOMER_ROLE_KEYS.includes(k));
    if (own && otherKeys.length) conds.push(and(inArray(schema.approvals.approverRoleKey, otherKeys), eq(schema.approvals.customerId, own))!);
  } else if (roleKeys.length) {
    const scopedRoles = ctx.user.roles.filter((r) => r.customerId);
    const globalKeys = ctx.user.roles.filter((r) => !r.customerId).map((r) => r.key);
    if (globalKeys.length) conds.push(inArray(schema.approvals.approverRoleKey, globalKeys));
    for (const r of scopedRoles) conds.push(and(eq(schema.approvals.approverRoleKey, r.key), eq(schema.approvals.customerId, r.customerId!))!);
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
  const userIds = [...new Set(rows.flatMap((r) => [r.ticket.requesterUserId, r.approval.requestedBy]).filter((x): x is string => !!x))];
  const users = userIds.length ? await ctx.tx.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const nameOf = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);
  return {
    items: rows.map((r) => ({
      ...r.approval,
      requestedByName: nameOf(r.approval.requestedBy),
      ticket: { ...r.ticket, customerName: r.customerName, priority: toLabel(opts.get(r.ticket.priorityId ?? '')), status: toLabel(opts.get(r.ticket.statusId)), requesterName: nameOf(r.ticket.requesterUserId) },
    })),
    total: rows.length,
  };
}

// ---------------------------------------------------------------- decide

async function assertOpen(ctx: Ctx, ticket: TicketRow, what: string) {
  const status = await optionById(ctx.tx, ticket.statusId);
  if (status && ENDED.includes(status.statusCategory ?? '')) throw new ValidationError(`${ticket.number} is ${status.label.toLowerCase()}; ${what}`);
}

/** Is the ticket in the approval wait? Another wait entered by hand while the approval ran (a supplier, a change) is left as it is. */
async function inApprovalWait(ctx: Ctx, ticket: TicketRow) {
  const status = await optionById(ctx.tx, ticket.statusId);
  return status?.key === 'awaiting_approval';
}

/**
 * The rejection path by type and setting (`afterRejection`): a request ends as Rejected with the note posted as a
 * customer-visible comment (a change too under `approvals.rejected_change = rejected`); a change returns to Draft
 * with the note posted under `return` (the default); an incident or problem returns to the engineer with the note
 * posted. `approval_status` is set before the status moves, so ending the wait never trips the auto-cancel. Every
 * move is the service's own (`flowSet`). Shared by a decision and the expiry policy `reject`.
 */
async function applyRejection(ctx: Ctx, ticket: TicketRow, note: string | null, now: Date, trigger: Extract<ResumeTrigger, 'rejection' | 'expiry'>, settings: LifecycleSettings): Promise<TicketRow> {
  await ctx.tx.update(schema.approvals).set({ status: 'skipped', decidedAt: now }).where(and(eq(schema.approvals.ticketId, ticket.id), inArray(schema.approvals.status, ['pending', 'waiting'])));
  await ctx.tx.update(schema.tickets).set({ approvalStatus: 'rejected', updatedAt: now }).where(eq(schema.tickets.id, ticket.id));
  let current = await reloadTicket(ctx.tx, ticket.id);
  const outcome = afterRejection(ticket.type, settings);
  if (outcome === 'rejected') {
    const rejected = await statusByKey(ctx, 'rejected', ticket.type);
    if (current.statusId !== rejected.id) current = await changeStatusCore(ctx, current, rejected, { action: 'approval', silent: true, flowSet: true, comment: note ?? undefined });
  } else {
    // Only the approval wait is resumed (to the working status, or to Draft for a change under `return`); the note is
    // posted as the reply the requester reads (an expiry says so in the system's words).
    const resumed = (await inApprovalWait(ctx, current)) ? await resumeFromPending(ctx, current, { trigger, note, ...(outcome === 'return' ? { to: REJECTED_RETURN_KEY[ticket.type] } : {}) }) : null;
    if (resumed) current = resumed;
    else if (note) {
      // Not in the approval wait (moved by hand while the approval ran): the note still reaches the conversation.
      await ctx.tx.insert(schema.ticketComments).values({ ticketId: ticket.id, customerId: ticket.customerId, authorId: userIdOf(ctx), authorName: ctx.user.name, kind: 'comment', isInternal: false, body: note, source: ctx.source, createdAt: now });
    }
  }
  return current;
}

/** The approval is complete: the ticket returns to the type's working status (a change to Approved) with the clocks resumed. */
async function applyApproval(ctx: Ctx, ticket: TicketRow, note: string | null, now: Date): Promise<TicketRow> {
  // The approval status is set before any status change it triggers, so ending the wait never trips the auto-cancel.
  await ctx.tx.update(schema.tickets).set({ approvalStatus: 'approved', updatedAt: now }).where(eq(schema.tickets.id, ticket.id));
  let current = await reloadTicket(ctx.tx, ticket.id);
  const status = await optionById(ctx.tx, current.statusId);
  if (status?.key === 'awaiting_approval') return (await resumeFromPending(ctx, current, { trigger: 'approval', note })) ?? current;
  // Another wait entered by hand while the approval ran (a supplier, a change) is left as it is; a working status moves to the type's after-approval status when it differs.
  if (status && isWait(status)) return current;
  const next = await statusByKey(ctx, AFTER_APPROVAL_KEY[ticket.type], ticket.type);
  if (next.id !== current.statusId) current = await changeStatusCore(ctx, current, next, { action: 'approval', silent: true, flowSet: true });
  return current;
}

/**
 * Whether the outcome of a decision stays with the desk: an internal step (the CAB, a role, a team) is no wait the
 * customer ever saw, so a return to the working status is told to staff only; an outcome the customer can see on the
 * ticket (a request or change ending as Rejected, a change returning to Draft, a change moving to Approved) is told
 * to the requester as well.
 */
function outcomeStaysInternal(ticket: TicketRow, party: WaitingOn, decision: 'approved' | 'rejected', settings: LifecycleSettings) {
  if (party === 'customer') return false;
  return decision === 'rejected' ? afterRejection(ticket.type, settings) === 'working' : AFTER_APPROVAL_KEY[ticket.type] === REOPEN_KEY[ticket.type];
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
  await assertOpen(ctx, ticket, 'the approval can no longer be decided');
  const settings = await loadLifecycleSettings(ctx.tx);
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:approve', ticket.customerId) || ctx.user.customerId !== ticket.customerId) throw new ForbiddenError('Missing permission: portal:approve');
    const addressedToCustomer = (a.approverRoleKey && CUSTOMER_ROLE_KEYS.includes(a.approverRoleKey)) || a.approverUserId === ctx.user.id;
    if (!addressedToCustomer || !isEligible(ctx, a)) throw new ForbiddenError('This approval step is not addressed to you');
  } else {
    ctx.require(ticket.type === 'change' ? 'changes:approve' : 'requests:approve', ticket.customerId);
  }
  // The reason of a rejection reaches the requester: a customer's rejection needs a note by default (`approvals.rejection_note_required`: none, portal, all).
  if (decision === 'rejected' && rejectionNoteRequired(settings, isCustomerUser(ctx)) && !comment?.trim()) throw new ValidationError('Say why you are rejecting the request; the note is shown to the requester');
  const note = comment?.trim() || null;
  const now = new Date();
  // An internal step is the desk's business: its decision row never reaches a customer user, and its outcome only when the ticket's status shows it.
  const party = await partyOf(ctx, a);
  const staffOnly = outcomeStaysInternal(ticket, party, decision, settings);
  await ctx.tx.update(schema.approvals).set({ status: decision, decidedBy: userIdOf(ctx), decidedAt: now, comment: note }).where(eq(schema.approvals.id, a.id));
  await addActivity(ctx, ticket, { type: 'approval', summary: `${a.stepName ?? `Step ${a.step}`} ${decision} by ${ctx.user.name}${note ? `: ${note}` : ''}`, data: { approvalId: a.id, step: a.step, decision, comment: note }, customerVisible: party === 'customer' });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: `approval.${decision}`, customerId: ticket.customerId, metadata: { approvalId: a.id, step: a.step, comment: note } });

  let current = await reloadTicket(ctx.tx, ticket.id);
  if (decision === 'rejected') {
    current = await applyRejection(ctx, current, note, now, 'rejection', settings);
    await notifyTicketEvent(ctx, 'approval.rejected', current, { comment: note, recipientFallback: { requester: true, assignee: true }, channels: CHANNELS, purpose: a.purpose, dueAt: a.dueAt, approver: ctx.user.name, staffOnly });
  } else {
    // Release the next waiting step, if any; otherwise the workflow is complete.
    const [nextStep] = await ctx.tx.select().from(schema.approvals).where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'waiting'))).orderBy(asc(schema.approvals.step)).limit(1);
    if (nextStep) {
      const [released] = await ctx.tx.update(schema.approvals).set({ status: 'pending' }).where(eq(schema.approvals.id, nextStep.id)).returning();
      const party = await partyOf(ctx, nextStep);
      const who = await approverLabel(ctx, nextStep);
      await addActivity(ctx, ticket, { type: 'approval', summary: `${nextStep.stepName ?? `Step ${nextStep.step}`} is now awaiting approval from ${who}`, data: { approvalId: nextStep.id, step: nextStep.step, purpose: nextStep.purpose, dueAt: nextStep.dueAt }, customerVisible: party === 'customer' });
      // The party is re-derived on every step: the clocks pause when the step moves to the customer and resume when it moves inside.
      const awaiting = await statusByKey(ctx, 'awaiting_approval', ticket.type);
      if (current.statusId === awaiting.id) current = await changeStatusCore(ctx, current, awaiting, { action: 'approval', silent: true, flowSet: true, pendingReason: nextStep.purpose ?? current.pendingReason ?? `Approval requested (${nextStep.stepName ?? `step ${nextStep.step}`})`, waitingOn: party, expectedAt: nextStep.dueAt, tellCustomer: party === 'customer', postReason: false });
      await notifyStepRequested(ctx, current, released!, party);
    } else {
      current = await applyApproval(ctx, current, note, now);
      await notifyTicketEvent(ctx, 'approval.approved', current, { comment: note, recipientFallback: { requester: true, assignee: true }, channels: CHANNELS, purpose: a.purpose, dueAt: a.dueAt, approver: ctx.user.name, staffOnly });
    }
  }
  return listForTicket(ctx, ticket.id);
}

// ---------------------------------------------------------------- withdraw

/**
 * Ends a pending approval the desk no longer needs: the approvers (and the requester) are told before the rows change,
 * the pending and waiting steps become `cancelled` with the reason, and the ticket returns to work with the clocks resumed.
 */
export async function withdraw(ctx: Ctx, ticketId: string, reason?: string | null) {
  const ticket = await loadTicket(ctx, ticketId);
  requireAction(ctx, ticket, ticket.type === 'change' ? 'changes:manage' : 'tickets:update');
  if (ticket.approvalStatus !== 'pending') throw new ValidationError(`No approval is pending on ${ticket.number}`);
  const note = reason?.trim() || null;
  const now = new Date();
  const [pending] = await ctx.tx.select().from(schema.approvals).where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'pending'))).orderBy(asc(schema.approvals.step)).limit(1);
  const party = pending ? await partyOf(ctx, pending) : 'internal';
  // Approvers are resolved from the rows while they are still pending: the notification goes first.
  await notifyTicketEvent(ctx, 'approval.withdrawn', ticket, { comment: note, reason: note, recipientFallback: { approvers: true, requester: true }, channels: CHANNELS, purpose: pending?.purpose ?? null, dueAt: pending?.dueAt ?? null, staffOnly: party !== 'customer' });
  const rows = await ctx.tx
    .update(schema.approvals)
    .set({ status: 'cancelled', decidedBy: userIdOf(ctx), decidedAt: now, comment: note })
    .where(and(eq(schema.approvals.ticketId, ticket.id), inArray(schema.approvals.status, ['pending', 'waiting'])))
    .returning({ id: schema.approvals.id });
  await ctx.tx.update(schema.tickets).set({ approvalStatus: 'withdrawn', updatedAt: now }).where(eq(schema.tickets.id, ticket.id));
  await addActivity(ctx, ticket, { type: 'approval', summary: `Approval request withdrawn by ${ctx.user.name}${note ? `: ${note}` : ''}`, data: { withdrawn: rows.map((r) => r.id), reason: note }, customerVisible: party === 'customer' });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'approval.withdraw', customerId: ticket.customerId, metadata: { reason: note, steps: rows.length } });
  let current = await reloadTicket(ctx.tx, ticket.id);
  const status = await optionById(ctx.tx, current.statusId);
  // The reason stays on the rows, the activity and approval.withdrawn (queued above): the resume posts no reply and queues no second message.
  if (status?.key === 'awaiting_approval') current = (await resumeFromPending(ctx, current, { trigger: 'withdrawal', note })) ?? current;
  return listForTicket(ctx, ticket.id);
}

// ---------------------------------------------------------------- reminders and expiry

/** Reminds the approvers of every pending step on the ticket now (by hand), whatever `reminded_at` says. */
export async function remind(ctx: Ctx, ticketId: string) {
  const ticket = await loadTicket(ctx, ticketId);
  requireAction(ctx, ticket, ticket.type === 'change' ? 'changes:manage' : 'tickets:update');
  const pending = await ctx.tx.select().from(schema.approvals).where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'pending'))).orderBy(asc(schema.approvals.step));
  if (!pending.length) throw new ValidationError(`No approval is pending on ${ticket.number}`);
  const n = await remindRows(ctx, ticket, pending, `by ${ctx.user.name}`);
  return { reminded: n, items: (await listForTicket(ctx, ticket.id)).items };
}

async function remindRows(ctx: Ctx, ticket: TicketRow, pending: ApprovalRow[], by: string) {
  const first = pending[0]!;
  const who = await approverLabel(ctx, first);
  const queued = await notifyTicketEvent(ctx, 'approval.reminder', ticket, { recipientFallback: { approvers: true }, channels: CHANNELS, purpose: first.purpose, dueAt: first.dueAt, approver: who });
  const now = new Date();
  await ctx.tx.update(schema.approvals).set({ remindedAt: now }).where(inArray(schema.approvals.id, pending.map((p) => p.id)));
  await addActivity(ctx, ticket, { type: 'approval', summary: `Approvers reminded ${by}: ${who}${first.dueAt ? ` · due ${fmtDay(first.dueAt)}` : ''}`, data: { approvalIds: pending.map((p) => p.id), queued }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'approval.remind', customerId: ticket.customerId, metadata: { steps: pending.length, queued } });
  return queued;
}

/**
 * The hourly sweep: approvers of a step pending for longer than `approvals.reminder_hours` are reminded once; a step
 * whose due date plus `approvals.expiry_days` has passed is expired by `approvals.expiry_policy`: `return` sends the
 * ticket back to work, `reject` applies the type's rejection path, `none` only reminds. One transaction per ticket.
 */
export async function remindAndExpire(now = new Date()) {
  const settings = await withSystem((tx) => loadApprovalSettings(tx));
  const remindBefore = new Date(now.getTime() - settings.reminderHours * 3_600_000);
  const expireBefore = new Date(now.getTime() - settings.expiryDays * 86_400_000);
  const candidates = await withSystem(async (tx) => {
    const remind = settings.reminderHours > 0
      ? await tx.selectDistinct({ ticketId: schema.approvals.ticketId }).from(schema.approvals).where(and(eq(schema.approvals.status, 'pending'), isNull(schema.approvals.remindedAt), lt(schema.approvals.createdAt, remindBefore))).limit(500)
      : [];
    const expire = settings.expiryPolicy !== 'none'
      ? await tx.selectDistinct({ ticketId: schema.approvals.ticketId }).from(schema.approvals).where(and(eq(schema.approvals.status, 'pending'), lt(schema.approvals.dueAt, expireBefore))).limit(500)
      : [];
    return { remind: remind.map((r) => r.ticketId), expire: expire.map((r) => r.ticketId) };
  });
  let reminded = 0;
  let expired = 0;
  const expireSet = new Set(candidates.expire);
  for (const ticketId of candidates.expire) {
    try {
      await withSystem(async (tx) => {
        const ctx = systemCtx(tx, 'approval-expiry');
        const ticket = await reloadTicket(tx, ticketId);
        if (ticket.approvalStatus !== 'pending') return;
        const pending = await tx.select().from(schema.approvals).where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'pending'))).orderBy(asc(schema.approvals.step));
        const due = pending.filter((p) => p.dueAt && p.dueAt.getTime() < expireBefore.getTime());
        if (!due.length || settings.expiryPolicy === 'none') return;
        await expireTicket(ctx, ticket, pending, settings.expiryPolicy, now);
        expired++;
      });
    } catch (err) {
      logger.error({ err, ticketId }, 'approval expiry failed');
    }
  }
  for (const ticketId of candidates.remind) {
    if (expireSet.has(ticketId)) continue;
    try {
      await withSystem(async (tx) => {
        const ctx = systemCtx(tx, 'approval-reminder');
        const ticket = await reloadTicket(tx, ticketId);
        if (ticket.approvalStatus !== 'pending') return;
        // A step of a workflow is pending since its release (the previous step's decision), not since the rows were created with the request.
        const all = await tx.select().from(schema.approvals).where(eq(schema.approvals.ticketId, ticket.id)).orderBy(asc(schema.approvals.step));
        const pending = all.filter((p) => p.status === 'pending' && !p.remindedAt && pendingSince(p, all).getTime() < remindBefore.getTime());
        if (!pending.length) return;
        await remindRows(ctx, ticket, pending, `after ${settings.reminderHours} hours without a decision`);
        reminded++;
      });
    } catch (err) {
      logger.error({ err, ticketId }, 'approval reminder failed');
    }
  }
  if (reminded || expired) logger.info({ reminded, expired, policy: settings.expiryPolicy }, 'approval reminders and expiries');
  return { reminded, expired };
}

/** When a pending step started waiting: its creation, or the latest decision of an earlier step of the same request that released it. */
function pendingSince(step: ApprovalRow, all: ApprovalRow[]): Date {
  const released = all.filter((o) => o.step < step.step && o.status === 'approved' && o.decidedAt).map((o) => o.decidedAt!.getTime());
  return new Date(Math.max(step.createdAt.getTime(), ...released));
}

/** Expires the pending steps of one ticket under the policy (the approvers, the requester and the assignee are told first). */
async function expireTicket(ctx: Ctx, ticket: TicketRow, pending: ApprovalRow[], policy: Exclude<ExpiryPolicy, 'none'>, now: Date) {
  const first = pending[0]!;
  const who = await approverLabel(ctx, first);
  const due = fmtDay(first.dueAt);
  const settings = await loadLifecycleSettings(ctx.tx);
  const path = policy === 'reject' ? afterRejection(ticket.type, settings) : 'working';
  const outcome = path === 'rejected' ? 'the request is rejected' : path === 'return' ? 'the change returns to Draft' : 'the ticket returns to the service desk';
  const note = `No decision by ${due}: ${outcome}`;
  const party = await partyOf(ctx, first);
  await notifyTicketEvent(ctx, 'approval.expired', ticket, { reason: note, comment: note, recipientFallback: { approvers: true, requester: true, assignee: true }, channels: CHANNELS, purpose: first.purpose, dueAt: first.dueAt, approver: who, staffOnly: policy === 'reject' ? outcomeStaysInternal(ticket, party, 'rejected', settings) : party !== 'customer' });
  await ctx.tx.update(schema.approvals).set({ status: 'expired', decidedAt: now, comment: note }).where(inArray(schema.approvals.id, pending.map((p) => p.id)));
  await addActivity(ctx, ticket, { type: 'approval', summary: `Approval expired without a decision from ${who} (due ${due}): ${outcome}`, data: { approvalIds: pending.map((p) => p.id), policy, dueAt: first.dueAt }, customerVisible: ticket.pendingWaitingOn === 'customer' });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'approval.expire', customerId: ticket.customerId, metadata: { policy, steps: pending.length, dueAt: first.dueAt } });
  if (policy === 'reject') {
    await applyRejection(ctx, ticket, note, now, 'expiry', settings);
    return;
  }
  // `return`: the waiting steps are over too; the approval status says it expired before the status moves (only the approval wait is resumed).
  await ctx.tx.update(schema.approvals).set({ status: 'expired', decidedAt: now, comment: note }).where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'waiting')));
  await ctx.tx.update(schema.tickets).set({ approvalStatus: 'expired', updatedAt: now }).where(eq(schema.tickets.id, ticket.id));
  const current = await reloadTicket(ctx.tx, ticket.id);
  if (await inApprovalWait(ctx, current)) await resumeFromPending(ctx, current, { trigger: 'expiry' });
}
