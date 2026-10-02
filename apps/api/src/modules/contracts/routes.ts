import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as ent from './entitlements';
import * as scope from './scope';
import { contractCreate, contractPatch, contractListQuery, contractSummaryQuery, contractServiceInput, entitlementInput, consumptionInput, scopeItemInput, renewInput, uuid, boolQuery, dateStr } from './schemas';

const idParam = z.object({ id: z.string().uuid() });
const tags = ['contracts'];

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---- collection routes (static paths before /contracts/:id)
  r.get('/contracts', { preHandler: app.auth('contracts:read'), schema: { tags, querystring: contractListQuery } }, h((ctx, req) => svc.listContracts(ctx, req.query as z.infer<typeof contractListQuery>)));

  r.get('/contracts/summary', { preHandler: app.auth('contracts:read'), schema: { tags, querystring: contractSummaryQuery } }, h((ctx, req) => svc.contractSummary(ctx, req.query as z.infer<typeof contractSummaryQuery>)));

  r.get('/contracts/expiring', { preHandler: app.auth('contracts:read'), schema: { tags, querystring: z.object({ days: z.coerce.number().int().min(0).max(3650).default(90), customerId: uuid.optional() }) } }, h((ctx, req) => {
    const q = req.query as { days: number; customerId?: string };
    return svc.expiringContracts(ctx, q.days, q.customerId);
  }));

  r.get('/contracts/entitlements/summary', { preHandler: app.auth('contracts:read'), schema: { tags, querystring: z.object({ customerId: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }) } }, h((ctx, req) => {
    const q = req.query as { customerId?: string; limit: number };
    return ent.entitlementSummary(ctx, q.customerId, q.limit);
  }));

  r.post('/contracts/scope/evaluate', {
    preHandler: app.auth('contracts:read', 'tickets:read', 'tickets:create'),
    schema: { tags, body: z.object({ customerId: uuid, serviceId: uuid.nullable().optional(), siteId: uuid.nullable().optional(), ticketCategoryId: uuid.nullable().optional(), ciTypeKey: z.string().max(64).nullable().optional() }) },
  }, h((ctx, req) => scope.evaluateScopeForCustomer(ctx, req.body as { customerId: string; serviceId?: string | null; siteId?: string | null; ticketCategoryId?: string | null; ciTypeKey?: string | null })));

  r.post('/contracts', { preHandler: app.auth('contracts:manage'), schema: { tags, body: contractCreate } }, h((ctx, req) => svc.createContract(ctx, req.body as z.infer<typeof contractCreate>)));

  // ---- single contract
  r.get('/contracts/:id', { preHandler: app.auth('contracts:read'), schema: { tags, params: idParam } }, h((ctx, req) => svc.getContract(ctx, (req.params as { id: string }).id)));
  r.patch('/contracts/:id', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam, body: contractPatch } }, h((ctx, req) => svc.updateContract(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof contractPatch>)));
  r.delete('/contracts/:id', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteContract(ctx, (req.params as { id: string }).id)));

  r.put('/contracts/:id/services', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam, body: z.object({ services: z.array(contractServiceInput) }) } }, h((ctx, req) => svc.setContractServices(ctx, (req.params as { id: string }).id, (req.body as { services: z.infer<typeof contractServiceInput>[] }).services)));
  r.put('/contracts/:id/sites', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam, body: z.object({ siteIds: z.array(uuid) }) } }, h((ctx, req) => svc.setContractSites(ctx, (req.params as { id: string }).id, (req.body as { siteIds: string[] }).siteIds)));

  r.post('/contracts/:id/activate', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam } }, h((ctx, req) => svc.activateContract(ctx, (req.params as { id: string }).id)));
  r.post('/contracts/:id/terminate', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam, body: z.object({ reason: z.string().max(2000).nullable().optional(), effectiveDate: dateStr.nullable().optional() }).optional() } }, h((ctx, req) => svc.terminateContract(ctx, (req.params as { id: string }).id, (req.body ?? {}) as { reason?: string | null; effectiveDate?: string | null })));
  r.post('/contracts/:id/renew', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam, body: renewInput } }, h((ctx, req) => svc.renewContract(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof renewInput>)));

  r.get('/contracts/:id/history', { preHandler: app.auth('contracts:read'), schema: { tags, params: idParam, querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }) } }, h((ctx, req) => svc.contractHistory(ctx, (req.params as { id: string }).id, (req.query as { limit: number }).limit)));

  // ---- entitlements
  r.get('/contracts/:id/entitlements', { preHandler: app.auth('contracts:read'), schema: { tags, params: idParam, querystring: z.object({ includeInactive: boolQuery.optional() }) } }, h((ctx, req) => ent.listEntitlements(ctx, (req.params as { id: string }).id, (req.query as { includeInactive?: boolean }).includeInactive ?? false)));
  r.post('/contracts/:id/entitlements', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam, body: entitlementInput } }, h((ctx, req) => ent.createEntitlement(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof entitlementInput>)));
  r.get('/entitlements/:id', { preHandler: app.auth('contracts:read'), schema: { tags, params: idParam } }, h((ctx, req) => ent.getEntitlement(ctx, (req.params as { id: string }).id)));
  r.patch('/entitlements/:id', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam, body: entitlementInput.partial() } }, h((ctx, req) => ent.updateEntitlement(ctx, (req.params as { id: string }).id, req.body as Partial<z.infer<typeof entitlementInput>>)));
  r.delete('/entitlements/:id', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam } }, h((ctx, req) => ent.deleteEntitlement(ctx, (req.params as { id: string }).id)));
  r.get('/entitlements/:id/consumptions', { preHandler: app.auth('contracts:read'), schema: { tags, params: idParam, querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }) } }, h((ctx, req) => ent.listConsumptions(ctx, (req.params as { id: string }).id, (req.query as { limit: number }).limit)));
  r.post('/entitlements/:id/consume', { preHandler: app.auth('contracts:manage', 'field:execute'), schema: { tags, params: idParam, body: consumptionInput } }, h((ctx, req) => ent.recordConsumption(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof consumptionInput>)));
  r.delete('/entitlement-consumptions/:id', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam } }, h((ctx, req) => ent.deleteConsumption(ctx, (req.params as { id: string }).id)));

  // ---- scope
  r.get('/contracts/:id/scope', { preHandler: app.auth('contracts:read'), schema: { tags, params: idParam } }, h((ctx, req) => scope.listScopeItems(ctx, (req.params as { id: string }).id)));
  r.post('/contracts/:id/scope', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam, body: scopeItemInput } }, h((ctx, req) => scope.createScopeItem(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof scopeItemInput>)));
  r.post('/contracts/:id/scope/bulk', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam, body: z.object({ items: z.array(scopeItemInput).min(1).max(500) }) } }, h((ctx, req) => scope.bulkCreateScopeItems(ctx, (req.params as { id: string }).id, (req.body as { items: z.infer<typeof scopeItemInput>[] }).items)));
  r.patch('/scope-items/:id', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam, body: scopeItemInput.partial() } }, h((ctx, req) => scope.updateScopeItem(ctx, (req.params as { id: string }).id, req.body as Partial<z.infer<typeof scopeItemInput>>)));
  r.delete('/scope-items/:id', { preHandler: app.auth('contracts:manage'), schema: { tags, params: idParam } }, h((ctx, req) => scope.deleteScopeItem(ctx, (req.params as { id: string }).id)));
}
