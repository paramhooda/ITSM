import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as S from './schemas';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Preventive maintenance: programs generate occurrences on a cadence; each
 * occurrence is scheduled (optionally creating a field visit), completed,
 * rescheduled or cancelled. Customer users see their own customer's schedule.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['pm'];
  const read = app.auth('pm:read', 'pm:manage', 'portal:access');
  const manage = app.auth('pm:manage');
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  // ---- programs
  r.get('/pm/programs', { preHandler: read, schema: { tags, querystring: S.programListQuery } }, h((ctx, req) => svc.listPrograms(ctx, req.query as S.ProgramListQuery)));
  r.post('/pm/programs', { preHandler: manage, schema: { tags, body: S.createProgramSchema } }, h(async (ctx, req, reply) => {
    const p = await svc.createProgram(ctx, req.body as S.CreateProgramInput);
    reply.status(201);
    return svc.getProgram(ctx, p.id);
  }));
  r.get('/pm/programs/:id', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => svc.getProgram(ctx, id(req))));
  r.patch('/pm/programs/:id', { preHandler: manage, schema: { tags, params: idParam, body: S.updateProgramSchema } }, h(async (ctx, req) => {
    await svc.updateProgram(ctx, id(req), req.body as S.UpdateProgramInput);
    return svc.getProgram(ctx, id(req));
  }));
  r.post('/pm/programs/:id/regenerate', { preHandler: manage, schema: { tags, params: idParam } }, h(async (ctx, req) => ({ ...(await svc.regenerateProgram(ctx, id(req))), program: await svc.getProgram(ctx, id(req)) })));
  r.delete('/pm/programs/:id', { preHandler: manage, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteProgram(ctx, id(req))));

  // ---- occurrences
  r.get('/pm/occurrences', { preHandler: read, schema: { tags, querystring: S.occurrenceListQuery } }, h((ctx, req) => svc.listOccurrences(ctx, req.query as S.OccurrenceListQuery)));
  r.get('/pm/occurrences/:id', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => svc.getOccurrence(ctx, id(req))));
  r.post('/pm/occurrences/:id/schedule', { preHandler: manage, schema: { tags, params: idParam, body: S.scheduleOccurrenceSchema } }, h((ctx, req) => svc.scheduleOccurrence(ctx, id(req), req.body as S.ScheduleOccurrenceInput)));
  r.post('/pm/occurrences/:id/complete', { preHandler: app.auth('pm:manage', 'field:execute'), schema: { tags, params: idParam, body: S.completeOccurrenceSchema } }, h((ctx, req) => svc.completeOccurrence(ctx, id(req), req.body as S.CompleteOccurrenceInput)));
  r.post('/pm/occurrences/:id/reschedule', { preHandler: manage, schema: { tags, params: idParam, body: S.rescheduleOccurrenceSchema } }, h((ctx, req) => svc.rescheduleOccurrence(ctx, id(req), req.body as S.RescheduleOccurrenceInput)));
  r.post('/pm/occurrences/:id/cancel', { preHandler: manage, schema: { tags, params: idParam, body: S.cancelOccurrenceSchema } }, h((ctx, req) => svc.cancelOccurrence(ctx, id(req), req.body as { reason: string })));
  r.post('/pm/occurrences/:id/create-ticket', { preHandler: manage, schema: { tags, params: idParam, body: S.createTicketSchema } }, h((ctx, req) => svc.createOccurrenceTicket(ctx, id(req), req.body as S.CreateOccurrenceTicketInput)));

  // ---- summary / calendar
  r.get('/pm/summary', { preHandler: read, schema: { tags, querystring: S.pmSummaryQuery } }, h((ctx, req) => svc.pmSummary(ctx, req.query as S.PmSummaryQuery)));
  r.get('/pm/calendar', { preHandler: read, schema: { tags, querystring: S.pmCalendarQuery } }, h((ctx, req) => svc.pmCalendar(ctx, req.query as S.PmCalendarQuery)));
}
