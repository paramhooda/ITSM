import { z } from 'zod';
import { and, eq, ilike } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { listMine, listForTicket, decide, requestApproval } from '@/modules/tickets/approvals';
import { listPortalApprovals, decidePortalApproval } from '@/modules/portal/service';
import type { TicketRow } from '@/modules/tickets/common';
import { define } from './types';
import { ticketRef } from './core';
import { isCustomerUser, ticketLink, iso, trunc, resolveTicket } from '../helpers';

/** Approval tools: what waits for the user, starting a workflow, and deciding a step (staff and portal approvers alike). */

const short = (t: Pick<TicketRow, 'number' | 'title'>) => `${t.number} ("${t.title.slice(0, 80)}")`;

/** The pending step on a ticket the caller may decide (optionally a specific step number or name). */
async function pendingStep(ctx: Ctx, t: TicketRow, step?: string | number) {
  const items = isCustomerUser(ctx)
    ? (await listPortalApprovals(ctx)).items.filter((a) => a.ticket.id === t.id && a.status === 'pending').map((a) => ({ id: a.id, step: a.step, stepName: a.stepName }))
    : (await listForTicket(ctx, t.id)).items.filter((a) => a.status === 'pending' && a.canDecide).map((a) => ({ id: a.id, step: a.step, stepName: a.stepName }));
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

export const APPROVALS: ReturnType<typeof define>[] = [
  define({
    name: 'my_approvals',
    toolset: 'approvals',
    description: 'Requests and changes waiting for the user\'s approval decision (addressed to them, their role or their team).',
    inputSchema: z.object({ limit: z.number().int().min(1).max(30).optional() }),
    requires: ['tickets:read'],
    portal: ['portal:approve'],
    action: false,
    run: async (ctx, input) => {
      const limit = input.limit ?? 20;
      if (isCustomerUser(ctx)) {
        const res = await listPortalApprovals(ctx);
        return { total: res.total, facts: [`${res.total} approval(s) waiting for ${ctx.user.name}`], items: res.items.slice(0, limit).map((a) => ({ approvalId: a.id, step: a.step, stepName: a.stepName, waitingSince: iso(a.createdAt), ticket: { number: a.ticket.number, title: a.ticket.title, type: a.ticket.type, requester: a.ticket.requesterName, priority: a.ticket.priority?.label ?? null, status: a.ticket.status?.label ?? null, catalogItem: a.ticket.catalogItemName, description: trunc(a.ticket.description, 400), link: ticketLink(ctx, a.ticket.id) } })) };
      }
      const res = await listMine(ctx);
      return { total: res.total, facts: [`${res.total} approval(s) waiting for ${ctx.user.name}`], items: res.items.slice(0, limit).map((a) => ({ approvalId: a.id, step: a.step, stepName: a.stepName, waitingSince: iso(a.createdAt), ticket: { number: a.ticket.number, title: a.ticket.title, type: a.ticket.type, customer: a.ticket.customerName, requester: a.ticket.requesterName, priority: a.ticket.priority, status: a.ticket.status, createdAt: iso(a.ticket.createdAt), description: trunc(a.ticket.description, 400), link: ticketLink(ctx, a.ticket.id) } })) };
    },
    summary: (_i, result) => `Listed ${(result as { total: number }).total} pending approval(s)`,
  }),

  define({
    name: 'request_approval',
    toolset: 'approvals',
    description: 'Start an approval workflow on a request or change (the catalog item\'s workflow, or the one named).',
    inputSchema: z.object({ ticket: ticketRef, workflow: z.string().max(200).optional().describe('Workflow name, e.g. "CAB approval"') }),
    requires: ['tickets:update'],
    portal: null,
    action: true,
    invalidates: ['tickets', 'approvals'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const wf = await workflowByName(ctx, input.workflow);
      const res = await requestApproval(ctx, t.id, wf?.id ?? null);
      return { ticket: t.number, approvalStatus: res.ticket.approvalStatus, steps: res.items.map((a) => ({ step: a.step, name: a.stepName, status: a.status, approver: a.approverUser?.name ?? a.approverTeam?.name ?? a.approverRole?.name ?? null })), link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => `Started approval on ${input.ticket} (${(result as { steps: unknown[] }).steps.length} step(s))`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const wf = await workflowByName(ctx, input.workflow);
      return `Start the ${wf ? `"${wf.name}"` : 'default'} approval workflow on ${short(t)}; the approvers are notified`;
    },
  }),

  define({
    name: 'decide_approval',
    toolset: 'approvals',
    description: 'Approve or reject the approval step on a ticket that is waiting for the user. Only on explicit instruction naming the ticket and the decision.',
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
      return `${input.decision === 'approved' ? 'Approve' : 'Reject'} step ${step.step}${step.stepName ? ` "${step.stepName}"` : ''} of ${short(t)}${input.comment ? ` with the comment "${trunc(input.comment, 120)}"` : ''}`;
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
