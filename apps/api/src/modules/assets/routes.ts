import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { stringify } from 'csv-stringify';
import { h } from '@/core/context';
import { ValidationError } from '@/core/errors';
import * as svc from './service';
import { assetListQuery, assetCreateBody, assetPatchBody, lifecycleBody, expiringQuery, summaryQuery, ASSET_IMPORT_COLUMNS, type AssetListQuery } from './schemas';

const idParam = z.object({ id: z.string().uuid() });

/** Reads a multipart CSV upload (field `file`) plus optional text fields. */
export async function readCsvUpload(req: { file: () => Promise<unknown> }) {
  const part = (await req.file()) as { toBuffer: () => Promise<Buffer>; fields: Record<string, { value?: string } | { value?: string }[]> } | undefined;
  if (!part) throw new ValidationError('A CSV file upload is required (multipart field "file")');
  const buf = await part.toBuffer();
  const fields: Record<string, string> = {};
  for (const [k, f] of Object.entries(part.fields ?? {})) {
    const first = Array.isArray(f) ? f[0] : f;
    if (first && typeof first.value === 'string') fields[k] = first.value;
  }
  return { buffer: buf, fields };
}

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = app.auth('assets:read');
  const manage = app.auth('assets:manage');

  r.get('/assets', { preHandler: read, schema: { tags: ['assets'], querystring: assetListQuery } }, h((ctx, req) => svc.listAssets(ctx, req.query as AssetListQuery)));
  r.get('/assets/summary', { preHandler: read, schema: { tags: ['assets'], querystring: summaryQuery } }, h((ctx, req) => svc.assetSummary(ctx, (req.query as { customerId?: string }).customerId)));
  r.get('/assets/expiring', { preHandler: read, schema: { tags: ['assets'], querystring: expiringQuery } }, h((ctx, req) => svc.expiringAssets(ctx, req.query as z.infer<typeof expiringQuery>)));

  r.get('/assets/export.csv', { preHandler: read, schema: { tags: ['assets'], querystring: assetListQuery } }, h(async (ctx, req, reply) => {
    const rows = await svc.exportAssets(ctx, req.query as AssetListQuery);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="assets-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(stringify(rows, { header: true, columns: [...svc.EXPORT_COLUMNS] }));
  }));

  r.get('/assets/import/template.csv', { preHandler: read, schema: { tags: ['assets'] } }, async (_req, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="assets-import-template.csv"');
    const example = { tag: 'AST-000001', name: 'Core switch 1', category: 'network_switch', status: 'in_use', site: 'HQ', manufacturer: 'Cisco', model: 'C9300-48P', serialNumber: 'FOC1234X0AB', purchaseDate: '2024-01-15', purchaseCost: '450000', vendor: 'Reseller Ltd', warrantyStart: '2024-01-15', warrantyEnd: '2027-01-14', amcStart: '', amcEnd: '', location: 'Server room, rack A2', notes: '' };
    return reply.send(stringify([example], { header: true, columns: [...ASSET_IMPORT_COLUMNS] }));
  });

  r.post('/assets/import', { preHandler: manage, schema: { tags: ['assets'], querystring: z.object({ customerId: z.string().uuid().optional() }) } }, h(async (ctx, req) => {
    const { buffer, fields } = await readCsvUpload(req as never);
    const customerId = (req.query as { customerId?: string }).customerId ?? fields.customerId;
    if (!customerId || !z.string().uuid().safeParse(customerId).success) throw new ValidationError('customerId is required');
    return svc.importAssets(ctx, customerId, buffer);
  }));

  r.get('/assets/:id', { preHandler: read, schema: { tags: ['assets'], params: idParam } }, h((ctx, req) => svc.getAsset(ctx, (req.params as { id: string }).id)));
  r.post('/assets', { preHandler: manage, schema: { tags: ['assets'], body: assetCreateBody } }, h((ctx, req) => svc.createAsset(ctx, req.body as z.infer<typeof assetCreateBody>)));
  r.patch('/assets/:id', { preHandler: manage, schema: { tags: ['assets'], params: idParam, body: assetPatchBody } }, h((ctx, req) => svc.updateAsset(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof assetPatchBody>)));
  r.delete('/assets/:id', { preHandler: manage, schema: { tags: ['assets'], params: idParam } }, h((ctx, req) => svc.deleteAsset(ctx, (req.params as { id: string }).id)));

  r.post('/assets/:id/link-ci', { preHandler: manage, schema: { tags: ['assets'], params: idParam, body: z.object({ ciId: z.string().uuid() }) } }, h((ctx, req) => svc.linkCi(ctx, (req.params as { id: string }).id, (req.body as { ciId: string }).ciId)));
  r.post('/assets/:id/unlink-ci', { preHandler: manage, schema: { tags: ['assets'], params: idParam } }, h((ctx, req) => svc.unlinkCi(ctx, (req.params as { id: string }).id)));
  r.post('/assets/:id/create-ci', { preHandler: manage, schema: { tags: ['assets'], params: idParam, body: z.object({ typeId: z.string().uuid() }) } }, h((ctx, req) => svc.createCiFromAsset(ctx, (req.params as { id: string }).id, (req.body as { typeId: string }).typeId)));
  r.post('/assets/:id/lifecycle', { preHandler: manage, schema: { tags: ['assets'], params: idParam, body: lifecycleBody } }, h((ctx, req) => {
    const b = req.body as z.infer<typeof lifecycleBody>;
    return svc.changeLifecycle(ctx, (req.params as { id: string }).id, b.stage, b.notes);
  }));
}
