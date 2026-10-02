import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';

const idParam = z.object({ id: z.string().uuid() });
const tags = ['services'];

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/services', { preHandler: app.auth('services:read'), schema: { tags, querystring: svc.serviceListQuery } }, h((ctx, req) => svc.listServices(ctx, req.query as svc.ServiceListQuery)));
  r.get('/services/catalog', { preHandler: app.auth('services:read'), schema: { tags, querystring: svc.serviceCatalogQuery } }, h((ctx, req) => svc.serviceCatalog(ctx, req.query as svc.ServiceCatalogQuery)));
  r.post('/services', { preHandler: app.auth('services:manage'), schema: { tags, body: svc.serviceInput } }, h((ctx, req) => svc.createService(ctx, req.body as svc.ServiceInput)));
  r.get('/services/:id', { preHandler: app.auth('services:read'), schema: { tags, params: idParam } }, h((ctx, req) => svc.getService(ctx, (req.params as { id: string }).id)));
  r.get('/services/:id/customers', { preHandler: app.auth('services:read'), schema: { tags, params: idParam } }, h((ctx, req) => svc.serviceCustomers(ctx, (req.params as { id: string }).id)));
  r.patch('/services/:id', { preHandler: app.auth('services:manage'), schema: { tags, params: idParam, body: svc.serviceInput.partial() } }, h((ctx, req) => svc.updateService(ctx, (req.params as { id: string }).id, req.body as Partial<svc.ServiceInput>)));
  r.delete('/services/:id', { preHandler: app.auth('services:manage'), schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteService(ctx, (req.params as { id: string }).id)));
}
