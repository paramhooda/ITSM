import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';

const idParam = z.object({ id: z.string().uuid() });

const formField = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  type: z.enum(svc.FORM_FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string().max(200)).optional(),
  helpText: z.string().max(500).optional(),
  placeholder: z.string().max(200).optional(),
});

const itemBody = z.object({
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  formSchema: z.array(formField).optional(),
  slaPolicyId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  approvalWorkflowId: z.string().uuid().nullable().optional(),
  ticketCategoryId: z.string().uuid().nullable().optional(),
  defaultPriorityId: z.string().uuid().nullable().optional(),
  serviceId: z.string().uuid().nullable().optional(),
  fulfilmentInstructions: z.string().max(10000).nullable().optional(),
  customerIds: z.array(z.string().uuid()).optional(),
  portalVisible: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/** Service request catalog (readable by every authenticated user incl. portal users; managed with admin:config). */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/catalog/items', {
    preHandler: app.auth(),
    schema: { tags: ['catalog'], querystring: z.object({ portal: z.coerce.boolean().optional(), customerId: z.string().uuid().optional(), categoryId: z.string().uuid().optional(), active: z.coerce.boolean().optional(), q: z.string().optional() }) },
  }, h((ctx, req) => svc.listItems(ctx, req.query as svc.ListFilters)));

  r.get('/catalog/items/:id', { preHandler: app.auth(), schema: { tags: ['catalog'], params: idParam } }, h((ctx, req) => svc.getItem(ctx, (req.params as { id: string }).id)));

  r.post('/catalog/items', { preHandler: app.auth('admin:config'), schema: { tags: ['catalog'], body: itemBody } }, h((ctx, req) => svc.createItem(ctx, req.body as svc.CatalogItemInput)));

  r.patch('/catalog/items/:id', { preHandler: app.auth('admin:config'), schema: { tags: ['catalog'], params: idParam, body: itemBody.partial() } }, h((ctx, req) => svc.updateItem(ctx, (req.params as { id: string }).id, req.body as Partial<svc.CatalogItemInput>)));

  r.delete('/catalog/items/:id', { preHandler: app.auth('admin:config'), schema: { tags: ['catalog'], params: idParam } }, h((ctx, req) => svc.deleteItem(ctx, (req.params as { id: string }).id)));

  r.post('/catalog/items/:id/clone', { preHandler: app.auth('admin:config'), schema: { tags: ['catalog'], params: idParam, body: z.object({ key: z.string().max(64).optional(), name: z.string().max(200).optional() }).optional() } }, h((ctx, req) => svc.cloneItem(ctx, (req.params as { id: string }).id, (req.body as { key?: string; name?: string } | undefined) ?? {})));

  r.post('/catalog/items/reorder', { preHandler: app.auth('admin:config'), schema: { tags: ['catalog'], body: z.object({ ids: z.array(z.string().uuid()) }) } }, h((ctx, req) => svc.reorderItems(ctx, (req.body as { ids: string[] }).ids)));
}
