import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as pub from './public';
import * as S from './schemas';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Customer satisfaction surveys: policies (surveys:manage or admin:config),
 * figures and responses (surveys:read; portal users get their own
 * organisation), the per-ticket survey, the manual send, and the public
 * token endpoints behind the email links (no sign-in, rate-limited per IP).
 * The portal rating and "to rate" routes live in the portal module.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['surveys'];
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;
  const manage = app.auth('surveys:manage', 'admin:config');

  r.get('/surveys/policy', { preHandler: app.auth('surveys:read', 'surveys:manage', 'admin:config'), schema: { tags, querystring: S.policyQuery } }, h((ctx, req) => svc.getPolicy(ctx, req.query as S.PolicyQuery)));
  r.get('/surveys/configs', { preHandler: manage, schema: { tags, querystring: S.configListQuery } }, h((ctx, req) => svc.listConfigs(ctx, req.query as { customerId?: string })));
  r.post('/surveys/configs', { preHandler: manage, schema: { tags, body: S.configInput } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createConfig(ctx, req.body as S.ConfigInput);
  }));
  r.patch('/surveys/configs/:id', { preHandler: manage, schema: { tags, params: idParam, body: S.configPatch } }, h((ctx, req) => svc.updateConfig(ctx, id(req), req.body as S.ConfigPatch)));
  r.delete('/surveys/configs/:id', { preHandler: manage, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteConfig(ctx, id(req))));

  r.get('/surveys/summary', { preHandler: app.auth('surveys:read', 'portal:access'), schema: { tags, querystring: S.summaryQuery } }, h((ctx, req) => svc.csatSummary(ctx, req.query as S.SummaryQuery)));
  r.get('/surveys/responses', { preHandler: app.auth('surveys:read', 'portal:access'), schema: { tags, querystring: S.responsesQuery } }, h((ctx, req) => svc.listResponses(ctx, req.query as S.ResponsesQuery)));
  r.get('/surveys/tickets/:id', { preHandler: app.auth('tickets:read', 'portal:tickets'), schema: { tags, params: idParam } }, h((ctx, req) => svc.ticketSurvey(ctx, id(req))));
  r.post('/surveys/tickets/:id/send', { preHandler: app.auth('surveys:manage'), schema: { tags, params: idParam } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.sendSurvey(ctx, id(req));
  }));

  // ---- the public page behind the email links: the token is the only credential; one 404 body for unknown, withdrawn and malformed tokens.
  const fail = (reply: FastifyReply, code: 'not_found' | 'gone' | 'conflict') => {
    if (code === 'gone') return reply.code(410).send({ error: 'gone', message: 'This survey has closed.' });
    if (code === 'conflict') return reply.code(409).send({ error: 'conflict', message: 'This ticket has already been rated.' });
    return reply.code(404).send({ error: 'not_found', message: 'This survey link is not valid.' });
  };
  await app.register(async (p) => {
    const limit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
    const token = (req: { params: unknown }) => (req.params as { token: string }).token;
    p.get('/public/surveys/:token', { config: limit, schema: { tags, params: S.tokenParam, hide: true } }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const data = await pub.publicSurvey(token(req));
      if (!data) return fail(reply, 'not_found');
      return data;
    });
    p.post('/public/surveys/:token/rating', { config: limit, schema: { tags, params: S.tokenParam, body: S.publicRatingBody, hide: true } }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const out = await pub.publicRate(token(req), (req.body as { rating: number }).rating);
      if (!out.ok) return fail(reply, out.code);
      return out.data;
    });
    p.post('/public/surveys/:token/comment', { config: limit, schema: { tags, params: S.tokenParam, body: S.publicCommentBody, hide: true } }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const out = await pub.publicComment(token(req), (req.body as { comment: string }).comment);
      if (!out.ok) return fail(reply, out.code);
      return out.data;
    });
  });
}
