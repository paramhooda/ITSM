import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SLA_METRICS, TICKET_TYPES } from '@itsm/shared';
import { h } from '@/core/context';
import * as policies from './policies';

const idParam = z.object({ id: z.string().uuid() });

const targetSchema = z.object({
  ticketType: z.enum(TICKET_TYPES),
  priorityId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  metric: z.enum(SLA_METRICS),
  minutes: z.number().int().positive(),
  warnPct: z.number().int().min(1).max(100).optional(),
  calendarTime: z.boolean().optional(),
});

const policyBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  calendarId: z.string().uuid().nullable().optional(),
  holidayCalendarId: z.string().uuid().nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  targets: z.array(targetSchema).optional(),
});

/**
 * SLA module routes: policy administration, preview and compliance figures.
 * Runtime SLA handling for tickets (engine/select) is wired from the tickets module.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/sla/policies', { preHandler: app.auth(), schema: { tags: ['sla'] } }, h((ctx) => policies.listPolicies(ctx)));
  r.get('/sla/policies/:id', { preHandler: app.auth(), schema: { tags: ['sla'], params: idParam } }, h((ctx, req) => policies.getPolicy(ctx, (req.params as { id: string }).id)));

  r.post('/sla/policies', { preHandler: app.auth('admin:config'), schema: { tags: ['sla'], body: policyBody } }, h((ctx, req) => policies.createPolicy(ctx, req.body as policies.PolicyInput)));

  r.patch('/sla/policies/:id', { preHandler: app.auth('admin:config'), schema: { tags: ['sla'], params: idParam, body: policyBody.omit({ targets: true }).partial() } }, h((ctx, req) => policies.updatePolicy(ctx, (req.params as { id: string }).id, req.body as Partial<policies.PolicyInput>)));

  r.put('/sla/policies/:id/targets', { preHandler: app.auth('admin:config'), schema: { tags: ['sla'], params: idParam, body: z.object({ targets: z.array(targetSchema) }) } }, h((ctx, req) => policies.replaceTargets(ctx, (req.params as { id: string }).id, (req.body as { targets: policies.TargetInput[] }).targets)));

  r.put('/sla/policies/:id/pause-statuses', { preHandler: app.auth('admin:config'), schema: { tags: ['sla'], params: idParam, body: z.object({ statusIds: z.array(z.string().uuid()) }) } }, h((ctx, req) => policies.setPauseStatuses(ctx, (req.params as { id: string }).id, (req.body as { statusIds: string[] }).statusIds)));

  r.delete('/sla/policies/:id', { preHandler: app.auth('admin:config'), schema: { tags: ['sla'], params: idParam } }, h((ctx, req) => policies.deletePolicy(ctx, (req.params as { id: string }).id)));

  r.post('/sla/policies/:id/clone', { preHandler: app.auth('admin:config'), schema: { tags: ['sla'], params: idParam, body: z.object({ name: z.string().max(120).optional() }).optional() } }, h((ctx, req) => policies.clonePolicy(ctx, (req.params as { id: string }).id, (req.body as { name?: string } | undefined)?.name)));

  // Contracts mapped to a policy (contract-wide or per-service overrides).
  r.get('/sla/policies/:id/contracts', { preHandler: app.auth('contracts:read'), schema: { tags: ['sla'], params: idParam } }, h((ctx, req) => policies.policyContracts(ctx, (req.params as { id: string }).id)));
  r.post('/sla/policies/:id/contracts', { preHandler: app.auth('contracts:manage'), schema: { tags: ['sla'], params: idParam, body: z.object({ contractIds: z.array(z.string().uuid()).min(1).max(200) }) } }, h((ctx, req) => policies.assignContracts(ctx, (req.params as { id: string }).id, (req.body as { contractIds: string[] }).contractIds)));
  r.delete('/sla/policies/:id/contracts/:contractId', { preHandler: app.auth('contracts:manage'), schema: { tags: ['sla'], params: idParam.extend({ contractId: z.string().uuid() }) } }, h((ctx, req) => policies.unassignContract(ctx, (req.params as { id: string }).id, (req.params as { contractId: string }).contractId)));

  r.get('/sla/policies/:id/compliance', {
    preHandler: app.auth('tickets:read', 'dashboards:management', 'dashboards:noc', 'dashboards:soc', 'reports:run', 'admin:config', 'portal:contracts'),
    schema: { tags: ['sla'], params: idParam, querystring: z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }) },
  }, h((ctx, req) => policies.policyCompliance(ctx, (req.params as { id: string }).id, (req.query as { days?: number }).days ?? 30)));

  r.get('/sla/preview', {
    preHandler: app.auth(),
    schema: { tags: ['sla'], querystring: z.object({ policyId: z.string().uuid(), ticketType: z.enum(TICKET_TYPES).default('incident'), priorityId: z.string().uuid().optional(), start: z.string().optional() }) },
  }, h((ctx, req) => policies.preview(ctx, req.query as { policyId: string; ticketType: 'incident'; priorityId?: string; start?: string })));

  r.get('/sla/compliance', {
    preHandler: app.auth('tickets:read', 'dashboards:management', 'dashboards:noc', 'dashboards:soc', 'reports:run', 'admin:config', 'portal:contracts'),
    schema: { tags: ['sla'], querystring: z.object({ customerId: z.string().uuid().optional(), from: z.string().optional(), to: z.string().optional(), groupBy: z.enum(['metric', 'priority', 'customer', 'service', 'policy', 'ticketType']).optional(), ticketType: z.enum(TICKET_TYPES).optional(), metric: z.enum(SLA_METRICS).optional() }) },
  }, h((ctx, req) => policies.slaCompliance(ctx, req.query as policies.ComplianceParams)));
}
