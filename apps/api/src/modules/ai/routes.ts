import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import { AppError, UnauthorizedError } from '@/core/errors';
import { logger } from '@/core/logger';
import * as svc from './service';
import * as sug from './suggestions';
import { chatBodySchema, feedbackBodySchema, idParam, decideBodySchema, draftUpdateBodySchema, classifyDraftBodySchema, problemClustersQuerySchema, suggestionsQuerySchema, type ChatBody, type ClassifyDraftBody } from './schemas';

/**
 * AI assistant and AI-assisted ITSM features. Every handler runs with the
 * caller's own identity (tenant RLS + permissions); actions performed by the
 * assistant are audited with source = 'ai'.
 *
 * Routes that call the model are NOT wrapped in `h()`: a model call must never
 * hold a database connection, so those services open their own short
 * transactions around each step (`chatTurn`, `stepsFor`).
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['ai'];
  const use = app.auth('ai:use');
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;
  const principal = (req: FastifyRequest) => {
    if (!req.principal) throw new UnauthorizedError();
    return req.principal;
  };
  const metaOf = (req: FastifyRequest): svc.TurnMeta => ({ requestId: req.id, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined });
  const steps = (req: FastifyRequest) => svc.stepsFor(principal(req), metaOf(req));
  /** The assistant has its own, tighter limit per person on top of the API-wide one. */
  const chatLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  // ---- status + conversations
  r.get('/ai/status', { preHandler: app.auth(), schema: { tags } }, h((ctx) => svc.status(ctx)));
  r.post('/ai/test', { preHandler: app.auth('admin:system', 'admin:config'), schema: { tags } }, async (req) => svc.test(principal(req)));
  r.get('/ai/conversations', { preHandler: use, schema: { tags } }, h((ctx) => svc.listConversations(ctx, 20)));
  r.get('/ai/conversations/:id', { preHandler: use, schema: { tags, params: idParam } }, h((ctx, req) => svc.getConversation(ctx, id(req))));
  r.delete('/ai/conversations/:id', { preHandler: use, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteConversation(ctx, id(req))));
  r.post('/ai/chat', { preHandler: use, config: chatLimit, schema: { tags, body: chatBodySchema } }, async (req, reply) => {
    const wantsStream = String(req.headers.accept ?? '').includes('text/event-stream');
    if (!wantsStream) return svc.chatTurn(principal(req), metaOf(req), req.body as ChatBody);
    // Streamed turn: progress events while the reply is prepared, then the same result as the JSON route. The
    // handler owns the socket from here (hijack), so every outcome, errors included, ends the stream itself.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    raw.flushHeaders?.();
    let closed = false;
    req.raw.on('close', () => { closed = true; });
    const send = (event: string, data: unknown) => {
      if (closed) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('open', { requestId: req.id });
    const keepAlive = setInterval(() => { if (!closed) raw.write(': ping\n\n'); }, 15_000);
    try {
      const result = await svc.chatTurn(principal(req), metaOf(req), req.body as ChatBody, (ev) => send(ev.type, ev));
      send('message', result);
    } catch (err) {
      if (err instanceof AppError) send('error', { statusCode: err.statusCode, error: err.code, message: err.message, details: err.details });
      else {
        logger.error({ err, requestId: req.id }, 'ai chat stream failed');
        send('error', { statusCode: 500, error: 'internal_error', message: 'The assistant failed unexpectedly. Please try again.' });
      }
    } finally {
      clearInterval(keepAlive);
      if (!closed) raw.end();
    }
  });
  r.post('/ai/messages/:id/feedback', { preHandler: use, schema: { tags, params: idParam, body: feedbackBodySchema } }, h((ctx, req) => {
    const body = req.body as z.infer<typeof feedbackBodySchema>;
    return svc.feedback(ctx, id(req), body.rating, body.note ?? null);
  }));

  // ---- AI-assisted ITSM (ai:use + tickets:read / portal:tickets enforced in the service; each feature has its own switch)
  r.post('/ai/tickets/:id/summarize', { preHandler: use, config: chatLimit, schema: { tags, params: idParam } }, async (req) => sug.summarize(steps(req), id(req)));
  r.post('/ai/tickets/:id/classify', { preHandler: use, config: chatLimit, schema: { tags, params: idParam } }, async (req) => sug.classify(steps(req), id(req)));
  r.post('/ai/classify-draft', { preHandler: use, config: chatLimit, schema: { tags, body: classifyDraftBodySchema } }, async (req) => sug.classifyDraft(steps(req), req.body as ClassifyDraftBody));
  r.post('/ai/tickets/:id/recommend-assignment', { preHandler: use, schema: { tags, params: idParam } }, h((ctx, req) => sug.recommendAssignment(ctx, id(req))));
  r.post('/ai/tickets/:id/similar', { preHandler: use, config: chatLimit, schema: { tags, params: idParam } }, async (req) => sug.similar(steps(req), id(req)));
  r.post('/ai/tickets/:id/suggest-knowledge', { preHandler: use, config: chatLimit, schema: { tags, params: idParam } }, async (req) => sug.suggestKnowledge(steps(req), id(req)));
  r.post('/ai/tickets/:id/resolution-suggestions', { preHandler: use, config: chatLimit, schema: { tags, params: idParam } }, async (req) => sug.resolutionSuggestions(steps(req), id(req)));
  r.post('/ai/tickets/:id/draft-customer-update', { preHandler: use, config: chatLimit, schema: { tags, params: idParam, body: draftUpdateBodySchema } }, async (req) => sug.draftCustomerUpdate(steps(req), id(req), (req.body as { tone?: 'neutral' | 'formal' | 'friendly' | 'apologetic' } | undefined)?.tone ?? 'neutral'));
  r.post('/ai/tickets/:id/major/draft-update', { preHandler: use, config: chatLimit, schema: { tags, params: idParam, body: z.object({ audience: z.enum(['customer', 'internal']).optional() }).optional() } }, async (req) => sug.draftMajorUpdate(steps(req), id(req), (req.body as { audience?: 'customer' | 'internal' } | undefined)?.audience ?? 'customer'));
  r.post('/ai/tickets/:id/duplicate-check', { preHandler: use, schema: { tags, params: idParam } }, h((ctx, req) => sug.duplicateCheck(ctx, id(req))));
  r.get('/ai/tickets/:id/suggestions', { preHandler: use, schema: { tags, params: idParam, querystring: suggestionsQuerySchema } }, h((ctx, req) => sug.listSuggestions(ctx, id(req), (req.query as { kind?: string }).kind)));
  r.post('/ai/changes/:id/impact', { preHandler: use, config: chatLimit, schema: { tags, params: idParam } }, async (req) => sug.changeImpact(steps(req), id(req)));
  r.get('/ai/problem-clusters', { preHandler: use, config: chatLimit, schema: { tags, querystring: problemClustersQuerySchema } }, async (req) => sug.problemClusters(steps(req), req.query as z.infer<typeof problemClustersQuerySchema>));
  r.post('/ai/suggestions/:id/decide', { preHandler: use, schema: { tags, params: idParam, body: decideBodySchema } }, h((ctx, req) => {
    const body = req.body as z.infer<typeof decideBodySchema>;
    return sug.decide(ctx, id(req), body.status, body.note ?? null);
  }));
}
