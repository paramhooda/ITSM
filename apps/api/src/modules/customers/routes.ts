import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as sites from './sites';
import * as contacts from './contacts';
import { customerEntitlements } from '@/modules/contracts/entitlements';
import { customerScope } from '@/modules/contracts/scope';
import { listContracts } from '@/modules/contracts/service';
import { customerCreate, customerPatch, customerListQuery, siteInput, contactInput, uuid } from './schemas';

const idParam = z.object({ id: z.string().uuid() });
const tags = ['customers'];
const includeInactive = z.object({ includeInactive: z.enum(['true', 'false']).optional() });
const inactive = (q: unknown) => (q as { includeInactive?: string }).includeInactive === 'true';

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // The minimal picker (`fields=min`) is available to every operational role; the full list needs customers:read.
  r.get('/customers', { preHandler: app.auth('customers:read', 'tickets:read', 'contracts:read', 'assets:read', 'cmdb:read', 'field:read', 'pm:read', 'reports:run', 'admin:users'), schema: { tags, querystring: customerListQuery } }, h((ctx, req) => svc.listCustomers(ctx, req.query as z.infer<typeof customerListQuery>)));
  r.post('/customers', { preHandler: app.auth('customers:manage'), schema: { tags, body: customerCreate } }, h((ctx, req) => svc.createCustomer(ctx, req.body as z.infer<typeof customerCreate>)));

  r.get('/customers/:id', { preHandler: app.auth('customers:read'), schema: { tags, params: idParam } }, h((ctx, req) => svc.getCustomer(ctx, (req.params as { id: string }).id)));
  r.patch('/customers/:id', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam, body: customerPatch } }, h((ctx, req) => svc.updateCustomer(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof customerPatch>)));
  r.post('/customers/:id/deactivate', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam, body: z.object({ reason: z.string().max(1000).nullable().optional() }).optional() } }, h((ctx, req) => svc.deactivateCustomer(ctx, (req.params as { id: string }).id, (req.body as { reason?: string | null } | undefined)?.reason)));
  r.post('/customers/:id/reactivate', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam } }, h((ctx, req) => svc.reactivateCustomer(ctx, (req.params as { id: string }).id)));
  r.delete('/customers/:id', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteCustomer(ctx, (req.params as { id: string }).id)));

  r.get('/customers/:id/overview', { preHandler: app.auth('customers:read'), schema: { tags, params: idParam } }, h((ctx, req) => svc.customerOverview(ctx, (req.params as { id: string }).id)));
  r.get('/customers/:id/tickets', { preHandler: app.auth('customers:read'), schema: { tags, params: idParam, querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) } }, h((ctx, req) => svc.customerTickets(ctx, (req.params as { id: string }).id, (req.query as { limit: number }).limit)));
  r.get('/customers/:id/contracts', { preHandler: app.auth('contracts:read'), schema: { tags, params: idParam } }, h((ctx, req) => listContracts(ctx, { page: 1, pageSize: 200, sort: 'endDate', order: 'asc', customerId: (req.params as { id: string }).id })));
  r.get('/customers/:id/entitlements', { preHandler: app.auth('contracts:read', 'customers:read'), schema: { tags, params: idParam, querystring: z.object({ includeInactiveContracts: z.enum(['true', 'false']).optional() }) } }, h((ctx, req) => customerEntitlements(ctx, (req.params as { id: string }).id, (req.query as { includeInactiveContracts?: string }).includeInactiveContracts === 'true')));
  r.get('/customers/:id/scope', { preHandler: app.auth('contracts:read', 'customers:read'), schema: { tags, params: idParam } }, h((ctx, req) => customerScope(ctx, (req.params as { id: string }).id)));

  // ---- sites
  r.get('/customers/:id/sites', { preHandler: app.auth('customers:read'), schema: { tags, params: idParam, querystring: includeInactive } }, h((ctx, req) => sites.listSites(ctx, (req.params as { id: string }).id, inactive(req.query))));
  r.post('/customers/:id/sites', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam, body: siteInput } }, h((ctx, req) => sites.createSite(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof siteInput>)));
  r.get('/sites/:id', { preHandler: app.auth('customers:read'), schema: { tags, params: idParam } }, h((ctx, req) => sites.getSite(ctx, (req.params as { id: string }).id)));
  r.patch('/sites/:id', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam, body: siteInput.partial() } }, h((ctx, req) => sites.updateSite(ctx, (req.params as { id: string }).id, req.body as Partial<z.infer<typeof siteInput>>)));
  r.delete('/sites/:id', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam } }, h((ctx, req) => sites.deleteSite(ctx, (req.params as { id: string }).id)));

  // ---- contacts
  r.get('/customers/:id/contacts', { preHandler: app.auth('customers:read'), schema: { tags, params: idParam, querystring: includeInactive } }, h((ctx, req) => contacts.listContacts(ctx, (req.params as { id: string }).id, inactive(req.query))));
  r.get('/customers/:id/escalation-contacts', { preHandler: app.auth('customers:read'), schema: { tags, params: idParam } }, h((ctx, req) => contacts.escalationContacts(ctx, (req.params as { id: string }).id)));
  r.post('/customers/:id/contacts', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam, body: contactInput } }, h((ctx, req) => contacts.createContact(ctx, (req.params as { id: string }).id, req.body as z.infer<typeof contactInput>)));
  r.patch('/contacts/:id', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam, body: contactInput.partial() } }, h((ctx, req) => contacts.updateContact(ctx, (req.params as { id: string }).id, req.body as Partial<z.infer<typeof contactInput>>)));
  r.delete('/contacts/:id', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam } }, h((ctx, req) => contacts.deleteContact(ctx, (req.params as { id: string }).id)));

  // ---- teams / users / documents
  r.get('/customers/:id/teams', { preHandler: app.auth('customers:read'), schema: { tags, params: idParam } }, h((ctx, req) => svc.getCustomerTeams(ctx, (req.params as { id: string }).id)));
  r.put('/customers/:id/teams', { preHandler: app.auth('customers:manage'), schema: { tags, params: idParam, body: z.object({ teamIds: z.array(uuid) }) } }, h((ctx, req) => svc.setCustomerTeams(ctx, (req.params as { id: string }).id, (req.body as { teamIds: string[] }).teamIds)));
  r.get('/customers/:id/users', { preHandler: app.auth('customers:read'), schema: { tags, params: idParam } }, h((ctx, req) => svc.customerUsers(ctx, (req.params as { id: string }).id)));
  r.get('/customers/:id/documents', { preHandler: app.auth('customers:read'), schema: { tags, params: idParam } }, h((ctx, req) => svc.customerDocuments(ctx, (req.params as { id: string }).id)));
}
