import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { stringify } from 'csv-stringify';
import { h } from '@/core/context';
import { paginationSchema } from '@/core/pagination';
import * as svc from './service';

const filterSchema = z.object({
  entityType: z.string().max(100).optional(),
  entityId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  action: z.string().max(100).optional(),
  source: z.enum(['ui', 'api', 'ai', 'integration', 'system']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().max(200).optional(),
});

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/audit', { preHandler: app.auth('admin:audit'), schema: { tags: ['audit'], querystring: paginationSchema.merge(filterSchema) } }, h((ctx, req) => svc.listAudit(ctx, req.query as svc.AuditFilters)));

  r.get('/audit/summary', { preHandler: app.auth('admin:audit'), schema: { tags: ['audit'], querystring: z.object({ days: z.coerce.number().int().min(1).max(366).default(7) }) } }, h((ctx, req) => svc.summary(ctx, (req.query as { days: number }).days)));

  r.get('/audit/export.csv', { preHandler: app.auth('admin:audit'), schema: { tags: ['audit'], querystring: filterSchema } }, h(async (ctx, req, reply) => {
    const filters = req.query as svc.AuditFilters;
    const stringifier = stringify({ header: true, columns: [...svc.CSV_COLUMNS] });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="audit-${stamp}.csv"`).header('Cache-Control', 'no-store');
    reply.send(stringifier);
    await ctx.audit({ entityType: 'audit_log', action: 'export', metadata: { filters: { ...filters } } });
    // Rows are written while the response streams; the handler keeps the tenant transaction open until the end.
    for await (const row of svc.iterateAudit(ctx, filters)) {
      if (!stringifier.write(row)) await new Promise<void>((resolve) => stringifier.once('drain', resolve));
    }
    stringifier.end();
    return reply;
  }));

  r.get('/audit/entity/:entityType/:entityId', {
    preHandler: app.auth(),
    schema: { tags: ['audit'], params: z.object({ entityType: z.string().min(1).max(100), entityId: z.string().uuid() }), querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).optional(), from: z.string().optional(), to: z.string().optional() }) },
  }, h((ctx, req) => {
    const p = req.params as { entityType: string; entityId: string };
    const q = req.query as { limit?: number; from?: string; to?: string };
    return svc.entityHistory(ctx, p.entityType, p.entityId, q);
  }));
}
