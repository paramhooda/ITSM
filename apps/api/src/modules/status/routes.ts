import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as S from './schemas';

const idParam = z.object({ id: z.string().uuid() });
const tokenParam = z.object({ token: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/) });
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

/**
 * Announcements (staff), the portal status page, the public status page
 * tokens per customer and the public, token-only page itself.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['status'];
  const signedIn = app.auth();
  const manage = app.auth('announcements:manage');
  const customers = app.auth('customers:manage');

  // ---- announcements
  r.get('/announcements/active', { preHandler: signedIn, schema: { tags } }, h((ctx) => svc.activeAnnouncements(ctx)));
  r.get('/announcements', { preHandler: manage, schema: { tags, querystring: S.announcementListSchema } }, h((ctx, req) => svc.listAnnouncements(ctx, req.query as S.AnnouncementListQuery)));
  r.get('/announcements/:id', { preHandler: manage, schema: { tags, params: idParam } }, h((ctx, req) => svc.getAnnouncement(ctx, idOf(req))));
  r.post('/announcements', { preHandler: manage, schema: { tags, body: S.announcementBodySchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createAnnouncement(ctx, req.body as S.AnnouncementBody);
  }));
  r.patch('/announcements/:id', { preHandler: manage, schema: { tags, params: idParam, body: S.announcementPatchSchema } }, h((ctx, req) => svc.updateAnnouncement(ctx, idOf(req), req.body as S.AnnouncementPatch)));
  r.delete('/announcements/:id', { preHandler: manage, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteAnnouncement(ctx, idOf(req))));

  // ---- the portal status page (customer users; staff with tenant:all preview a customer with ?customerId=)
  r.get('/portal/status', { preHandler: app.auth('portal:status', 'tenant:all'), schema: { tags, querystring: S.customerQuerySchema } }, h((ctx, req) => svc.portalStatus(ctx, (req.query as { customerId?: string }).customerId)));

  // ---- public status page tokens
  r.get('/customers/:id/status-tokens', { preHandler: customers, schema: { tags, params: idParam } }, h((ctx, req) => svc.listTokens(ctx, idOf(req))));
  r.post('/status-tokens', { preHandler: customers, schema: { tags, body: S.tokenBodySchema } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createToken(ctx, req.body as S.TokenBody);
  }));
  r.post('/status-tokens/:id/revoke', { preHandler: customers, schema: { tags, params: idParam } }, h((ctx, req) => svc.revokeToken(ctx, idOf(req))));
  r.delete('/status-tokens/:id', { preHandler: customers, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteToken(ctx, idOf(req))));

  // ---- the public page: no sign-in, the token is the only credential, aggregate words only.
  await app.register(async (pub) => {
    pub.get('/public/status/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags, params: tokenParam, hide: true } }, async (req, reply) => {
      const data = await svc.publicStatus((req.params as { token: string }).token);
      reply.header('cache-control', 'no-store');
      if (!data) return reply.code(404).send({ error: 'not_found', message: 'This status page link is not valid.' });
      return data;
    });
  });
}
