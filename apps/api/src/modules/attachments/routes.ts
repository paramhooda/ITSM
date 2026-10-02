import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import { ValidationError } from '@/core/errors';
import * as svc from './service';

const idParam = z.object({ id: z.string().uuid() });
const boolish = z.preprocess((v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) : v), z.boolean());

const uploadFields = z.object({
  entityType: z.enum(svc.ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  customerVisible: boolish.optional(),
  docType: z.enum(svc.DOC_TYPES).optional(),
  title: z.string().max(200).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

const patchBody = z.object({
  customerVisible: z.boolean().optional(),
  title: z.string().max(200).nullable().optional(),
  docType: z.enum(svc.DOC_TYPES).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Multipart upload: `file` plus text fields (entityType, entityId, customerVisible, docType, title). */
  r.post('/attachments', { preHandler: app.auth(), schema: { tags: ['attachments'], consumes: ['multipart/form-data'] } }, h(async (ctx, req) => {
    if (!req.isMultipart()) throw new ValidationError('Expected multipart/form-data');
    const fields: Record<string, string> = {};
    let file: { filename: string; mimetype: string; buffer: Buffer } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (file) {
          // Only one file per request; drain extra files so the stream completes.
          await part.toBuffer();
          throw new ValidationError('Upload one file per request');
        }
        const buffer = await part.toBuffer();
        file = { filename: part.filename, mimetype: part.mimetype, buffer };
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
    if (!file) throw new ValidationError('No file provided (field name "file")');
    const parsed = uploadFields.safeParse(fields);
    if (!parsed.success) throw new ValidationError('Invalid upload fields', parsed.error.issues);
    const f = parsed.data;
    const uploaded = file as { filename: string; mimetype: string; buffer: Buffer };
    return svc.createAttachment(ctx, {
      entityType: f.entityType,
      entityId: f.entityId,
      filename: uploaded.filename,
      contentType: uploaded.mimetype,
      buffer: uploaded.buffer,
      customerId: f.customerId ?? null,
      customerVisible: f.customerVisible,
      docType: f.docType,
      title: f.title,
      expiresAt: f.expiresAt ? new Date(f.expiresAt) : null,
    });
  }));

  r.get('/attachments', {
    preHandler: app.auth(),
    schema: { tags: ['attachments'], querystring: z.object({ entityType: z.enum(svc.ATTACHMENT_ENTITY_TYPES), entityId: z.string().uuid() }) },
  }, h((ctx, req) => {
    const q = req.query as { entityType: string; entityId: string };
    return svc.listAttachments(ctx, q.entityType, q.entityId);
  }));

  r.get('/attachments/:id', { preHandler: app.auth(), schema: { tags: ['attachments'], params: idParam } }, h((ctx, req) => svc.getAttachment(ctx, (req.params as { id: string }).id)));

  r.get('/attachments/:id/download', { preHandler: app.auth(), schema: { tags: ['attachments'], params: idParam } }, h(async (ctx, req, reply) => {
    const { meta, stream } = await svc.openAttachment(ctx, (req.params as { id: string }).id);
    reply
      .header('Content-Type', meta.contentType)
      .header('Content-Length', String(meta.size))
      .header('Content-Disposition', svc.contentDisposition(meta.filename, meta.contentType))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=0, no-store');
    return reply.send(stream);
  }));

  r.patch('/attachments/:id', { preHandler: app.auth(), schema: { tags: ['attachments'], params: idParam, body: patchBody } }, h((ctx, req) => {
    const b = req.body as z.infer<typeof patchBody>;
    return svc.updateAttachment(ctx, (req.params as { id: string }).id, {
      customerVisible: b.customerVisible,
      title: b.title,
      docType: b.docType,
      expiresAt: b.expiresAt === undefined ? undefined : b.expiresAt ? new Date(b.expiresAt) : null,
    });
  }));

  r.delete('/attachments/:id', { preHandler: app.auth(), schema: { tags: ['attachments'], params: idParam } }, h((ctx, req) => svc.deleteAttachment(ctx, (req.params as { id: string }).id)));
}
