import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import { sourceCreateBody, sourcePatchBody, sourceListQuery, runsQuery, findingsQuery, bulkBody, type FindingsQuery } from './schemas';

const idParam = z.object({ id: z.string().uuid() });

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const run = app.auth('discovery:run', 'discovery:manage');
  const manage = app.auth('discovery:manage');

  r.get('/discovery/providers', { preHandler: run, schema: { tags: ['discovery'] } }, async () => ({ items: svc.providers() }));

  r.get('/discovery/sources', { preHandler: run, schema: { tags: ['discovery'], querystring: sourceListQuery } }, h((ctx, req) => svc.listSources(ctx, req.query as z.infer<typeof sourceListQuery>)));
  r.post('/discovery/sources', { preHandler: manage, schema: { tags: ['discovery'], body: sourceCreateBody } }, h((ctx, req) => svc.createSource(ctx, req.body as z.infer<typeof sourceCreateBody>)));
  r.get('/discovery/sources/:id', { preHandler: run, schema: { tags: ['discovery'], params: idParam } }, h((ctx, req) => svc.getSource(ctx, (req.params as { id: string }).id)));
  r.patch('/discovery/sources/:id', { preHandler: manage, schema: { tags: ['discovery'], params: idParam, body: sourcePatchBody } }, h((ctx, req) => svc.updateSource(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof sourcePatchBody>)));
  r.delete('/discovery/sources/:id', { preHandler: manage, schema: { tags: ['discovery'], params: idParam } }, h((ctx, req) => svc.deleteSource(ctx, (req.params as { id: string }).id)));
  r.post('/discovery/sources/:id/run', { preHandler: run, schema: { tags: ['discovery'], params: idParam } }, h((ctx, req) => svc.runSource(ctx, (req.params as { id: string }).id)));
  r.post('/discovery/sources/:id/test', { preHandler: run, schema: { tags: ['discovery'], params: idParam } }, h((ctx, req) => svc.testSource(ctx, (req.params as { id: string }).id)));
  r.get('/discovery/sources/:id/runs', { preHandler: run, schema: { tags: ['discovery'], params: idParam, querystring: runsQuery } }, h((ctx, req) => svc.listRuns(ctx, (req.params as { id: string }).id, req.query as z.infer<typeof runsQuery>)));
  r.get('/discovery/runs/:id', { preHandler: run, schema: { tags: ['discovery'], params: idParam } }, h((ctx, req) => svc.getRun(ctx, (req.params as { id: string }).id)));

  r.get('/discovery/findings', { preHandler: run, schema: { tags: ['discovery'], querystring: findingsQuery } }, h((ctx, req) => svc.listFindings(ctx, req.query as FindingsQuery)));
  r.post('/discovery/findings/bulk', { preHandler: run, schema: { tags: ['discovery'], body: bulkBody } }, h((ctx, req) => {
    const b = req.body as z.infer<typeof bulkBody>;
    return svc.bulkFindings(ctx, b.ids, b.action);
  }));
  r.post('/discovery/findings/:id/apply', { preHandler: run, schema: { tags: ['discovery'], params: idParam } }, h((ctx, req) => svc.applyFindingById(ctx, (req.params as { id: string }).id)));
  r.post('/discovery/findings/:id/ignore', { preHandler: run, schema: { tags: ['discovery'], params: idParam } }, h((ctx, req) => svc.ignoreFinding(ctx, (req.params as { id: string }).id)));
}
