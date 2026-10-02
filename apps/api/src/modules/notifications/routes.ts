import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import { paginationSchema } from '@/core/pagination';
import * as svc from './service';

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/notifications/unread-count', { preHandler: app.auth(), schema: { tags: ['notifications'] } }, h((ctx) => svc.unreadCount(ctx)));
  r.get('/notifications', { preHandler: app.auth(), schema: { tags: ['notifications'], querystring: paginationSchema.extend({ unread: z.coerce.boolean().optional() }) } }, h((ctx, req) => {
    const q = req.query as { page: number; pageSize: number; unread?: boolean };
    return svc.list(ctx, q.page, q.pageSize, q.unread ?? false);
  }));
  r.post('/notifications/read', { preHandler: app.auth(), schema: { tags: ['notifications'], body: z.object({ ids: z.array(z.string().uuid()).optional(), all: z.boolean().optional() }) } }, h((ctx, req) => {
    const b = req.body as { ids?: string[]; all?: boolean };
    return svc.markRead(ctx, b.all ? 'all' : b.ids ?? []);
  }));
  r.get('/notifications/outbox', { preHandler: app.auth('admin:system', 'admin:config'), schema: { tags: ['notifications'] } }, h((ctx) => svc.outboxStats(ctx)));
}
