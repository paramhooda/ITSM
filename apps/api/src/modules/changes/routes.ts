import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as S from './schemas';

const idParam = z.object({ id: z.string().uuid() });
const itemParam = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const blackoutsQuery = z.object({ customerId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), all: z.coerce.boolean().optional() });
const allQuery = z.object({ all: z.coerce.boolean().optional() });
const closeBody = z.object({ minutes: z.string().trim().max(20000).nullable().optional() });

/**
 * Change management: the calendar and conflict preview, the risk
 * questionnaire, blackout windows, standard change templates and CAB meetings.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['changes'];
  const read = app.auth('tickets:read');
  const assess = app.auth('tickets:update', 'changes:manage');
  const config = app.auth('admin:config');
  const cabRead = app.auth('changes:cab', 'changes:approve', 'changes:manage');
  const cab = app.auth('changes:cab');

  // ---- calendar, conflicts, risk
  r.get('/changes/calendar', { preHandler: read, schema: { tags, querystring: S.calendarQuerySchema } }, h((ctx, req) => svc.calendar(ctx, req.query as S.CalendarQuery)));
  r.post('/changes/conflicts', { preHandler: read, schema: { tags, body: S.conflictPreviewSchema } }, h((ctx, req) => svc.previewConflicts(ctx, req.body as S.ConflictPreview)));
  r.get('/changes/:id/conflicts', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => svc.detectConflicts(ctx, idOf(req))));
  r.get('/changes/risk-questionnaire', { preHandler: read, schema: { tags } }, h((ctx) => svc.riskQuestionnaire(ctx)));
  r.put('/changes/risk-thresholds', { preHandler: config, schema: { tags, body: S.thresholdsBodySchema } }, h((ctx, req) => svc.updateRiskThresholds(ctx, req.body as S.ThresholdsBody)));
  // The raiser or the assignee may answer the questionnaire (tickets:update); a change manager may assess any change. The service checks the rest.
  r.post('/changes/:id/assess-risk', { preHandler: assess, schema: { tags, params: idParam, body: S.assessBodySchema } }, h((ctx, req) => svc.assessRisk(ctx, idOf(req), (req.body as { answers: S.RiskAnswers }).answers)));

  // ---- blackout windows (read by staff, written by configuration admins)
  r.get('/changes/blackouts', { preHandler: read, schema: { tags, querystring: blackoutsQuery } }, h((ctx, req) => svc.listBlackouts(ctx, req.query as z.infer<typeof blackoutsQuery>)));
  r.post('/changes/blackouts', { preHandler: config, schema: { tags, body: S.blackoutBodySchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createBlackout(ctx, req.body as S.BlackoutBody);
  }));
  r.patch('/changes/blackouts/:id', { preHandler: config, schema: { tags, params: idParam, body: S.blackoutPatchSchema } }, h((ctx, req) => svc.updateBlackout(ctx, idOf(req), req.body as S.BlackoutPatch)));
  r.delete('/changes/blackouts/:id', { preHandler: config, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteBlackout(ctx, idOf(req))));

  // ---- risk questions (reorder is registered before the :id routes)
  r.get('/changes/risk-questions', { preHandler: read, schema: { tags, querystring: allQuery } }, h((ctx, req) => svc.listRiskQuestions(ctx, !!(req.query as { all?: boolean }).all)));
  r.post('/changes/risk-questions/reorder', { preHandler: config, schema: { tags, body: S.reorderSchema } }, h((ctx, req) => svc.reorderRiskQuestions(ctx, (req.body as { ids: string[] }).ids)));
  r.post('/changes/risk-questions', { preHandler: config, schema: { tags, body: S.riskQuestionBodySchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createRiskQuestion(ctx, req.body as S.RiskQuestionBody);
  }));
  r.patch('/changes/risk-questions/:id', { preHandler: config, schema: { tags, params: idParam, body: S.riskQuestionPatchSchema } }, h((ctx, req) => svc.updateRiskQuestion(ctx, idOf(req), req.body as S.RiskQuestionPatch)));
  r.delete('/changes/risk-questions/:id', { preHandler: config, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteRiskQuestion(ctx, idOf(req))));

  // ---- standard change templates
  r.get('/changes/templates', { preHandler: read, schema: { tags, querystring: S.templatesQuerySchema } }, h((ctx, req) => svc.listTemplates(ctx, req.query as S.TemplatesQuery)));
  r.post('/changes/templates', { preHandler: config, schema: { tags, body: S.templateBodySchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createTemplate(ctx, req.body as S.TemplateBody);
  }));
  r.patch('/changes/templates/:id', { preHandler: config, schema: { tags, params: idParam, body: S.templatePatchSchema } }, h((ctx, req) => svc.updateTemplate(ctx, idOf(req), req.body as S.TemplatePatch)));
  r.delete('/changes/templates/:id', { preHandler: config, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteTemplate(ctx, idOf(req))));

  // ---- CAB meetings (the queue and the reorder routes sit before their parameterised siblings)
  r.get('/cab/queue', { preHandler: cabRead, schema: { tags, querystring: S.cabQueueSchema } }, h((ctx, req) => svc.cabQueue(ctx, req.query as S.CabQueueQuery)));
  r.get('/cab/meetings', { preHandler: cabRead, schema: { tags, querystring: S.cabListSchema } }, h((ctx, req) => svc.listMeetings(ctx, req.query as S.CabListQuery)));
  r.post('/cab/meetings', { preHandler: cab, schema: { tags, body: S.cabMeetingBodySchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createMeeting(ctx, req.body as S.CabMeetingBody);
  }));
  r.get('/cab/meetings/:id', { preHandler: cabRead, schema: { tags, params: idParam } }, h((ctx, req) => svc.getMeeting(ctx, idOf(req))));
  r.patch('/cab/meetings/:id', { preHandler: cab, schema: { tags, params: idParam, body: S.cabMeetingPatchSchema } }, h((ctx, req) => svc.updateMeeting(ctx, idOf(req), req.body as S.CabMeetingPatch)));
  r.post('/cab/meetings/:id/items', { preHandler: cab, schema: { tags, params: idParam, body: S.cabItemBodySchema } }, h((ctx, req) => svc.addItem(ctx, idOf(req), req.body as S.CabItemBody)));
  r.post('/cab/meetings/:id/items/reorder', { preHandler: cab, schema: { tags, params: idParam, body: S.cabReorderSchema } }, h((ctx, req) => svc.reorderItems(ctx, idOf(req), (req.body as S.CabReorder).itemIds)));
  r.patch('/cab/meetings/:id/items/:itemId', { preHandler: cab, schema: { tags, params: itemParam, body: S.cabItemPatchSchema } }, h((ctx, req) => svc.updateItem(ctx, idOf(req), (req.params as { itemId: string }).itemId, req.body as S.CabItemPatch)));
  r.delete('/cab/meetings/:id/items/:itemId', { preHandler: cab, schema: { tags, params: itemParam } }, h((ctx, req) => svc.removeItem(ctx, idOf(req), (req.params as { itemId: string }).itemId)));
  r.post('/cab/meetings/:id/items/:itemId/decide', { preHandler: cab, schema: { tags, params: itemParam, body: S.cabDecideSchema } }, h((ctx, req) => svc.decideItem(ctx, idOf(req), (req.params as { itemId: string }).itemId, req.body as S.CabDecideBody)));
  r.post('/cab/meetings/:id/close', { preHandler: cab, schema: { tags, params: idParam, body: closeBody } }, h((ctx, req) => svc.closeMeeting(ctx, idOf(req), req.body as z.infer<typeof closeBody>)));
  r.post('/cab/meetings/:id/cancel', { preHandler: cab, schema: { tags, params: idParam, body: S.cabCancelSchema } }, h((ctx, req) => svc.cancelMeeting(ctx, idOf(req), req.body as S.CabCancel)));
}
