import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as S from './schemas';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Known error database (staff). The entry is the problem record itself, so
 * `:id` is the problem ticket id. Reading needs kedb:read, editing the
 * known-error fields problems:manage, publishing to the portal kedb:publish.
 * The portal routes live in the portal module.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['known-errors'];
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  r.get('/known-errors', { preHandler: app.auth('kedb:read'), schema: { tags, querystring: S.listQuerySchema } }, h((ctx, req) => svc.listKnownErrors(ctx, req.query as S.ListQuery)));
  r.get('/known-errors/stats', { preHandler: app.auth('kedb:read'), schema: { tags, querystring: S.statsQuerySchema } }, h((ctx, req) => svc.knownErrorStats(ctx, (req.query as { customerId?: string }).customerId)));
  r.get('/known-errors/suggest', { preHandler: app.auth('kedb:read'), schema: { tags, querystring: S.suggestQuerySchema } }, h((ctx, req) => svc.suggestKnownErrors(ctx, req.query as S.SuggestQuery)));
  r.get('/known-errors/:id', { preHandler: app.auth('kedb:read', 'problems:manage'), schema: { tags, params: idParam } }, h((ctx, req) => svc.getKnownError(ctx, id(req))));
  r.patch('/known-errors/:id', { preHandler: app.auth('problems:manage'), schema: { tags, params: idParam, body: S.knownErrorPatchSchema } }, h((ctx, req) => svc.updateKnownError(ctx, id(req), req.body as S.KnownErrorPatch)));
  r.post('/known-errors/:id/status', { preHandler: app.auth('problems:manage'), schema: { tags, params: idParam, body: S.statusBodySchema } }, h((ctx, req) => svc.setKnownErrorStatus(ctx, id(req), (req.body as z.infer<typeof S.statusBodySchema>).status)));
  r.post('/known-errors/:id/publish', { preHandler: app.auth('kedb:publish'), schema: { tags, params: idParam, body: S.publishBodySchema } }, h((ctx, req) => svc.publishKnownError(ctx, id(req), req.body as S.PublishBody)));
  r.post('/known-errors/:id/unpublish', { preHandler: app.auth('kedb:publish'), schema: { tags, params: idParam } }, h((ctx, req) => svc.unpublishKnownError(ctx, id(req))));
}
