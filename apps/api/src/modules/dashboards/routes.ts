import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';

const tags = ['dashboards'];
const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/dashboards/management', { preHandler: app.auth('dashboards:management'), schema: { tags, querystring: z.object({ days: z.coerce.number().int().default(30), customerId: uuid.optional() }) } }, h((ctx, req) => {
    const qs = req.query as { days: number; customerId?: string };
    return svc.management(ctx, { days: qs.days, customerId: qs.customerId ?? null });
  }));
  /** Global dashboard filters: the period and, for staff views, an optional customer scope. */
  const period = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), customerId: uuid.optional() });
  const scopeOf = (req: { query: unknown }) => { const q = req.query as { days?: number; customerId?: string }; return { days: q.days, customerId: q.customerId ?? null }; };
  r.get('/dashboards/noc', { preHandler: app.auth('dashboards:noc'), schema: { tags, querystring: period } }, h((ctx, req) => svc.noc(ctx, scopeOf(req))));
  r.get('/dashboards/soc', { preHandler: app.auth('dashboards:soc'), schema: { tags, querystring: period } }, h((ctx, req) => svc.soc(ctx, scopeOf(req))));
  r.get('/dashboards/amc', { preHandler: app.auth('dashboards:amc'), schema: { tags, querystring: period } }, h((ctx, req) => svc.amc(ctx, scopeOf(req))));
  r.get('/dashboards/engineer', { preHandler: app.auth(), schema: { tags, querystring: period } }, h((ctx, req) => svc.engineer(ctx, scopeOf(req))));
  r.get('/dashboards/customer', { preHandler: app.auth('portal:access', 'customers:read'), schema: { tags, querystring: period } }, h((ctx, req) => svc.customer(ctx, scopeOf(req))));
  r.get('/dashboards/trends', { preHandler: app.auth(), schema: { tags, querystring: z.object({ customerId: uuid.optional(), from: dateStr.optional(), to: dateStr.optional(), metric: z.string().max(40).optional() }) } }, h((ctx, req) => svc.trends(ctx, req.query as { customerId?: string; from?: string; to?: string; metric?: string })));
}
