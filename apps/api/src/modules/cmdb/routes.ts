import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { stringify } from 'csv-stringify';
import { h } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { readCsvUpload } from '@/modules/assets/routes';
import * as svc from './service';
import { ciListQuery, ciCreateBody, ciPatchBody, ciBulkBody, relationshipBody, servicesBody, interfacesBody, graphQuery, summaryQuery, serviceMapQuery, CI_IMPORT_COLUMNS, type CiBulkInput, type CiListQuery } from './schemas';

const idParam = z.object({ id: z.string().uuid() });

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.auth('cmdb:read');
  const manage = app.auth('cmdb:manage');

  r.get('/cmdb/types', { preHandler: app.auth(), schema: { tags: ['cmdb'] } }, h((ctx) => svc.listTypes(ctx)));
  r.get('/cmdb/summary', { preHandler: read, schema: { tags: ['cmdb'], querystring: summaryQuery } }, h((ctx, req) => svc.ciSummary(ctx, (req.query as { customerId?: string }).customerId)));
  r.get('/cmdb/overview', { preHandler: read, schema: { tags: ['cmdb'], querystring: summaryQuery } }, h((ctx, req) => svc.cmdbOverview(ctx, (req.query as { customerId?: string }).customerId)));
  r.get('/cmdb/services', { preHandler: read, schema: { tags: ['cmdb'], querystring: summaryQuery } }, h((ctx, req) => svc.listBusinessServices(ctx, (req.query as { customerId?: string }).customerId)));
  r.get('/cmdb/services/:id/map', { preHandler: read, schema: { tags: ['cmdb'], params: idParam, querystring: serviceMapQuery } }, h((ctx, req) => svc.serviceMap(ctx, (req.params as { id: string }).id, (req.query as { depth: number }).depth)));
  r.get('/cmdb/cis', { preHandler: read, schema: { tags: ['cmdb'], querystring: ciListQuery } }, h((ctx, req) => svc.listCis(ctx, req.query as CiListQuery)));
  // Static path registered ahead of /cmdb/cis/:id so it can never be read as an id.
  r.post('/cmdb/cis/bulk', { preHandler: manage, schema: { tags: ['cmdb'], body: ciBulkBody } }, h((ctx, req) => svc.bulkUpdateCis(ctx, req.body as CiBulkInput)));

  r.get('/cmdb/export.csv', { preHandler: read, schema: { tags: ['cmdb'], querystring: ciListQuery } }, h(async (ctx, req, reply) => {
    const rows = await svc.exportCis(ctx, req.query as CiListQuery);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="cis-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(stringify(rows, { header: true, columns: [...svc.EXPORT_COLUMNS] }));
  }));
  r.get('/cmdb/import/template.csv', { preHandler: read, schema: { tags: ['cmdb'] } }, async (_req, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="cis-import-template.csv"');
    const example = { name: 'core-sw-01', type: 'network_switch', hostname: 'core-sw-01', ipAddress: '10.0.0.2', macAddress: '00:11:22:33:44:55', serialNumber: 'FOC1234X0AB', manufacturer: 'Cisco', model: 'C9300-48P', osName: 'IOS-XE 17.9', site: 'HQ', environment: 'production', criticality: 'high', status: 'active', description: '' };
    return reply.send(stringify([example], { header: true, columns: [...CI_IMPORT_COLUMNS] }));
  });
  r.post('/cmdb/import', { preHandler: manage, schema: { tags: ['cmdb'], querystring: z.object({ customerId: z.string().uuid().optional() }) } }, h(async (ctx, req) => {
    const { buffer, fields } = await readCsvUpload(req as never);
    const customerId = (req.query as { customerId?: string }).customerId ?? fields.customerId;
    if (!customerId || !z.string().uuid().safeParse(customerId).success) throw new ValidationError('customerId is required');
    return svc.importCis(ctx, customerId, buffer);
  }));

  r.post('/cmdb/cis', { preHandler: manage, schema: { tags: ['cmdb'], body: ciCreateBody } }, h((ctx, req) => svc.createCi(ctx, req.body as z.infer<typeof ciCreateBody>)));
  r.get('/cmdb/cis/:id', { preHandler: read, schema: { tags: ['cmdb'], params: idParam } }, h((ctx, req) => svc.getCi(ctx, (req.params as { id: string }).id)));
  r.patch('/cmdb/cis/:id', { preHandler: manage, schema: { tags: ['cmdb'], params: idParam, body: ciPatchBody } }, h((ctx, req) => svc.updateCi(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof ciPatchBody>)));
  r.delete('/cmdb/cis/:id', { preHandler: manage, schema: { tags: ['cmdb'], params: idParam } }, h((ctx, req) => svc.deleteCi(ctx, (req.params as { id: string }).id)));

  r.get('/cmdb/cis/:id/relationships', { preHandler: read, schema: { tags: ['cmdb'], params: idParam } }, h(async (ctx, req) => (await svc.getCi(ctx, (req.params as { id: string }).id)).relationships));
  r.post('/cmdb/cis/:id/relationships', { preHandler: manage, schema: { tags: ['cmdb'], params: idParam, body: relationshipBody } }, h((ctx, req) => svc.addRelationship(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof relationshipBody>)));
  r.delete('/cmdb/relationships/:id', { preHandler: manage, schema: { tags: ['cmdb'], params: idParam } }, h((ctx, req) => svc.deleteRelationship(ctx, (req.params as { id: string }).id)));
  r.put('/cmdb/cis/:id/services', { preHandler: manage, schema: { tags: ['cmdb'], params: idParam, body: servicesBody } }, h((ctx, req) => svc.setServices(ctx, (req.params as { id: string }).id, (req.body as { serviceIds: string[] }).serviceIds)));
  r.put('/cmdb/cis/:id/interfaces', { preHandler: manage, schema: { tags: ['cmdb'], params: idParam, body: interfacesBody } }, h((ctx, req) => svc.setInterfaces(ctx, (req.params as { id: string }).id, (req.body as z.infer<typeof interfacesBody>).interfaces)));

  r.get('/cmdb/cis/:id/graph', { preHandler: read, schema: { tags: ['cmdb'], params: idParam, querystring: graphQuery } }, h((ctx, req) => {
    const q = req.query as z.infer<typeof graphQuery>;
    return svc.graph(ctx, (req.params as { id: string }).id, q.depth, q.limit);
  }));
  r.get('/cmdb/cis/:id/impact', { preHandler: read, schema: { tags: ['cmdb'], params: idParam } }, h((ctx, req) => svc.impact(ctx, (req.params as { id: string }).id)));
  r.get('/cmdb/cis/:id/history', { preHandler: read, schema: { tags: ['cmdb'], params: idParam, querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) } }, h((ctx, req) => svc.history(ctx, (req.params as { id: string }).id, (req.query as { limit: number }).limit)));
}
