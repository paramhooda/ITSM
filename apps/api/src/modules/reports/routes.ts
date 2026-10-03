import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as sch from './schedules';
import { scheduleInput, schedulePatch } from './schedules';
import { REPORT_FORMATS } from './service';

const idParam = z.object({ id: z.string().uuid() });
const tags = ['reports'];
const uuid = z.string().uuid();
const boolQuery = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

const runBody = z.object({ reportKey: z.string().min(1).max(100), parameters: z.record(z.string(), z.unknown()).default({}), format: z.enum(REPORT_FORMATS).default('json'), portalVisible: z.boolean().optional() });
const runsQuery = z.object({ reportKey: z.string().max(100).optional(), customerId: uuid.optional(), scheduleId: uuid.optional(), status: z.string().max(20).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) });
const schedulesQuery = z.object({ customerId: uuid.optional(), reportKey: z.string().max(100).optional(), isActive: boolQuery.optional() });
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/reports/definitions', { preHandler: app.auth('reports:run', 'portal:reports'), schema: { tags } }, h((ctx) => svc.listDefinitions(ctx)));

  r.post('/reports/run', { preHandler: app.auth('reports:run', 'portal:reports'), schema: { tags, body: runBody } }, h((ctx, req) => {
    const b = req.body as z.infer<typeof runBody>;
    // Portal users may only create portal-visible runs; the service pins their customer.
    return svc.runReport(ctx, { reportKey: b.reportKey, parameters: b.parameters, format: b.format, portalVisible: ctx.user.userType === 'customer' ? true : b.portalVisible });
  }));

  r.get('/reports/runs', { preHandler: app.auth('reports:run', 'portal:reports'), schema: { tags, querystring: runsQuery } }, h((ctx, req) => svc.listRuns(ctx, req.query as z.infer<typeof runsQuery>)));
  r.get('/reports/runs/:id', { preHandler: app.auth('reports:run', 'portal:reports'), schema: { tags, params: idParam } }, h((ctx, req) => svc.getRun(ctx, (req.params as { id: string }).id)));
  r.patch('/reports/runs/:id', { preHandler: app.auth('reports:manage'), schema: { tags, params: idParam, body: z.object({ portalVisible: z.boolean() }) } }, h((ctx, req) => svc.updateRun(ctx, (req.params as { id: string }).id, req.body as { portalVisible: boolean })));
  r.delete('/reports/runs/:id', { preHandler: app.auth('reports:manage'), schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteRun(ctx, (req.params as { id: string }).id)));

  // ---- schedules (reports:manage)
  r.get('/reports/schedules', { preHandler: app.auth('reports:manage'), schema: { tags, querystring: schedulesQuery } }, h((ctx, req) => sch.listSchedules(ctx, req.query as z.infer<typeof schedulesQuery>)));
  r.post('/reports/schedules', { preHandler: app.auth('reports:manage'), schema: { tags, body: scheduleInput } }, h((ctx, req) => sch.createSchedule(ctx, req.body as z.infer<typeof scheduleInput>)));
  r.get('/reports/schedules/:id', { preHandler: app.auth('reports:manage'), schema: { tags, params: idParam } }, h((ctx, req) => sch.getSchedule(ctx, (req.params as { id: string }).id)));
  r.patch('/reports/schedules/:id', { preHandler: app.auth('reports:manage'), schema: { tags, params: idParam, body: schedulePatch } }, h((ctx, req) => sch.updateSchedule(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof schedulePatch>)));
  r.delete('/reports/schedules/:id', { preHandler: app.auth('reports:manage'), schema: { tags, params: idParam } }, h((ctx, req) => sch.deleteSchedule(ctx, (req.params as { id: string }).id)));
  r.post('/reports/schedules/:id/run-now', { preHandler: app.auth('reports:manage'), schema: { tags, params: idParam } }, h((ctx, req) => sch.runScheduleNow(ctx, (req.params as { id: string }).id)));

  // ---- metric rollups maintenance (admin:system)
  r.post('/reports/rollups/backfill', { preHandler: app.auth('admin:system'), schema: { tags, body: z.object({ from: dateStr, to: dateStr }) } }, h((ctx, req) => {
    const b = req.body as { from: string; to: string };
    return svc.enqueueBackfill(ctx, b.from, b.to);
  }));
  r.post('/reports/rollups/recompute', { preHandler: app.auth('admin:system'), schema: { tags } }, h((ctx) => svc.enqueueRecompute(ctx)));
}
