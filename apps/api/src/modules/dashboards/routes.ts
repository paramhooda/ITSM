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
  r.get('/dashboards/noc', { preHandler: app.auth('dashboards:noc'), schema: { tags } }, h((ctx) => svc.noc(ctx)));
  r.get('/dashboards/soc', { preHandler: app.auth('dashboards:soc'), schema: { tags } }, h((ctx) => svc.soc(ctx)));
  r.get('/dashboards/amc', { preHandler: app.auth('dashboards:amc'), schema: { tags } }, h((ctx) => svc.amc(ctx)));
  r.get('/dashboards/engineer', { preHandler: app.auth(), schema: { tags } }, h((ctx) => svc.engineer(ctx)));
  r.get('/dashboards/customer', { preHandler: app.auth('portal:access', 'customers:read'), schema: { tags, querystring: z.object({ customerId: uuid.optional() }) } }, h((ctx, req) => svc.customer(ctx, { customerId: (req.query as { customerId?: string }).customerId ?? null })));
  r.get('/dashboards/trends', { preHandler: app.auth(), schema: { tags, querystring: z.object({ customerId: uuid.optional(), from: dateStr.optional(), to: dateStr.optional(), metric: z.string().max(40).optional() }) } }, h((ctx, req) => svc.trends(ctx, req.query as { customerId?: string; from?: string; to?: string; metric?: string })));
}
