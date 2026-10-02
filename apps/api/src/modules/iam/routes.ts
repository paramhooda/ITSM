import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import { paginationSchema } from '@/core/pagination';
import * as svc from './service';

const idParam = z.object({ id: z.string().uuid() });

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---- users
  r.get('/iam/users', {
    preHandler: app.auth('admin:users', 'portal:manage_users'),
    schema: { tags: ['iam'], querystring: paginationSchema.extend({ q: z.string().optional(), userType: z.enum(['msp', 'customer']).optional(), customerId: z.string().uuid().optional(), status: z.string().optional(), teamId: z.string().uuid().optional(), roleKey: z.string().optional(), sort: z.string().optional(), order: z.enum(['asc', 'desc']).optional() }) },
  }, h((ctx, req) => svc.listUsers(ctx, req.query as svc.UserFilters)));

  r.get('/iam/users/:id', { preHandler: app.auth('admin:users', 'portal:manage_users'), schema: { tags: ['iam'], params: idParam } }, h((ctx, req) => svc.getUser(ctx, (req.params as { id: string }).id)));

  r.post('/iam/users', {
    preHandler: app.auth('admin:users', 'portal:manage_users'),
    schema: {
      tags: ['iam'],
      body: z.object({
        email: z.string().email(),
        name: z.string().min(1).max(200),
        phone: z.string().max(50).optional(),
        title: z.string().max(100).optional(),
        userType: z.enum(['msp', 'customer']),
        customerId: z.string().uuid().nullable().optional(),
        timezone: z.string().max(64).optional(),
        password: z.string().min(10).optional(),
        roleIds: z.array(z.object({ roleId: z.string().uuid(), customerId: z.string().uuid().nullable().optional() })).optional(),
        teamIds: z.array(z.string().uuid()).optional(),
        customerAccess: z.array(z.string().uuid()).optional(),
        sendWelcome: z.boolean().optional(),
      }),
    },
  }, h((ctx, req) => {
    const body = req.body as svc.CreateUserInput;
    if (!ctx.can('admin:users')) {
      // Customer administrators may only create portal users for their own organization.
      body.userType = 'customer';
      body.customerId = ctx.user.customerId;
      body.teamIds = [];
      body.customerAccess = [];
    }
    return svc.createUser(ctx, body);
  }));

  r.patch('/iam/users/:id', {
    preHandler: app.auth('admin:users', 'portal:manage_users'),
    schema: { tags: ['iam'], params: idParam, body: z.object({ name: z.string().min(1).max(200).optional(), phone: z.string().max(50).nullable().optional(), title: z.string().max(100).nullable().optional(), timezone: z.string().max(64).optional(), status: z.enum(['active', 'disabled']).optional(), customerId: z.string().uuid().optional() }) },
  }, h((ctx, req) => svc.updateUser(ctx, (req.params as { id: string }).id, req.body as never)));

  r.post('/iam/users/:id/reset-password', {
    preHandler: app.auth('admin:users', 'portal:manage_users'),
    schema: { tags: ['iam'], params: idParam, body: z.object({ password: z.string().min(10).optional() }).optional() },
  }, h((ctx, req) => svc.adminResetPassword(ctx, (req.params as { id: string }).id, (req.body as { password?: string } | undefined)?.password)));

  r.put('/iam/users/:id/roles', {
    preHandler: app.auth('admin:users', 'portal:manage_users'),
    schema: { tags: ['iam'], params: idParam, body: z.object({ assignments: z.array(z.object({ roleId: z.string().uuid(), customerId: z.string().uuid().nullable().optional() })) }) },
  }, h(async (ctx, req) => {
    await svc.setUserRoles(ctx, (req.params as { id: string }).id, (req.body as { assignments: { roleId: string; customerId?: string | null }[] }).assignments);
    return svc.getUser(ctx, (req.params as { id: string }).id);
  }));

  r.put('/iam/users/:id/teams', {
    preHandler: app.auth('admin:users'),
    schema: { tags: ['iam'], params: idParam, body: z.object({ teamIds: z.array(z.string().uuid()) }) },
  }, h(async (ctx, req) => {
    await svc.setUserTeams(ctx, (req.params as { id: string }).id, (req.body as { teamIds: string[] }).teamIds);
    return svc.getUser(ctx, (req.params as { id: string }).id);
  }));

  r.put('/iam/users/:id/customers', {
    preHandler: app.auth('admin:users'),
    schema: { tags: ['iam'], params: idParam, body: z.object({ customerIds: z.array(z.string().uuid()) }) },
  }, h(async (ctx, req) => {
    await svc.setUserCustomerAccess(ctx, (req.params as { id: string }).id, (req.body as { customerIds: string[] }).customerIds);
    return svc.getUser(ctx, (req.params as { id: string }).id);
  }));

  // ---- roles & permissions
  r.get('/iam/permissions', { preHandler: app.auth('admin:users', 'portal:manage_users'), schema: { tags: ['iam'] } }, async () => ({ modules: svc.permissionCatalog() }));
  r.get('/iam/roles', { preHandler: app.auth('admin:users', 'portal:manage_users', 'tickets:assign'), schema: { tags: ['iam'] } }, h((ctx) => svc.listRoles(ctx)));
  r.post('/iam/roles', {
    preHandler: app.auth('admin:users'),
    schema: { tags: ['iam'], body: z.object({ key: z.string().regex(/^[a-z0-9_]+$/).max(64), name: z.string().min(1).max(120), description: z.string().max(500).optional(), userType: z.enum(['msp', 'customer']), permissions: z.array(z.string()) }) },
  }, h((ctx, req) => svc.createRole(ctx, req.body as never)));
  r.patch('/iam/roles/:id', {
    preHandler: app.auth('admin:users'),
    schema: { tags: ['iam'], params: idParam, body: z.object({ name: z.string().min(1).max(120).optional(), description: z.string().max(500).optional(), permissions: z.array(z.string()).optional() }) },
  }, h((ctx, req) => svc.updateRole(ctx, (req.params as { id: string }).id, req.body as never)));
  r.delete('/iam/roles/:id', { preHandler: app.auth('admin:users'), schema: { tags: ['iam'], params: idParam } }, h(async (ctx, req) => {
    await svc.deleteRole(ctx, (req.params as { id: string }).id);
    return { ok: true };
  }));

  // ---- teams
  r.get('/iam/teams', { preHandler: app.auth(), schema: { tags: ['iam'] } }, h((ctx) => svc.listTeams(ctx)));
  r.post('/iam/teams', {
    preHandler: app.auth('admin:users'),
    schema: { tags: ['iam'], body: z.object({ key: z.string().regex(/^[a-z0-9_]+$/).max(64), name: z.string().min(1).max(120), description: z.string().max(500).optional(), teamType: z.string().max(64).optional(), email: z.string().email().optional(), managerUserId: z.string().uuid().nullable().optional() }) },
  }, h((ctx, req) => svc.createTeam(ctx, req.body as never)));
  r.patch('/iam/teams/:id', {
    preHandler: app.auth('admin:users'),
    schema: { tags: ['iam'], params: idParam, body: z.object({ name: z.string().min(1).max(120).optional(), description: z.string().max(500).nullable().optional(), teamType: z.string().max(64).optional(), email: z.string().email().nullable().optional(), managerUserId: z.string().uuid().nullable().optional(), isActive: z.boolean().optional() }) },
  }, h((ctx, req) => svc.updateTeam(ctx, (req.params as { id: string }).id, req.body as never)));
  r.put('/iam/teams/:id/members', {
    preHandler: app.auth('admin:users'),
    schema: { tags: ['iam'], params: idParam, body: z.object({ members: z.array(z.object({ userId: z.string().uuid(), isLead: z.boolean().optional() })) }) },
  }, h(async (ctx, req) => {
    await svc.setTeamMembers(ctx, (req.params as { id: string }).id, (req.body as { members: { userId: string; isLead?: boolean }[] }).members);
    return { ok: true };
  }));
  r.delete('/iam/teams/:id', { preHandler: app.auth('admin:users'), schema: { tags: ['iam'], params: idParam } }, h(async (ctx, req) => {
    await svc.deleteTeam(ctx, (req.params as { id: string }).id);
    return { ok: true };
  }));

  // ---- API keys
  r.get('/iam/api-keys', { preHandler: app.auth('integrations:manage'), schema: { tags: ['iam'] } }, h((ctx) => svc.listApiKeys(ctx)));
  r.post('/iam/api-keys', {
    preHandler: app.auth('integrations:manage'),
    schema: { tags: ['iam'], body: z.object({ name: z.string().min(1).max(120), permissions: z.array(z.string()), customerId: z.string().uuid().nullable().optional(), expiresAt: z.string().nullable().optional() }) },
  }, h((ctx, req) => svc.createApiKey(ctx, req.body as never)));
  r.delete('/iam/api-keys/:id', { preHandler: app.auth('integrations:manage'), schema: { tags: ['iam'], params: idParam } }, h(async (ctx, req) => {
    await svc.revokeApiKey(ctx, (req.params as { id: string }).id);
    return { ok: true };
  }));

  // ---- directory (pickers)
  r.get('/iam/directory/engineers', { preHandler: app.auth('tickets:read', 'field:read', 'admin:users'), schema: { tags: ['iam'], querystring: z.object({ q: z.string().optional() }) } }, h((ctx, req) => svc.engineerDirectory(ctx, (req.query as { q?: string }).q)));
}
