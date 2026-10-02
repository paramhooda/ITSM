import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { KB_VISIBILITY, DOMAINS } from '@itsm/shared';
import { h } from '@/core/context';
import { listQuerySchema } from '@/core/pagination';
import * as svc from './service';
import { knowledgeOverview } from './overview';

const idParam = z.object({ id: z.string().uuid() });
const uuidOrNull = z.string().uuid().nullable();

const articleBody = z.object({
  title: z.string().min(1).max(300),
  summary: z.string().max(2000).nullable().optional(),
  body: z.string().max(500_000).optional(),
  categoryId: uuidOrNull.optional(),
  articleType: z.enum(svc.ARTICLE_TYPES).optional(),
  domain: z.enum(DOMAINS).optional(),
  visibility: z.enum(KB_VISIBILITY).optional(),
  customerId: uuidOrNull.optional(),
  serviceId: uuidOrNull.optional(),
  ciTypeKey: z.string().max(100).nullable().optional(),
  tags: z.array(z.string().max(50)).max(30).optional(),
  relatedTicketIds: z.array(z.string().uuid()).max(50).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const patchBody = articleBody.partial().extend({ changeNote: z.string().max(500).nullable().optional() });

const categoryBody = z.object({
  key: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, digits, dashes or underscores'),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
  parentId: uuidOrNull.optional(),
  domain: z.enum(DOMAINS).optional(),
  sortOrder: z.number().int().optional(),
});

const toInput = (b: z.infer<typeof patchBody>): Partial<svc.ArticleInput> => ({
  ...b,
  expiresAt: b.expiresAt === undefined ? undefined : b.expiresAt ? new Date(b.expiresAt) : null,
});

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.auth('kb:read', 'kb:manage', 'portal:access');
  const manage = app.auth('kb:manage');

  r.get('/knowledge', {
    preHandler: read,
    schema: {
      tags: ['knowledge'],
      querystring: listQuerySchema.extend({
        categoryId: z.string().uuid().optional(),
        articleType: z.string().optional(),
        visibility: z.enum(KB_VISIBILITY).optional(),
        customerId: z.string().uuid().optional(),
        serviceId: z.string().uuid().optional(),
        status: z.enum(svc.ARTICLE_STATUSES).optional(),
        domain: z.enum(DOMAINS).optional(),
        tag: z.string().optional(),
        authorId: z.string().uuid().optional(),
        ciTypeKey: z.string().optional(),
      }),
    },
  }, h((ctx, req) => svc.listArticles(ctx, req.query as svc.ArticleFilters)));

  r.get('/knowledge/categories', { preHandler: read, schema: { tags: ['knowledge'] } }, h((ctx) => svc.listCategories(ctx)));
  r.post('/knowledge/categories', { preHandler: manage, schema: { tags: ['knowledge'], body: categoryBody } }, h((ctx, req) => svc.createCategory(ctx, req.body as svc.CategoryInput)));
  r.patch('/knowledge/categories/:id', { preHandler: manage, schema: { tags: ['knowledge'], params: idParam, body: categoryBody.partial() } }, h((ctx, req) => svc.updateCategory(ctx, (req.params as { id: string }).id, req.body as Partial<svc.CategoryInput>)));
  r.delete('/knowledge/categories/:id', { preHandler: manage, schema: { tags: ['knowledge'], params: idParam } }, h((ctx, req) => svc.deleteCategory(ctx, (req.params as { id: string }).id)));

  r.get('/knowledge/suggest', {
    preHandler: read,
    schema: { tags: ['knowledge'], querystring: z.object({ q: z.string().min(1).max(500), serviceId: z.string().uuid().optional(), ciTypeKey: z.string().optional(), customerId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(25).default(5) }) },
  }, h((ctx, req) => svc.suggest(ctx, req.query as svc.SuggestInput)));

  r.get('/knowledge/stats', { preHandler: app.auth('kb:read', 'kb:manage'), schema: { tags: ['knowledge'] } }, h((ctx) => svc.stats(ctx)));
  r.get('/knowledge/overview', { preHandler: app.auth('kb:read', 'kb:manage'), schema: { tags: ['knowledge'] } }, h((ctx) => knowledgeOverview(ctx)));

  r.post('/knowledge', { preHandler: manage, schema: { tags: ['knowledge'], body: articleBody } }, h((ctx, req) => svc.createArticle(ctx, toInput(req.body as z.infer<typeof articleBody>) as svc.ArticleInput)));

  r.get('/knowledge/:id', {
    preHandler: read,
    schema: { tags: ['knowledge'], params: idParam, querystring: z.object({ noView: z.string().optional() }) },
  }, h((ctx, req) => svc.getArticle(ctx, (req.params as { id: string }).id, { noView: ['1', 'true'].includes(String((req.query as { noView?: string }).noView ?? '')) })));

  r.patch('/knowledge/:id', { preHandler: manage, schema: { tags: ['knowledge'], params: idParam, body: patchBody } }, h((ctx, req) => {
    const { changeNote, ...rest } = req.body as z.infer<typeof patchBody>;
    return svc.updateArticle(ctx, (req.params as { id: string }).id, toInput(rest), changeNote);
  }));

  r.post('/knowledge/:id/publish', { preHandler: manage, schema: { tags: ['knowledge'], params: idParam } }, h((ctx, req) => svc.publishArticle(ctx, (req.params as { id: string }).id)));
  r.post('/knowledge/:id/archive', { preHandler: manage, schema: { tags: ['knowledge'], params: idParam } }, h((ctx, req) => svc.archiveArticle(ctx, (req.params as { id: string }).id)));
  r.post('/knowledge/:id/unarchive', { preHandler: manage, schema: { tags: ['knowledge'], params: idParam } }, h((ctx, req) => svc.unarchiveArticle(ctx, (req.params as { id: string }).id)));

  r.get('/knowledge/:id/versions/:version', {
    preHandler: app.auth('kb:read', 'kb:manage'),
    schema: { tags: ['knowledge'], params: idParam.extend({ version: z.coerce.number().int().min(1) }) },
  }, h((ctx, req) => {
    const p = req.params as { id: string; version: number };
    return svc.getVersion(ctx, p.id, p.version);
  }));

  r.post('/knowledge/:id/restore-version/:version', {
    preHandler: manage,
    schema: { tags: ['knowledge'], params: idParam.extend({ version: z.coerce.number().int().min(1) }) },
  }, h((ctx, req) => {
    const p = req.params as { id: string; version: number };
    return svc.restoreVersion(ctx, p.id, p.version);
  }));

  r.post('/knowledge/:id/feedback', { preHandler: read, schema: { tags: ['knowledge'], params: idParam, body: z.object({ helpful: z.boolean() }) } }, h((ctx, req) => svc.feedback(ctx, (req.params as { id: string }).id, (req.body as { helpful: boolean }).helpful)));

  r.delete('/knowledge/:id', { preHandler: manage, schema: { tags: ['knowledge'], params: idParam } }, h((ctx, req) => svc.deleteArticle(ctx, (req.params as { id: string }).id)));
}
