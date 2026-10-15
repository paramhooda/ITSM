import { z } from 'zod';
import { and, eq, ilike, isNull, or } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError, NotFoundError } from '@/core/errors';
import { listMine, listForTicket, decide, requestApproval, planApproval, withdraw, partyOf, approverLabel, resubmitKey } from '@/modules/tickets/approvals';
import { AFTER_APPROVAL_KEY, REJECTED_RETURN_KEY, REOPEN_KEY, afterRejection, statusByKey } from '@/modules/tickets/status';
import { loadLifecycleSettings, rejectionNoteRequired } from '@/modules/tickets/settings';
import { loadPauseRule, metricPauses, waitPauses } from '@/modules/sla/pause';
import { listPortalApprovals, decidePortalApproval } from '@/modules/portal/service';
import { type TicketRow, optionById } from '@/modules/tickets/common';
import { activeSlaRows } from '@/modules/sla/engine';
import type { RequestApprovalInput } from '@/modules/tickets/schemas';
import { define } from './types';
import { ticketRef } from './core';
import { isCustomerUser, ticketLink, iso, trunc, resolveTicket, resolveTeam, resolveUser, parseWhen, like } from '../helpers';

/** Approval tools: what waits for the user, requesting one on any ticket naming the approver, deciding, withdrawing. */

const short = (t: Pick<TicketRow, 'number' | 'title'>) => `${t.number} ("${t.title.slice(0, 80)}")`;
const fmtDay = (d: Date | null | undefined) => (d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null);

/** The pending step on a ticket the caller may decide (optionally a specific step number or name). */
async function pendingStep(ctx: Ctx, t: TicketRow, step?: string | number) {
  const items = isCustomerUser(ctx)
    ? (await listPortalApprovals(ctx)).items.filter((a) => a.ticket.id === t.id && a.status === 'pending').map((a) => ({ id: a.id, step: a.step, stepName: a.stepName, purpose: a.purpose }))
    : (await listForTicket(ctx, t.id)).items.filter((a) => a.status === 'pending' && a.canDecide).map((a) => ({ id: a.id, step: a.step, stepName: a.stepName, purpose: a.purpose }));
  if (!items.length) throw new ValidationError(`No approval step on ${t.number} is waiting for your decision`);
  if (step === undefined || step === null || step === '') {
    if (items.length === 1) return items[0]!;
    throw new ValidationError(`${t.number} has ${items.length} steps waiting for you: ${items.map((a) => `${a.step} ${a.stepName ?? ''}`.trim()).join(', ')}. Name the step.`);
  }
  const s = String(step).trim().toLowerCase();
  const hit = items.find((a) => String(a.step) === s) ?? items.find((a) => (a.stepName ?? '').toLowerCase() === s) ?? items.find((a) => (a.stepName ?? '').toLowerCase().includes(s));
  if (!hit) throw new ValidationError(`No pending step "${step}" on ${t.number}; waiting: ${items.map((a) => `${a.step} ${a.stepName ?? ''}`.trim()).join(', ')}`);
  return hit;
}

const approverInput = z.object({
  kind: z.enum(['customer', 'customer_admin', 'user', 'role', 'team', 'workflow']).describe('customer: anyone who may approve for the ticket\'s organisation (its administrators and the users given the approval right), or one of them by name (customer_admin is an alias); user: a staff user by name or email; role: an internal role by key or name; team: a team by name; workflow: a configured approval workflow by name'),
  ref: z.string().max(200).optional().describe('The name, email, key or workflow name; omit for "anyone who may approve for the organisation"'),
});

/**
 * Turns the approver the model named into the request's shape: names are resolved here (the service takes ids and keys),
 * a customer approver only among the ticket organisation's own active portal users (`users.customer_id = ticket.customerId`)
 * who hold `portal:approve` for it, whatever role grants the right.
 */
