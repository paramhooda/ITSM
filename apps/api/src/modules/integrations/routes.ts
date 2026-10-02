import type { FastifyInstance, FastifyRequest, FastifyReply, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h, runAs, type Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { loadApiKeyPrincipal } from '@/core/principal';
import { sha256 } from '@/lib/crypto';
import * as svc from './service';
import { processEvents } from './pipeline';
import { integrationCreateBody, integrationPatchBody, testBody, eventsListQuery, statsQuery, assignCustomerBody, createTicketBody, ingestQuery, type EventsListQuery } from './schemas';

const idParam = z.object({ id: z.string().uuid() });
const tags = ['integrations'];
const INGEST_RATE_LIMIT = { max: 600, timeWindow: '1 minute' };

type Done = (err: Error | null, body?: unknown) => void;

/** JSON that fails to parse becomes a 422 (not a 500 / 400 with a cryptic code) so monitoring systems get a clear answer. */
function parseJsonLenient(_req: FastifyRequest, body: string, done: Done) {
  const text = body.trim();
  if (!text) return done(null, undefined);
  try {
    done(null, JSON.parse(text));
  } catch (err) {
    done(new ValidationError('Invalid JSON payload', { error: err instanceof Error ? err.message : String(err), snippet: text.slice(0, 200) }));
  }
}

/** PRTG HTTP actions post form-encoded placeholders. */
function parseForm(_req: FastifyRequest, body: string, done: Done) {
  try {
    const params = new URLSearchParams(body);
    const obj: Record<string, string> = {};
    params.forEach((v, k) => {
      if (!(k in obj)) obj[k] = v;
    });
    done(null, obj);
  } catch (err) {
    done(new ValidationError('Invalid form-encoded payload', { error: err instanceof Error ? err.message : String(err) }));
  }
}

/** text/plain bodies: JSON if it looks like JSON, otherwise form-encoded. */
function parseTextLenient(req: FastifyRequest, body: string, done: Done) {
  const text = body.trim();
  if (!text) return done(null, undefined);
  if (text.startsWith('{') || text.startsWith('[')) return parseJsonLenient(req, text, done);
  return parseForm(req, text, done);
}

/** Runs the handler in its own committed transaction, then `then` (e.g. inline processing that needs the committed rows). */
function hThen<R>(fn: (ctx: Ctx, req: FastifyRequest, reply: FastifyReply) => Promise<R>, then: (req: FastifyRequest, result: R) => Promise<unknown>): RouteHandlerMethod {
  const inner = h(fn) as unknown as (this: unknown, req: FastifyRequest, reply: FastifyReply) => Promise<R>;
  return async function (this: unknown, req: FastifyRequest, reply: FastifyReply) {
    const result = await inner.call(this, req, reply);
    return then(req, result);
  } as RouteHandlerMethod;
}

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const manage = app.auth('integrations:manage');
  const events = app.auth('integrations:events', 'integrations:manage');

  // Body parsers scoped to this plugin: lenient JSON (422 on syntax errors), form-encoded (PRTG) and text/plain.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, parseJsonLenient);
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, parseForm);
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, parseTextLenient);

  /** Systems that cannot set headers (PRTG) pass the key as `?key=`; validated exactly like the header. */
  const keyFromQuery = async (req: FastifyRequest) => {
    if (req.principal) return;
    const key = (req.query as { key?: unknown } | undefined)?.key;
    if (typeof key === 'string' && key.length > 10) {
      const p = await loadApiKeyPrincipal(key, sha256);
      if (p) req.principal = p;
    }
  };
  const ingestPre = [keyFromQuery, events];
  const ingestHandler = h(async (ctx, req, reply) => {
    const result = await svc.ingest(ctx, (req.params as { id: string }).id, req.body);
    reply.code(202);
    return result;
  });
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const eventAfter = (req: FastifyRequest, id: string) => runAs(req.principal!, { requestId: req.id, source: 'ui' }, (ctx) => svc.getEvent(ctx, id));

  // ------------------------------------------------------------ types & integrations
  r.get('/integrations/types', { preHandler: events, schema: { tags } }, async () => svc.listTypes());
  r.get('/integrations', { preHandler: events, schema: { tags } }, h((ctx) => svc.listIntegrations(ctx)));
  r.post('/integrations', { preHandler: manage, schema: { tags, body: integrationCreateBody } }, h((ctx, req) => svc.createIntegration(ctx, req.body as z.infer<typeof integrationCreateBody>)));

  // ------------------------------------------------------------ events (static paths before /integrations/:id)
  r.get('/integrations/stats', { preHandler: events, schema: { tags, querystring: statsQuery } }, h((ctx, req) => {
    const q = req.query as z.infer<typeof statsQuery>;
    return svc.stats(ctx, q.days, q.customerId);
  }));
  r.get('/integrations/events', { preHandler: events, schema: { tags, querystring: eventsListQuery } }, h((ctx, req) => svc.listEvents(ctx, req.query as EventsListQuery)));
  r.get('/integrations/events/:id', { preHandler: events, schema: { tags, params: idParam } }, h((ctx, req) => svc.getEvent(ctx, idOf(req))));
  r.post('/integrations/events/:id/reprocess', { preHandler: events, schema: { tags, params: idParam } }, hThen(
    (ctx, req) => svc.reprocessEvent(ctx, idOf(req)),
    async (req, res) => {
      await processEvents([res.id], { force: true, requestId: req.id });
      return eventAfter(req, res.id);
    },
  ));
  r.post('/integrations/events/:id/assign-customer', { preHandler: events, schema: { tags, params: idParam, body: assignCustomerBody } }, hThen(
    (ctx, req) => svc.assignCustomer(ctx, idOf(req), (req.body as z.infer<typeof assignCustomerBody>).customerId),
    async (req, res) => {
      await processEvents([res.id], { force: true, requestId: req.id });
      return eventAfter(req, res.id);
    },
  ));
  r.post('/integrations/events/:id/ignore', { preHandler: events, schema: { tags, params: idParam } }, h((ctx, req) => svc.ignoreEvent(ctx, idOf(req))));
  r.post('/integrations/events/:id/create-ticket', { preHandler: events, schema: { tags, params: idParam, body: createTicketBody } }, h((ctx, req) => svc.createTicketFromEvent(ctx, idOf(req), (req.body as z.infer<typeof createTicketBody>)?.customerId ?? null)));

  // ------------------------------------------------------------ ingestion (API keys; ?key= for systems without header support)
  r.post('/integrations/prtg/:id', { preHandler: ingestPre, config: { rateLimit: INGEST_RATE_LIMIT }, schema: { tags, params: idParam, querystring: ingestQuery } }, ingestHandler);
  r.post('/integrations/fortisiem/:id', { preHandler: ingestPre, config: { rateLimit: INGEST_RATE_LIMIT }, schema: { tags, params: idParam, querystring: ingestQuery } }, ingestHandler);
  r.post('/integrations/:id/events', { preHandler: ingestPre, config: { rateLimit: INGEST_RATE_LIMIT }, schema: { tags, params: idParam, querystring: ingestQuery } }, ingestHandler);

  // ------------------------------------------------------------ single integration
  r.get('/integrations/:id', { preHandler: events, schema: { tags, params: idParam } }, h((ctx, req) => svc.getIntegration(ctx, idOf(req))));
  r.patch('/integrations/:id', { preHandler: manage, schema: { tags, params: idParam, body: integrationPatchBody } }, h((ctx, req) => svc.updateIntegration(ctx, idOf(req), req.body as z.infer<typeof integrationPatchBody>)));
  r.delete('/integrations/:id', { preHandler: manage, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteIntegration(ctx, idOf(req))));
  r.post('/integrations/:id/rotate-key', { preHandler: manage, schema: { tags, params: idParam } }, h((ctx, req) => svc.rotateKey(ctx, idOf(req))));
  r.post('/integrations/:id/test', { preHandler: manage, schema: { tags, params: idParam, body: testBody } }, h((ctx, req) => svc.testIntegration(ctx, idOf(req), (req.body as z.infer<typeof testBody>)?.payload)));
}
