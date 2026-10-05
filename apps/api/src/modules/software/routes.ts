import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { stringify } from 'csv-stringify';
import { h } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { readCsvUpload } from '@/modules/assets/routes';
import * as svc from './service';
import { softwareOverview } from './overview';
import { importInstallations } from './import';
import { productListQuery, productBody, productPatch, installationListQuery, installationBody, installationPatch, licenceListQuery, licenceBody, licencePatch, renewBody, complianceQuery, renewalsQuery, overviewQuery, SOFTWARE_IMPORT_COLUMNS, type ProductListQuery, type InstallationListQuery, type LicenceListQuery, type ComplianceQuery, type RenewalsQuery } from './schemas';

const idParam = z.object({ id: z.string().uuid() });
const tags = ['software'];

/**
 * Software asset management: the catalogue, installations (with CSV import
 * and export), licences (with renewal), the compliance list and the
 * renewals view. Nothing here calls the model. Static paths are registered
 * before `/:id` paths.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.auth('software:read');
  const manage = app.auth('software:manage');

  r.get('/software/overview', { preHandler: read, schema: { tags, querystring: overviewQuery } }, h((ctx, req) => softwareOverview(ctx, (req.query as { customerId?: string }).customerId)));

  // ---- catalogue
  r.get('/software/products', { preHandler: read, schema: { tags, querystring: productListQuery } }, h((ctx, req) => svc.listProducts(ctx, req.query as ProductListQuery)));
  r.post('/software/products', { preHandler: manage, schema: { tags, body: productBody } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createProduct(ctx, req.body as z.infer<typeof productBody>);
  }));
  r.get('/software/products/:id', { preHandler: read, schema: { tags, params: idParam, querystring: overviewQuery } }, h((ctx, req) => svc.getProduct(ctx, (req.params as { id: string }).id, (req.query as { customerId?: string }).customerId)));
  r.patch('/software/products/:id', { preHandler: manage, schema: { tags, params: idParam, body: productPatch } }, h((ctx, req) => svc.updateProduct(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof productPatch>)));
  r.delete('/software/products/:id', { preHandler: manage, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteProduct(ctx, (req.params as { id: string }).id)));

  // ---- installations (static paths first)
  r.get('/software/installations', { preHandler: read, schema: { tags, querystring: installationListQuery } }, h((ctx, req) => svc.listInstallations(ctx, req.query as InstallationListQuery)));
  r.get('/software/installations/export.csv', { preHandler: read, schema: { tags, querystring: installationListQuery } }, h(async (ctx, req, reply) => {
    const rows = await svc.exportInstallations(ctx, req.query as InstallationListQuery);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="software-installations-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(stringify(rows, { header: true, columns: [...svc.EXPORT_COLUMNS] }));
  }));
  r.get('/software/installations/import/template.csv', { preHandler: read, schema: { tags } }, async (_req, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="software-import-template.csv"');
    const example = { publisher: 'Microsoft', product: 'Office LTSC', versionFamily: '2021', version: '16.0.14332', edition: 'Professional Plus', hostname: 'hq-lt01', assetTag: 'AST-000123', serialNumber: '', user: 'jane.doe@example.com', cores: '', installedAt: '2025-03-14', source: 'csv', notes: '' };
    return reply.send(stringify([example], { header: true, columns: [...SOFTWARE_IMPORT_COLUMNS] }));
  });
  r.post('/software/installations/import', { preHandler: manage, schema: { tags, querystring: z.object({ customerId: z.string().uuid().optional() }) } }, h(async (ctx, req) => {
    const { buffer, fields } = await readCsvUpload(req as never);
    const customerId = (req.query as { customerId?: string }).customerId ?? fields.customerId;
    if (!customerId || !z.string().uuid().safeParse(customerId).success) throw new ValidationError('customerId is required');
    return importInstallations(ctx, customerId, buffer);
  }));
  r.post('/software/installations', { preHandler: manage, schema: { tags, body: installationBody } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createInstallation(ctx, req.body as z.infer<typeof installationBody>);
  }));
  r.patch('/software/installations/:id', { preHandler: manage, schema: { tags, params: idParam, body: installationPatch } }, h((ctx, req) => svc.updateInstallation(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof installationPatch>)));
  r.delete('/software/installations/:id', { preHandler: manage, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteInstallation(ctx, (req.params as { id: string }).id)));

  // ---- licences
  r.get('/software/licences', { preHandler: read, schema: { tags, querystring: licenceListQuery } }, h((ctx, req) => svc.listLicences(ctx, req.query as LicenceListQuery)));
  r.post('/software/licences', { preHandler: manage, schema: { tags, body: licenceBody } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createLicence(ctx, req.body as z.infer<typeof licenceBody>);
  }));
  r.get('/software/licences/:id', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => svc.getLicence(ctx, (req.params as { id: string }).id)));
  r.patch('/software/licences/:id', { preHandler: manage, schema: { tags, params: idParam, body: licencePatch } }, h((ctx, req) => svc.updateLicence(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof licencePatch>)));
  r.delete('/software/licences/:id', { preHandler: manage, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteLicence(ctx, (req.params as { id: string }).id)));
  r.post('/software/licences/:id/renew', { preHandler: manage, schema: { tags, params: idParam, body: renewBody } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.renewLicence(ctx, (req.params as { id: string }).id, (req.body ?? {}) as z.infer<typeof renewBody>);
  }));

  // ---- compliance and renewals
  r.get('/software/compliance', { preHandler: read, schema: { tags, querystring: complianceQuery } }, h((ctx, req) => svc.listCompliance(ctx, req.query as ComplianceQuery)));
  r.get('/software/renewals', { preHandler: read, schema: { tags, querystring: renewalsQuery } }, h((ctx, req) => svc.listRenewals(ctx, req.query as RenewalsQuery)));
}