async function resolveApprover(ctx: Ctx, t: TicketRow, approver: z.infer<typeof approverInput> | undefined): Promise<RequestApprovalInput> {
  if (!approver) return {};
  const ref = approver.ref?.trim() || null;
  switch (approver.kind) {
    case 'workflow': {
      const wf = await workflowByName(ctx, ref);
      return { approvalWorkflowId: wf?.id ?? null };
    }
    case 'customer':
    case 'customer_admin': {
      if (!ref) return { approver: { kind: 'customer' } };
      const rows = await ctx.tx
        .selectDistinct({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .innerJoin(schema.userRoles, eq(schema.userRoles.userId, schema.users.id))
        .innerJoin(schema.rolePermissions, eq(schema.rolePermissions.roleId, schema.userRoles.roleId))
        .where(
          and(
            eq(schema.users.userType, 'customer'),
            eq(schema.users.customerId, t.customerId),
            eq(schema.users.status, 'active'),
            eq(schema.rolePermissions.permission, 'portal:approve'),
            or(isNull(schema.userRoles.customerId), eq(schema.userRoles.customerId, t.customerId)),
            or(ilike(schema.users.name, like(ref)), ilike(schema.users.email, ref)),
          ),
        )
        .limit(6);
      const exact = rows.filter((u) => u.name.toLowerCase() === ref.toLowerCase() || u.email.toLowerCase() === ref.toLowerCase());
      const pick = exact.length === 1 ? exact : rows;
      if (!pick.length) throw new NotFoundError('Approver', `No approver of the ticket's organisation matching "${ref}"`);
      if (pick.length > 1) throw new ValidationError(`"${ref}" is ambiguous among the organisation's approvers: ${pick.map((u) => u.name).join(', ')}`);
      return { approver: { kind: 'customer', ref: pick[0]!.id } };
    }
    case 'user': {
      const u = await resolveUser(ctx, ref);
      if (!u) throw new ValidationError('Name the user who should approve');
      return { approver: { kind: 'user', ref: u.id } };
    }
    case 'role': {
      if (!ref) throw new ValidationError('Name the role that should approve');
      const rows = await ctx.tx.select({ key: schema.roles.key, name: schema.roles.name }).from(schema.roles).where(or(eq(schema.roles.key, ref.toLowerCase().replace(/\s+/g, '_')), ilike(schema.roles.name, like(ref)))).limit(6);
      const exact = rows.filter((r) => r.key === ref.toLowerCase().replace(/\s+/g, '_') || r.name.toLowerCase() === ref.toLowerCase());
      const pick = exact.length === 1 ? exact : rows;
      if (!pick.length) throw new NotFoundError('Role', `No role matching "${ref}"`);
      if (pick.length > 1) throw new ValidationError(`Role "${ref}" is ambiguous: ${pick.map((r) => r.name).join(', ')}`);
      return { approver: { kind: 'role', ref: pick[0]!.key } };
    }
    case 'team': {
      const team = await resolveTeam(ctx, ref);
      if (!team) throw new ValidationError('Name the team that should approve');
      return { approver: { kind: 'team', ref: team.id } };
    }
    default:
      throw new ValidationError('Unknown approver kind');
  }
}

const requestInput = z.object({
  ticket: ticketRef,
  approver: approverInput.optional().describe('Who decides; omitted: the catalog item\'s workflow, else the default workflow for the type'),
  purpose: z.string().min(3).max(2000).describe('What needs approving, shown to the approver and the requester'),
  dueAt: z.string().max(60).optional().describe('When a decision is expected (ISO date or a natural date); default from approvals.default_due_days'),
});

async function describeRequest(ctx: Ctx, input: z.infer<typeof requestInput>) {
  const t = await resolveTicket(ctx, input.ticket);
  const body: RequestApprovalInput = { ...(await resolveApprover(ctx, t, input.approver)), purpose: input.purpose, dueAt: parseWhen(input.dueAt, 'due date') };
  const plan = await planApproval(ctx, t, body);
  return { t, body, plan };
}

export const APPROVALS: ReturnType<typeof define>[] = [
  define({
    name: 'my_approvals',
    toolset: 'approvals',
    description: 'Tickets of any type waiting for the user\'s approval decision (addressed to them, their role or their team): what needs approving, who asked and by when.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(30).optional() }),
    requires: ['tickets:read'],
    portal: ['portal:approve'],
    action: false,
    run: async (ctx, input) => {
      const limit = input.limit ?? 20;
      if (isCustomerUser(ctx)) {
        const res = await listPortalApprovals(ctx);
        return { total: res.total, facts: [`${res.total} approval(s) waiting for ${ctx.user.name}`], items: res.items.slice(0, limit).map((a) => ({ approvalId: a.id, step: a.step, stepName: a.stepName, purpose: a.purpose, dueAt: iso(a.dueAt), requestedBy: a.requestedByName, waitingSince: iso(a.createdAt), ticket: { number: a.ticket.number, title: a.ticket.title, type: a.ticket.type, requester: a.ticket.requesterName, priority: a.ticket.priority?.label ?? null, status: a.ticket.status?.label ?? null, catalogItem: a.ticket.catalogItemName, description: trunc(a.ticket.description, 400), link: ticketLink(ctx, a.ticket.id) } })) };
      }
      const res = await listMine(ctx);
      return { total: res.total, facts: [`${res.total} approval(s) waiting for ${ctx.user.name}`], items: res.items.slice(0, limit).map((a) => ({ approvalId: a.id, step: a.step, stepName: a.stepName, purpose: a.purpose, dueAt: iso(a.dueAt), requestedBy: a.requestedByName, waitingSince: iso(a.createdAt), ticket: { number: a.ticket.number, title: a.ticket.title, type: a.ticket.type, customer: a.ticket.customerName, requester: a.ticket.requesterName, priority: a.ticket.priority, status: a.ticket.status, createdAt: iso(a.ticket.createdAt), description: trunc(a.ticket.description, 400), link: ticketLink(ctx, a.ticket.id) } })) };
    },
    summary: (_i, result) => `Listed ${(result as { total: number }).total} pending approval(s)`,
  }),

  define({
    name: 'request_approval',
    toolset: 'approvals',
    tier: 'write',
    description:
      'Request an approval on any open ticket (incident, request, problem or change) naming who decides: an approver of the customer organisation (anyone who may approve for it, or one by name), a staff user, a role, a team or a configured workflow; with the purpose and a due date. The ticket waits in Awaiting Approval; the clocks the SLA policy names pause while a customer decides (resolution and restoration by default) and keep running for an internal approver. A request on a rejected ticket resubmits it (a change returns to Draft first). The approvers are notified and the requester is told when the wait is on their organisation.',
    inputSchema: requestInput,
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets', 'approvals'],
    run: async (ctx, input) => {
      const { t, body } = await describeRequest(ctx, input);
      const res = await requestApproval(ctx, t.id, body);
      return { ticket: t.number, approvalStatus: res.ticket.approvalStatus, status: res.ticket.statusId, waitingOn: res.ticket.pendingWaitingOn, purpose: body.purpose, dueAt: iso(res.items[0]?.dueAt), steps: res.items.map((a) => ({ step: a.step, name: a.stepName, status: a.status, approver: a.approverUser?.name ?? a.approverTeam?.name ?? a.approverRole?.name ?? null, dueAt: iso(a.dueAt) })), link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => `Requested approval on ${input.ticket} (${(result as { steps: unknown[] }).steps.length} step(s))`,
    preview: async (ctx, input) => {
      const { t, plan } = await describeRequest(ctx, input);
      const lines: string[] = [];
      const [customer] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, t.customerId)).limit(1);
      const who = plan.party === 'customer' && !plan.who.startsWith('the approvers') ? `${plan.who} (customer approver, ${customer?.name ?? 'the customer'})` : plan.who;
      lines.push(plan.steps.length > 1 ? `Start the "${plan.name}" workflow (${plan.steps.map((s) => s.name ?? 'step').join(' → ')}), first asking ${who} to approve: ${plan.purpose}` : `Ask ${who} to approve: ${plan.purpose}`);
      lines.push(plan.dueAt ? `Due ${fmtDay(plan.dueAt)}` : 'Due by the default (approvals.default_due_days)');
      const awaiting = await statusByKey(ctx, 'awaiting_approval', t.type);
      if (plan.resubmits) {
        const back = await statusByKey(ctx, resubmitKey(t.type), t.type);
        lines.push(t.type === 'change' ? `${t.number} returns to ${back.label} and is resubmitted` : `${t.number} is reopened and resubmitted`);
      }
      const rows = await activeSlaRows(ctx.tx, t.id);
      // The clock line reads the ticket's SLA policy: which clocks pause and whether a wait on this party pauses them.
      const rule = await loadPauseRule(ctx.tx, rows[0]?.policyId ?? t.slaPolicyId);
      const pausable = rows.filter((r) => r.state === 'running' && metricPauses(rule, r.metric));
      const ruleWords = rule.metrics.length ? `the ${rule.metrics.join(' and ')} ${rule.metrics.length > 1 ? 'clocks pause' : 'clock pauses'}` : 'no clock pauses';
      if (plan.party === 'customer' && waitPauses(rule, 'customer')) lines.push(`${t.number} moves to ${awaiting.label}; ${pausable.length ? ruleWords : `no ${rule.metrics.join(' or ') || 'pausable'} clock is running to pause`}`);
      else if (plan.party === 'customer') lines.push(`${t.number} moves to ${awaiting.label}; the clocks keep running (the SLA policy does not pause for the customer's approval)`);
      else lines.push(`${t.number} moves to ${awaiting.label}; ${waitPauses(rule, 'internal') && pausable.length ? `${ruleWords} (the SLA policy pauses for an internal approver)` : 'the clocks keep running (internal approver)'}`);
      lines.push(plan.party === 'customer' ? 'Approvers are notified by email, in-app and WhatsApp; the requester is told the ticket waits on their organisation' : 'Approvers are notified by email, in-app and WhatsApp');
      return { text: `Request approval on ${short(t)}`, lines };
    },
  }),

  define({
    name: 'withdraw_approval',
    toolset: 'approvals',
    tier: 'write',
    description: 'Withdraw the approval still pending on a ticket (the desk no longer needs the decision): the approvers are told, the steps are cancelled and the ticket returns to work with its clocks resumed. Only on an explicit instruction naming the ticket.',
    inputSchema: z.object({ ticket: ticketRef, reason: z.string().max(2000).optional().describe('Why the approval is no longer needed') }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets', 'approvals'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const res = await withdraw(ctx, t.id, input.reason ?? null);
      return { ticket: t.number, approvalStatus: res.approvalStatus, cancelled: res.items.filter((a) => a.status === 'cancelled').length, link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `Withdrew the approval on ${input.ticket}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      if (t.approvalStatus !== 'pending') throw new ValidationError(`No approval is pending on ${t.number}`);
      const pending = (await listForTicket(ctx, t.id)).items.filter((a) => a.status === 'pending').sort((a, b) => a.step - b.step);
      const first = pending[0];
      const who = first ? await approverLabel(ctx, first) : 'the approvers';
      const party = first ? await partyOf(ctx, first) : 'internal';
      const status = await optionById(ctx.tx, t.statusId);
      const back = await statusByKey(ctx, REOPEN_KEY[t.type], t.type);
      // A step addressed to a named person already carries the name ("Approval by Manish Agarwal"): the approver is not repeated.
      const stepLabel = first ? `${first.stepName ?? `step ${first.step}`}${(first.stepName ?? '').includes(who) ? '' : `, waiting for ${who}`} since ${fmtDay(first.createdAt)}` : '';
      const lines = [`Withdraw the pending approval on ${t.number}${first ? ` (${stepLabel})` : ''}`];
      // Whether the clocks were paused for this approver's party is the SLA policy's rule, not a constant.
      const paused = (await activeSlaRows(ctx.tx, t.id)).some((r) => r.state === 'paused');
      if (status?.key === 'awaiting_approval') lines.push(`${t.number} returns to ${back.label}${paused ? ' and the clocks resume' : party === 'customer' ? '; no clock was paused' : '; the clocks were never paused (internal approver)'}`);
      lines.push(input.reason ? `Reason: ${trunc(input.reason, 160)}` : 'The approvers and the requester are told');
      return { text: `Withdraw the approval on ${short(t)}`, lines };
    },
  }),

  define({
    name: 'decide_approval',
    toolset: 'approvals',
    description: 'Approve or reject the approval step on a ticket that is waiting for the user. Only on explicit instruction naming the ticket and the decision; a rejection needs a comment when the lifecycle settings say so (from the portal by default). A rejected change returns to Draft by default; a rejected request ends as Rejected.',
    inputSchema: z.object({ ticket: ticketRef, decision: z.enum(['approved', 'rejected']), comment: z.string().max(2000).optional(), step: z.union([z.string().max(100), z.number().int()]).optional().describe('Step number or name when several wait') }),
    requires: ['tickets:read'],
    portal: ['portal:approve'],
    action: true,
    invalidates: ['tickets', 'approvals'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const step = await pendingStep(ctx, t, input.step);
      const res = isCustomerUser(ctx) ? await decidePortalApproval(ctx, t.id, step.id, input.decision, input.comment ?? null) : await decide(ctx, t.id, step.id, input.decision, input.comment ?? null);
      return { ticket: t.number, step: step.step, decision: input.decision, approvalStatus: res.approvalStatus, link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `${input.decision === 'approved' ? 'Approved' : 'Rejected'} ${input.ticket}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const step = await pendingStep(ctx, t, input.step);
      const settings = await loadLifecycleSettings(ctx.tx);
      if (input.decision === 'rejected' && rejectionNoteRequired(settings, isCustomerUser(ctx)) && !input.comment?.trim()) throw new ValidationError('Say why you are rejecting the request; the note is shown to the requester');
      const lines = [`${input.decision === 'approved' ? 'Approve' : 'Reject'} step ${step.step}${step.stepName ? ` "${step.stepName}"` : ''}${step.purpose ? `: ${trunc(step.purpose, 160)}` : ''}`];
      if (input.comment) lines.push(`Comment: ${trunc(input.comment, 120)}`);
      // The steps still waiting (a portal user's read is fenced to the organisation's ticket; the count names nobody): the card promises a return to work only when this is the last step.
      const remaining = (await listForTicket(ctx, t.id)).items.filter((a) => a.status === 'waiting').length;
      if (input.decision === 'approved') {
        if (remaining) lines.push(`The next step is released (${remaining} more to decide)`);
        else {
          const next = await statusByKey(ctx, AFTER_APPROVAL_KEY[t.type], t.type);
          const paused = (await activeSlaRows(ctx.tx, t.id)).some((r) => r.state === 'paused');
          lines.push(`${t.number} ${t.type === 'change' ? 'moves to' : 'returns to'} ${next.label}${paused ? ' and the clocks resume' : ''}`);
        }
      } else {
        const outcome = afterRejection(t.type, settings);
        if (outcome === 'rejected') lines.push(`${t.number} ends as Rejected${input.comment ? ' with the note posted to the requester' : ''}`);
        else {
          const back = await statusByKey(ctx, outcome === 'return' ? REJECTED_RETURN_KEY[t.type]! : REOPEN_KEY[t.type], t.type);
          lines.push(outcome === 'return' ? `${t.number} returns to ${back.label} with the note posted${input.comment ? '' : ' (no note given)'}` : `${t.number} returns to ${back.label} with the note posted to the requester`);
        }
      }
      return { text: `${input.decision === 'approved' ? 'Approve' : 'Reject'} the approval on ${short(t)}`, lines };
    },
  }),
];

async function workflowByName(ctx: Ctx, name?: string | null) {
  const r = name?.trim();
  if (!r) return null;
  const rows = await ctx.tx.select({ id: schema.approvalWorkflows.id, name: schema.approvalWorkflows.name }).from(schema.approvalWorkflows).where(and(eq(schema.approvalWorkflows.isActive, true), ilike(schema.approvalWorkflows.name, `%${r.replace(/[%_]/g, (m) => `\\${m}`)}%`))).limit(5);
  const exact = rows.filter((w) => w.name.toLowerCase() === r.toLowerCase());
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length === 1) return pick[0]!;
  if (!pick.length) throw new ValidationError(`No approval workflow matching "${r}"`);
  throw new ValidationError(`Workflow "${r}" is ambiguous: ${pick.map((w) => w.name).join(', ')}`);
}
