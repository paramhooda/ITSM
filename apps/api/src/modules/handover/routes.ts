import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import { UnauthorizedError } from '@/core/errors';
import { stepsFor } from '@/modules/ai/service';
import * as svc from './service';

const tags = ['handover'];
const idParam = z.object({ id: z.string().uuid() });
const teamQuery = z.object({ teamId: z.string().uuid().optional() });
const teamRequired = z.object({ teamId: z.string().uuid() });
const id = (req: { params: unknown }) => (req.params as { id: string }).id;
/** The draft calls the model, so it runs as separate short transactions rather than inside h(). */
const steps = (req: FastifyRequest) => {
  if (!req.principal) throw new UnauthorizedError();
  return stepsFor(req.principal, { requestId: req.id, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined });
};

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---- teams, shifts and the live digest
  r.get('/handover/teams', { preHandler: app.auth('tickets:read'), schema: { tags } }, h((ctx) => svc.listTeams(ctx)));
  r.get('/handover/shifts', { preHandler: app.auth('tickets:read'), schema: { tags, querystring: teamQuery } }, h((ctx, req) => svc.listShifts(ctx, (req.query as z.infer<typeof teamQuery>).teamId)));
  r.post('/handover/shifts', { preHandler: app.auth('oncall:manage'), schema: { tags, body: svc.shiftInput } }, h((ctx, req) => svc.createShift(ctx, req.body as z.infer<typeof svc.shiftInput>)));
  r.patch('/handover/shifts/:id', { preHandler: app.auth('oncall:manage'), schema: { tags, params: idParam, body: svc.shiftPatch } }, h((ctx, req) => svc.updateShift(ctx, id(req), req.body as z.infer<typeof svc.shiftPatch>)));
  r.delete('/handover/shifts/:id', { preHandler: app.auth('oncall:manage'), schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteShift(ctx, id(req))));
  r.get('/handover/digest', { preHandler: app.auth('tickets:read'), schema: { tags, querystring: teamRequired } }, h((ctx, req) => svc.digest(ctx, (req.query as z.infer<typeof teamRequired>).teamId)));
  r.post('/handover/draft', { preHandler: app.auth('handover:write'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags, body: svc.draftInput } }, async (req) => svc.draft(steps(req), req.body as z.infer<typeof svc.draftInput>));

  // ---- handovers
  r.get('/handover', { preHandler: app.auth('tickets:read'), schema: { tags, querystring: svc.listQuerySchema } }, h((ctx, req) => svc.list(ctx, req.query as z.infer<typeof svc.listQuerySchema>)));
  r.post('/handover', { preHandler: app.auth('handover:write'), schema: { tags, body: svc.handoverInput } }, h((ctx, req) => svc.create(ctx, req.body as z.infer<typeof svc.handoverInput>)));
  r.get('/handover/:id', { preHandler: app.auth('tickets:read'), schema: { tags, params: idParam } }, h((ctx, req) => svc.get(ctx, id(req))));
  r.patch('/handover/:id', { preHandler: app.auth('handover:write'), schema: { tags, params: idParam, body: svc.handoverPatch } }, h((ctx, req) => svc.update(ctx, id(req), req.body as z.infer<typeof svc.handoverPatch>)));
  r.post('/handover/:id/publish', { preHandler: app.auth('handover:write'), schema: { tags, params: idParam } }, h((ctx, req) => svc.publish(ctx, id(req))));
  r.post('/handover/:id/acknowledge', { preHandler: app.auth('handover:write'), schema: { tags, params: idParam, body: z.object({ note: z.string().max(2000).nullable().optional() }).default({}) } }, h((ctx, req) => svc.acknowledge(ctx, id(req), (req.body as { note?: string | null }).note)));
  r.delete('/handover/:id', { preHandler: app.auth('handover:write'), schema: { tags, params: idParam } }, h((ctx, req) => svc.remove(ctx, id(req))));
}
