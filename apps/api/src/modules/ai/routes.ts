import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as sug from './suggestions';
import { chatBodySchema, idParam, decideBodySchema, draftUpdateBodySchema, classifyDraftBodySchema, problemClustersQuerySchema, suggestionsQuerySchema, type ChatBody, type ClassifyDraftBody } from './schemas';

/**
 * AI assistant and AI-assisted ITSM features. Every handler runs the
 * caller's own Ctx (tenant RLS + permissions); actions performed by the
 * assistant are audited with source = 'ai'.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['ai'];
  const use = app.auth('ai:use');
  const ticketRead = app.auth('ai:use');
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  // ---- status + conversations
  r.get('/ai/status', { preHandler: app.auth(), schema: { tags } }, h((ctx) => svc.status(ctx)));
  r.post('/ai/test', { preHandler: app.auth('admin:system', 'admin:config'), schema: { tags } }, h((ctx) => svc.test(ctx)));
  r.get('/ai/conversations', { preHandler: use, schema: { tags } }, h((ctx) => svc.listConversations(ctx, 20)));
  r.get('/ai/conversations/:id', { preHandler: use, schema: { tags, params: idParam } }, h((ctx, req) => svc.getConversation(ctx, id(req))));
  r.delete('/ai/conversations/:id', { preHandler: use, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteConversation(ctx, id(req))));
  r.post('/ai/chat', { preHandler: use, schema: { tags, body: chatBodySchema } }, h((ctx, req) => svc.chat(ctx, req.body as ChatBody)));

  // ---- AI-assisted ITSM (ai:use + tickets:read / portal:tickets enforced in the service)
  r.post('/ai/tickets/:id/summarize', { preHandler: ticketRead, schema: { tags, params: idParam } }, h((ctx, req) => sug.summarize(ctx, id(req))));
  r.post('/ai/tickets/:id/classify', { preHandler: ticketRead, schema: { tags, params: idParam } }, h((ctx, req) => sug.classify(ctx, id(req))));
  r.post('/ai/classify-draft', { preHandler: app.auth('ai:use'), schema: { tags, body: classifyDraftBodySchema } }, h((ctx, req) => sug.classifyDraft(ctx, req.body as ClassifyDraftBody)));
  r.post('/ai/tickets/:id/recommend-assignment', { preHandler: app.auth('ai:use'), schema: { tags, params: idParam } }, h((ctx, req) => sug.recommendAssignment(ctx, id(req))));
  r.post('/ai/tickets/:id/similar', { preHandler: ticketRead, schema: { tags, params: idParam } }, h((ctx, req) => sug.similar(ctx, id(req))));
  r.post('/ai/tickets/:id/suggest-knowledge', { preHandler: ticketRead, schema: { tags, params: idParam } }, h((ctx, req) => sug.suggestKnowledge(ctx, id(req))));
  r.post('/ai/tickets/:id/resolution-suggestions', { preHandler: ticketRead, schema: { tags, params: idParam } }, h((ctx, req) => sug.resolutionSuggestions(ctx, id(req))));
  r.post('/ai/tickets/:id/draft-customer-update', { preHandler: app.auth('ai:use'), schema: { tags, params: idParam, body: draftUpdateBodySchema } }, h((ctx, req) => sug.draftCustomerUpdate(ctx, id(req), (req.body as { tone?: 'neutral' | 'formal' | 'friendly' | 'apologetic' } | undefined)?.tone ?? 'neutral')));
  r.post('/ai/tickets/:id/major/draft-update', { preHandler: app.auth('ai:use'), schema: { tags, params: idParam, body: z.object({ audience: z.enum(['customer', 'internal']).optional() }).optional() } }, h((ctx, req) => sug.draftMajorUpdate(ctx, id(req), (req.body as { audience?: 'customer' | 'internal' } | undefined)?.audience ?? 'customer')));
  r.post('/ai/tickets/:id/duplicate-check', { preHandler: ticketRead, schema: { tags, params: idParam } }, h((ctx, req) => sug.duplicateCheck(ctx, id(req))));
  r.get('/ai/tickets/:id/suggestions', { preHandler: ticketRead, schema: { tags, params: idParam, querystring: suggestionsQuerySchema } }, h((ctx, req) => sug.listSuggestions(ctx, id(req), (req.query as { kind?: string }).kind)));
  r.post('/ai/changes/:id/impact', { preHandler: app.auth('ai:use'), schema: { tags, params: idParam } }, h((ctx, req) => sug.changeImpact(ctx, id(req))));
  r.get('/ai/problem-clusters', { preHandler: app.auth('ai:use'), schema: { tags, querystring: problemClustersQuerySchema } }, h((ctx, req) => sug.problemClusters(ctx, req.query as z.infer<typeof problemClustersQuerySchema>)));
  r.post('/ai/suggestions/:id/decide', { preHandler: use, schema: { tags, params: idParam, body: decideBodySchema } }, h((ctx, req) => {
    const body = req.body as z.infer<typeof decideBodySchema>;
    return sug.decide(ctx, id(req), body.status, body.note ?? null);
  }));
}
