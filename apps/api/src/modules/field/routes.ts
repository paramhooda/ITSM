import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import { visitReportHtml, generateVisitReport } from './report';
import * as S from './schemas';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Field service module: site visits with scheduling, execution (parts, notes,
 * checklist), entitlement consumption, customer acknowledgement and printable
 * reports. Customer (portal) users reach the read endpoints, notes and the
 * acknowledgement for their own customer; services enforce the restrictions.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['field'];
  const read = app.auth('field:read', 'field:manage', 'portal:access');
  const manage = app.auth('field:manage');
  const execute = app.auth('field:execute', 'field:manage');
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;
  const after = (fn: (ctx: Parameters<Parameters<typeof h>[0]>[0], id: string, body: never) => Promise<unknown>) =>
    h(async (ctx, req) => {
      await fn(ctx, id(req), req.body as never);
      return svc.getVisit(ctx, id(req));
    });

  // ---- collection
  r.get('/field/visits', { preHandler: read, schema: { tags, querystring: S.visitListQuery } }, h((ctx, req) => svc.listVisits(ctx, req.query as S.VisitListQuery)));
  r.get('/field/visits/calendar', { preHandler: read, schema: { tags, querystring: S.calendarQuery } }, h((ctx, req) => svc.calendarVisits(ctx, req.query as S.CalendarQuery)));
  r.get('/field/summary', { preHandler: read, schema: { tags, querystring: S.summaryQuery } }, h((ctx, req) => svc.visitSummary(ctx, req.query as S.SummaryQuery)));
  r.get('/field/engineers/workload', { preHandler: app.auth('field:read', 'field:manage'), schema: { tags, querystring: S.workloadQuery } }, h((ctx, req) => svc.engineerWorkload(ctx, req.query as S.WorkloadQuery)));
  r.post('/field/visits', { preHandler: manage, schema: { tags, body: S.createVisitSchema } }, h(async (ctx, req, reply) => {
    const v = await svc.createVisit(ctx, req.body as S.CreateVisitInput);
    reply.status(201);
    return svc.getVisit(ctx, v.id);
  }));

  // ---- single visit
  r.get('/field/visits/:id', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => svc.getVisit(ctx, id(req))));
  r.patch('/field/visits/:id', { preHandler: manage, schema: { tags, params: idParam, body: S.updateVisitSchema } }, after((ctx, vid, body) => svc.updateVisit(ctx, vid, body)));
  r.post('/field/visits/:id/schedule', { preHandler: manage, schema: { tags, params: idParam, body: S.scheduleVisitSchema } }, after((ctx, vid, body) => svc.scheduleVisit(ctx, vid, body)));
  r.post('/field/visits/:id/start', { preHandler: execute, schema: { tags, params: idParam, body: S.startVisitSchema } }, after((ctx, vid, body) => svc.startVisit(ctx, vid, body)));
  r.post('/field/visits/:id/complete', { preHandler: execute, schema: { tags, params: idParam, body: S.completeVisitSchema } }, after((ctx, vid, body) => svc.completeVisit(ctx, vid, body)));
  r.post('/field/visits/:id/cancel', { preHandler: manage, schema: { tags, params: idParam, body: S.cancelVisitSchema } }, after((ctx, vid, body) => svc.cancelVisit(ctx, vid, body)));
  r.post('/field/visits/:id/reschedule', { preHandler: manage, schema: { tags, params: idParam, body: S.rescheduleVisitSchema } }, after((ctx, vid, body) => svc.rescheduleVisit(ctx, vid, body)));
  r.post('/field/visits/:id/acknowledge', { preHandler: app.auth('field:execute', 'field:manage', 'portal:access'), schema: { tags, params: idParam, body: S.acknowledgeVisitSchema } }, after((ctx, vid, body) => svc.acknowledgeVisit(ctx, vid, body)));

  // ---- parts
  r.get('/field/visits/:id/parts', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => svc.listParts(ctx, id(req))));
  r.post('/field/visits/:id/parts', { preHandler: execute, schema: { tags, params: idParam, body: S.partSchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.addPart(ctx, id(req), req.body as S.PartInput);
  }));
  r.patch('/field/parts/:id', { preHandler: execute, schema: { tags, params: idParam, body: S.partPatchSchema } }, h((ctx, req) => svc.updatePart(ctx, id(req), req.body as Partial<S.PartInput>)));
  r.delete('/field/parts/:id', { preHandler: execute, schema: { tags, params: idParam } }, h((ctx, req) => svc.deletePart(ctx, id(req))));

  // ---- notes
  r.get('/field/visits/:id/notes', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => svc.listNotes(ctx, id(req))));
  r.post('/field/visits/:id/notes', { preHandler: app.auth('field:execute', 'field:manage', 'portal:access'), schema: { tags, params: idParam, body: S.noteSchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.addNote(ctx, id(req), req.body as S.NoteInput);
  }));

  // ---- report
  r.get('/field/visits/:id/report.html', { preHandler: read, schema: { tags, params: idParam } }, h(async (ctx, req, reply) => {
    const html = await visitReportHtml(ctx, id(req));
    reply.type('text/html; charset=utf-8');
    return html;
  }));
  r.post('/field/visits/:id/report', { preHandler: execute, schema: { tags, params: idParam } }, h(async (ctx, req) => {
    const result = await generateVisitReport(ctx, id(req));
    return { ...result, visit: await svc.getVisit(ctx, id(req)) };
  }));
}
