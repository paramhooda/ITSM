import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { TICKET_TYPES } from '@itsm/shared';
import { h } from '@/core/context';
import { slaSummary } from '@/modules/sla/engine';
import * as svc from './service';
import * as act from './activity';
import * as list from './list';
import * as views from './views';
import * as approvals from './approvals';
import { scopePreview } from './scope';
import { loadTicket, loadTicketByNumber } from './common';
import * as S from './schemas';

const idParam = z.object({ id: z.string().uuid() });
const subParam = (name: string) => idParam.extend({ [name]: z.string().uuid() });

/**
 * Tickets module: incidents, service requests, problems and changes with the
 * shared behaviour (comments, timeline, links, SLAs, tasks, time, watchers,
 * approvals). Portal users reach the same handlers: service functions enforce
 * the customer-user restrictions.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.auth('tickets:read', 'portal:tickets');
  const tags = ['tickets'];

  // ---- collection
  r.get('/tickets', { preHandler: read, schema: { tags, querystring: S.listQuerySchema } }, h((ctx, req) => list.listTickets(ctx, req.query as S.ListQuery)));
  r.get('/tickets/stats', { preHandler: read, schema: { tags, querystring: S.statsQuerySchema } }, h((ctx, req) => list.ticketStats(ctx, req.query as z.infer<typeof S.statsQuerySchema>)));
  r.get('/tickets/lookup', { preHandler: read, schema: { tags, querystring: z.object({ q: z.string().max(100), customerId: z.string().uuid().optional(), excludeId: z.string().uuid().optional() }) } }, h((ctx, req) => {
    const q = req.query as { q: string; customerId?: string; excludeId?: string };
    return act.lookupTickets(ctx, q.q, q.customerId, q.excludeId);
  }));
  r.get('/tickets/problem-candidates', { preHandler: app.auth('tickets:read'), schema: { tags, querystring: z.object({ customerId: z.string().uuid().optional(), days: z.coerce.number().int().min(1).max(365).optional(), minCount: z.coerce.number().int().min(2).max(100).optional() }) } }, h((ctx, req) => list.problemCandidates(ctx, req.query as { customerId?: string; days?: number; minCount?: number })));
  r.post('/tickets/scope-preview', { preHandler: app.auth('tickets:create', 'tickets:read', 'portal:tickets'), schema: { tags, body: S.scopePreviewSchema } }, h((ctx, req) => scopePreview(ctx, req.body as z.infer<typeof S.scopePreviewSchema>)));
  r.post('/tickets/bulk', { preHandler: app.auth('tickets:update', 'tickets:assign', 'tickets:resolve'), schema: { tags, body: S.bulkSchema } }, h((ctx, req) => svc.bulkAction(ctx, req.body as z.infer<typeof S.bulkSchema>)));
  r.post('/tickets', { preHandler: app.auth('tickets:create', 'portal:tickets'), schema: { tags, body: S.createTicketSchema } }, h(async (ctx, req, reply) => {
    const ticket = await svc.createTicket(ctx, req.body as S.CreateTicketInput);
    reply.status(201);
    return svc.getTicket(ctx, ticket.id);
  }));

  // ---- single ticket
  r.get('/tickets/by-number/:number', { preHandler: read, schema: { tags, params: z.object({ number: z.string().max(40) }) } }, h(async (ctx, req) => {
    const t = await loadTicketByNumber(ctx, (req.params as { number: string }).number);
    return svc.getTicket(ctx, t.id);
  }));
  r.get('/tickets/:id', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => svc.getTicket(ctx, (req.params as { id: string }).id)));
  r.patch('/tickets/:id', { preHandler: app.auth('tickets:update'), schema: { tags, params: idParam, body: S.updateTicketSchema } }, h(async (ctx, req) => {
    await svc.updateTicket(ctx, (req.params as { id: string }).id, req.body as S.UpdateTicketInput);
    return svc.getTicket(ctx, (req.params as { id: string }).id);
  }));

  // ---- status & workflow actions
  const after = (fn: (ctx: Parameters<Parameters<typeof h>[0]>[0], id: string, body: never) => Promise<unknown>) =>
    h(async (ctx, req) => {
      const id = (req.params as { id: string }).id;
      await fn(ctx, id, req.body as never);
      return svc.getTicket(ctx, id);
    });
  r.post('/tickets/:id/status', { preHandler: app.auth('tickets:update', 'tickets:resolve', 'portal:tickets'), schema: { tags, params: idParam, body: S.statusChangeSchema } }, after((ctx, id, body) => svc.changeStatus(ctx, id, body)));
  r.post('/tickets/:id/resolve', { preHandler: app.auth('tickets:resolve'), schema: { tags, params: idParam, body: S.resolveSchema } }, after((ctx, id, body) => svc.resolveTicket(ctx, id, body)));
  r.post('/tickets/:id/close', { preHandler: app.auth('tickets:resolve'), schema: { tags, params: idParam, body: S.closeSchema } }, after((ctx, id, body) => svc.closeTicket(ctx, id, body)));
  r.post('/tickets/:id/reopen', { preHandler: app.auth('tickets:resolve', 'tickets:update', 'portal:tickets'), schema: { tags, params: idParam, body: S.reopenSchema } }, after((ctx, id, body) => svc.reopenTicket(ctx, id, body)));
  r.post('/tickets/:id/cancel', { preHandler: app.auth('tickets:resolve', 'portal:tickets'), schema: { tags, params: idParam, body: S.cancelSchema } }, after((ctx, id, body) => svc.cancelTicket(ctx, id, body)));
  r.post('/tickets/:id/assign', { preHandler: app.auth('tickets:assign'), schema: { tags, params: idParam, body: S.assignSchema } }, after((ctx, id, body) => svc.assignTicket(ctx, id, body)));
  r.post('/tickets/:id/escalate', { preHandler: app.auth('tickets:escalate'), schema: { tags, params: idParam, body: S.escalateSchema } }, after((ctx, id, body) => svc.escalateTicket(ctx, id, body)));
  r.post('/tickets/:id/scope', { preHandler: app.auth('tickets:scope'), schema: { tags, params: idParam, body: S.scopeOverrideSchema } }, after((ctx, id, body) => svc.setScope(ctx, id, body)));
  r.patch('/tickets/:id/problem', { preHandler: app.auth('problems:manage'), schema: { tags, params: idParam, body: S.problemDetailsSchema } }, h((ctx, req) => svc.updateProblemDetails(ctx, (req.params as { id: string }).id, req.body as S.ProblemDetailsInput)));
  r.patch('/tickets/:id/change', { preHandler: app.auth('changes:manage'), schema: { tags, params: idParam, body: S.changeDetailsSchema } }, h((ctx, req) => svc.updateChangeDetails(ctx, (req.params as { id: string }).id, req.body as S.ChangeDetailsInput)));

  // ---- SLA
  r.get('/tickets/:id/slas', { preHandler: read, schema: { tags, params: idParam } }, h(async (ctx, req) => {
    const t = await loadTicket(ctx, (req.params as { id: string }).id);
    return { items: await slaSummary(ctx.tx, t.id) };
  }));

  // ---- comments & timeline
  r.get('/tickets/:id/timeline', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => act.timeline(ctx, (req.params as { id: string }).id)));
  r.get('/tickets/:id/comments', { preHandler: read, schema: { tags, params: idParam } }, h(async (ctx, req) => ({ items: await act.listComments(ctx, (req.params as { id: string }).id) })));
  r.post('/tickets/:id/comments', { preHandler: app.auth('tickets:comment', 'tickets:work_notes', 'portal:tickets'), schema: { tags, params: idParam, body: S.commentSchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return act.addComment(ctx, (req.params as { id: string }).id, req.body as act.CommentInput);
  }));
  r.patch('/tickets/:id/comments/:commentId', { preHandler: app.auth('tickets:comment', 'tickets:work_notes', 'portal:tickets'), schema: { tags, params: subParam('commentId'), body: S.commentEditSchema } }, h((ctx, req) => {
    const p = req.params as { id: string; commentId: string };
    return act.editComment(ctx, p.id, p.commentId, (req.body as { body: string }).body);
  }));

  // ---- links
  r.post('/tickets/:id/links', { preHandler: app.auth('tickets:update'), schema: { tags, params: idParam, body: S.linkSchema } }, after((ctx, id, body) => act.addLink(ctx, id, body)));
  r.delete('/tickets/:id/links/:linkId', { preHandler: app.auth('tickets:update'), schema: { tags, params: subParam('linkId') } }, h(async (ctx, req) => {
    const p = req.params as { id: string; linkId: string };
    await act.removeLink(ctx, p.id, p.linkId);
    return svc.getTicket(ctx, p.id);
  }));

  // ---- affected CIs / assets
  r.put('/tickets/:id/cis', { preHandler: app.auth('tickets:update'), schema: { tags, params: idParam, body: S.idsSchema } }, h(async (ctx, req) => ({ items: await act.setCis(ctx, (req.params as { id: string }).id, (req.body as { ids: string[] }).ids) })));
  r.put('/tickets/:id/assets', { preHandler: app.auth('tickets:update'), schema: { tags, params: idParam, body: S.idsSchema } }, h(async (ctx, req) => ({ items: await act.setAssets(ctx, (req.params as { id: string }).id, (req.body as { ids: string[] }).ids) })));

  // ---- tasks
  r.get('/tickets/:id/tasks', { preHandler: read, schema: { tags, params: idParam } }, h(async (ctx, req) => ({ items: await act.listTasks(ctx, (req.params as { id: string }).id) })));
  r.post('/tickets/:id/tasks', { preHandler: app.auth('tickets:update'), schema: { tags, params: idParam, body: S.taskSchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return act.createTask(ctx, (req.params as { id: string }).id, req.body as act.TaskInput);
  }));
  r.patch('/tickets/:id/tasks/:taskId', { preHandler: app.auth('tickets:update'), schema: { tags, params: subParam('taskId'), body: S.taskPatchSchema } }, h((ctx, req) => {
    const p = req.params as { id: string; taskId: string };
    return act.updateTask(ctx, p.id, p.taskId, req.body as Partial<act.TaskInput>);
  }));
  r.delete('/tickets/:id/tasks/:taskId', { preHandler: app.auth('tickets:update'), schema: { tags, params: subParam('taskId') } }, h((ctx, req) => {
    const p = req.params as { id: string; taskId: string };
    return act.deleteTask(ctx, p.id, p.taskId);
  }));

  // ---- time entries
  r.get('/tickets/:id/time', { preHandler: app.auth('tickets:read'), schema: { tags, params: idParam } }, h((ctx, req) => act.listTimeEntries(ctx, (req.params as { id: string }).id)));
  r.post('/tickets/:id/time', { preHandler: app.auth('tickets:time'), schema: { tags, params: idParam, body: S.timeEntrySchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return act.addTimeEntry(ctx, (req.params as { id: string }).id, req.body as act.TimeEntryInput);
  }));
  r.delete('/tickets/:id/time/:entryId', { preHandler: app.auth('tickets:time'), schema: { tags, params: subParam('entryId') } }, h((ctx, req) => {
    const p = req.params as { id: string; entryId: string };
    return act.deleteTimeEntry(ctx, p.id, p.entryId);
  }));

  // ---- watchers
  r.post('/tickets/:id/watchers', { preHandler: read, schema: { tags, params: idParam, body: S.watcherSchema } }, h((ctx, req) => act.addWatcher(ctx, (req.params as { id: string }).id, (req.body as { userId?: string }).userId)));
  r.delete('/tickets/:id/watchers/:userId', { preHandler: read, schema: { tags, params: subParam('userId') } }, h((ctx, req) => {
    const p = req.params as { id: string; userId: string };
    return act.removeWatcher(ctx, p.id, p.userId);
  }));
  r.delete('/tickets/:id/watchers', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => act.removeWatcher(ctx, (req.params as { id: string }).id)));

  // ---- approvals
  r.get('/approvals/mine', { preHandler: app.auth('requests:approve', 'changes:approve', 'portal:approve', 'tickets:read'), schema: { tags: ['approvals'] } }, h((ctx) => approvals.listMine(ctx)));
  r.get('/tickets/:id/approvals', { preHandler: read, schema: { tags: ['approvals'], params: idParam } }, h((ctx, req) => approvals.listForTicket(ctx, (req.params as { id: string }).id)));
  r.post('/tickets/:id/approvals/:approvalId/decide', { preHandler: app.auth('requests:approve', 'changes:approve', 'portal:approve'), schema: { tags: ['approvals'], params: subParam('approvalId'), body: S.decideSchema } }, h((ctx, req) => {
    const p = req.params as { id: string; approvalId: string };
    const b = req.body as { decision: 'approved' | 'rejected'; comment?: string | null };
    return approvals.decide(ctx, p.id, p.approvalId, b.decision, b.comment);
  }));
  r.post('/tickets/:id/request-approval', { preHandler: app.auth('changes:manage', 'tickets:update'), schema: { tags: ['approvals'], params: idParam, body: S.requestApprovalSchema } }, h((ctx, req) => approvals.requestApproval(ctx, (req.params as { id: string }).id, (req.body as { approvalWorkflowId?: string | null }).approvalWorkflowId)));

  // ---- similar
  r.get('/tickets/:id/similar', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => list.similarTickets(ctx, (req.params as { id: string }).id)));

  // ---- saved views
  r.get('/saved-views', { preHandler: app.auth(), schema: { tags: ['saved-views'], querystring: z.object({ entity: z.string().max(40).optional() }) } }, h((ctx, req) => views.listViews(ctx, (req.query as { entity?: string }).entity ?? 'ticket')));
  r.post('/saved-views', { preHandler: app.auth(), schema: { tags: ['saved-views'], body: S.savedViewSchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return views.createView(ctx, req.body as S.SavedViewInput);
  }));
  r.patch('/saved-views/:id', { preHandler: app.auth(), schema: { tags: ['saved-views'], params: idParam, body: S.savedViewSchema.partial() } }, h((ctx, req) => views.updateView(ctx, (req.params as { id: string }).id, req.body as Partial<S.SavedViewInput>)));
  r.delete('/saved-views/:id', { preHandler: app.auth(), schema: { tags: ['saved-views'], params: idParam } }, h((ctx, req) => views.deleteView(ctx, (req.params as { id: string }).id)));

  // ---- type metadata (for pickers)
  r.get('/tickets/meta/types', { preHandler: app.auth(), schema: { tags } }, h(async () => ({ items: TICKET_TYPES.map((t) => ({ key: t })) })));
}
