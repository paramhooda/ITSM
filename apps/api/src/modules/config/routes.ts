import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';

const idParam = z.object({ id: z.string().uuid() });
const kindParam = z.object({ kind: z.string() });

const optionBody = z.object({
  type: z.string(),
  key: z.string().regex(/^[a-z0-9_]+$/).max(64),
  label: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  domain: z.enum(['general', 'noc', 'soc', 'amc', 'service_desk']).optional(),
  statusCategory: z.enum(['new', 'open', 'pending', 'resolved', 'closed', 'cancelled']).nullable().optional(),
  pausesSla: z.boolean().optional(),
  level: z.number().int().nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  sortOrder: z.number().int().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  appliesTo: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/config/lookups', { preHandler: app.auth(), schema: { tags: ['config'] } }, h((ctx) => svc.lookups(ctx)));

  r.get('/config/options', { preHandler: app.auth('admin:config'), schema: { tags: ['config'], querystring: z.object({ type: z.string().optional(), includeInactive: z.coerce.boolean().optional() }) } }, h((ctx, req) => {
    const q = req.query as { type?: string; includeInactive?: boolean };
    return svc.listOptions(ctx, q.type, q.includeInactive ?? true);
  }));
  r.post('/config/options', { preHandler: app.auth('admin:config'), schema: { tags: ['config'], body: optionBody } }, h((ctx, req) => svc.createOption(ctx, req.body as svc.OptionInput)));
  r.patch('/config/options/:id', { preHandler: app.auth('admin:config'), schema: { tags: ['config'], params: idParam, body: optionBody.partial() } }, h((ctx, req) => svc.updateOption(ctx, (req.params as { id: string }).id, req.body as Partial<svc.OptionInput>)));
  r.delete('/config/options/:id', { preHandler: app.auth('admin:config'), schema: { tags: ['config'], params: idParam } }, h((ctx, req) => svc.deleteOption(ctx, (req.params as { id: string }).id)));
  r.post('/config/options/reorder', { preHandler: app.auth('admin:config'), schema: { tags: ['config'], body: z.object({ ids: z.array(z.string().uuid()) }) } }, h(async (ctx, req) => {
    await svc.reorderOptions(ctx, (req.body as { ids: string[] }).ids);
    return { ok: true };
  }));

  r.get('/config/priority-matrix', { preHandler: app.auth(), schema: { tags: ['config'] } }, h((ctx) => svc.getPriorityMatrix(ctx)));
  r.put('/config/priority-matrix', { preHandler: app.auth('admin:config'), schema: { tags: ['config'], body: z.object({ cells: z.array(z.object({ impactId: z.string().uuid(), urgencyId: z.string().uuid(), priorityId: z.string().uuid() })) }) } }, h((ctx, req) => svc.setPriorityMatrix(ctx, (req.body as { cells: { impactId: string; urgencyId: string; priorityId: string }[] }).cells)));

  r.get('/config/settings', { preHandler: app.auth('admin:system', 'admin:config'), schema: { tags: ['config'] } }, h((ctx) => svc.listSettings(ctx)));
  r.put('/config/settings', { preHandler: app.auth('admin:system'), schema: { tags: ['config'], body: z.record(z.string(), z.unknown()) } }, h((ctx, req) => svc.updateSettings(ctx, req.body as Record<string, unknown>)));

  r.get('/config/holiday-calendars/:id/holidays', { preHandler: app.auth(), schema: { tags: ['config'], params: idParam } }, h((ctx, req) => svc.listHolidays(ctx, (req.params as { id: string }).id)));
  r.put('/config/holiday-calendars/:id/holidays', { preHandler: app.auth('admin:config'), schema: { tags: ['config'], params: idParam, body: z.object({ items: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().min(1).max(120) })) }) } }, h((ctx, req) => svc.setHolidays(ctx, (req.params as { id: string }).id, (req.body as { items: { date: string; name: string }[] }).items)));

  // Generic config tables: calendars, holiday-calendars, notification-templates, notification-rules,
  // assignment-rules, escalation-rules, approval-workflows, custom-fields, ci-types, relationship-types
  r.get('/config/:kind', { preHandler: app.auth(), schema: { tags: ['config'], params: kindParam } }, h((ctx, req) => svc.listConfig(ctx, (req.params as { kind: string }).kind)));
  r.post('/config/:kind', { preHandler: app.auth('admin:config'), schema: { tags: ['config'], params: kindParam, body: z.record(z.string(), z.unknown()) } }, h((ctx, req) => svc.createConfig(ctx, (req.params as { kind: string }).kind, req.body as Record<string, unknown>)));
  r.patch('/config/:kind/:id', { preHandler: app.auth('admin:config'), schema: { tags: ['config'], params: kindParam.merge(idParam), body: z.record(z.string(), z.unknown()) } }, h((ctx, req) => svc.updateConfig(ctx, (req.params as { kind: string }).kind, (req.params as { id: string }).id, req.body as Record<string, unknown>)));
  r.delete('/config/:kind/:id', { preHandler: app.auth('admin:config'), schema: { tags: ['config'], params: kindParam.merge(idParam) } }, h(async (ctx, req) => {
    await svc.deleteConfig(ctx, (req.params as { kind: string }).kind, (req.params as { id: string }).id);
    return { ok: true };
  }));
}
