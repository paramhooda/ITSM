import { eq, and, inArray, sql, ilike, or, desc, asc, isNull, getTableColumns } from 'drizzle-orm';
import { ALL_PERMISSIONS, PERMISSION_MODULES, PERMISSIONS, type Permission } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { schema } from '@/db/client';
import { NotFoundError, ValidationError, ConflictError, ForbiddenError } from '@/core/errors';
import { hashPassword, randomToken, sha256 } from '@/lib/crypto';
import { invalidatePrincipal } from '@/core/principal';
import { diffChanges } from '@/core/audit';
import { queueNotification } from '@/modules/notifications/dispatch';
import { config } from '@/config';
import type { Pagination } from '@/core/pagination';

// ---------------------------------------------------------------- users

export interface UserFilters extends Pagination {
  q?: string;
  userType?: 'msp' | 'customer';
  customerId?: string;
  status?: string;
  teamId?: string;
  roleKey?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

const userColumns = {
  id: schema.users.id,
  email: schema.users.email,
  name: schema.users.name,
  phone: schema.users.phone,
  title: schema.users.title,
  userType: schema.users.userType,
  status: schema.users.status,
  customerId: schema.users.customerId,
  timezone: schema.users.timezone,
  lastLoginAt: schema.users.lastLoginAt,
  createdAt: schema.users.createdAt,
  updatedAt: schema.users.updatedAt,
  mfaEnabled: schema.users.mfaEnabled,
  authProvider: schema.users.authProvider,
};

export async function listUsers(ctx: Ctx, f: UserFilters) {
  const conds = [];
  if (f.q) conds.push(or(ilike(schema.users.name, `%${f.q}%`), ilike(schema.users.email, `%${f.q}%`)));
  if (f.userType) conds.push(eq(schema.users.userType, f.userType));
  if (f.customerId) conds.push(eq(schema.users.customerId, f.customerId));
  if (f.status) conds.push(eq(schema.users.status, f.status as 'active'));
  if (f.teamId) conds.push(inArray(schema.users.id, ctx.tx.select({ id: schema.teamMembers.userId }).from(schema.teamMembers).where(eq(schema.teamMembers.teamId, f.teamId))));
  if (f.roleKey) {
    conds.push(
      inArray(
        schema.users.id,
        ctx.tx.select({ id: schema.userRoles.userId }).from(schema.userRoles).innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId)).where(eq(schema.roles.key, f.roleKey)),
      ),
    );
  }
  // Customer-scoped principals only see users of customers they can access.
  if (ctx.user.customerScope !== 'all') {
    conds.push(or(isNull(schema.users.customerId), inArray(schema.users.customerId, ctx.user.customerScope.length ? ctx.user.customerScope : ['00000000-0000-0000-0000-000000000000'])));
  }
  const where = conds.length ? and(...conds) : undefined;
  const sortCol = (f.sort && (userColumns as unknown as Record<string, AnyPgColumn>)[f.sort]) || schema.users.name;
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(schema.users).where(where);
  const items = await ctx.tx
    .select({ ...userColumns, customerName: schema.customers.name })
    .from(schema.users)
    .leftJoin(schema.customers, eq(schema.customers.id, schema.users.customerId))
    .where(where)
    .orderBy(f.order === 'desc' ? desc(sortCol) : asc(sortCol))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  const ids = items.map((u) => u.id);
  const roleRows = ids.length
    ? await ctx.tx
        .select({ userId: schema.userRoles.userId, roleId: schema.roles.id, key: schema.roles.key, name: schema.roles.name, customerId: schema.userRoles.customerId })
        .from(schema.userRoles)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
        .where(inArray(schema.userRoles.userId, ids))
    : [];
  const teamRows = ids.length
    ? await ctx.tx
        .select({ userId: schema.teamMembers.userId, id: schema.teams.id, key: schema.teams.key, name: schema.teams.name, isLead: schema.teamMembers.isLead })
        .from(schema.teamMembers)
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
        .where(inArray(schema.teamMembers.userId, ids))
    : [];
  return {
    items: items.map((u) => ({
      ...u,
      roles: roleRows.filter((r) => r.userId === u.id).map(({ userId: _u, ...r }) => r),
      teams: teamRows.filter((t) => t.userId === u.id).map(({ userId: _u, ...t }) => t),
    })),
    total: count,
    page: f.page,
    pageSize: f.pageSize,
  };
}

export async function getUser(ctx: Ctx, id: string) {
  const [u] = await ctx.tx.select({ ...userColumns, preferences: schema.users.preferences, customerName: schema.customers.name }).from(schema.users).leftJoin(schema.customers, eq(schema.customers.id, schema.users.customerId)).where(eq(schema.users.id, id)).limit(1);
  if (!u) throw new NotFoundError('User');
  if (u.customerId) ctx.requireCustomer(u.customerId);
  const roles = await ctx.tx
    .select({ roleId: schema.roles.id, key: schema.roles.key, name: schema.roles.name, customerId: schema.userRoles.customerId })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(eq(schema.userRoles.userId, id));
  const teams = await ctx.tx
    .select({ id: schema.teams.id, key: schema.teams.key, name: schema.teams.name, isLead: schema.teamMembers.isLead })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(eq(schema.teamMembers.userId, id));
  const customerAccess = await ctx.tx
    .select({ customerId: schema.userCustomerAccess.customerId, customerName: schema.customers.name })
    .from(schema.userCustomerAccess)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.userCustomerAccess.customerId))
    .where(eq(schema.userCustomerAccess.userId, id));
  return { ...u, roles, teams, customerAccess };
}

export interface CreateUserInput {
  email: string;
  name: string;
  phone?: string;
  title?: string;
  userType: 'msp' | 'customer';
  customerId?: string | null;
  timezone?: string;
  password?: string;
  roleIds?: { roleId: string; customerId?: string | null }[];
  teamIds?: string[];
  customerAccess?: string[];
  sendWelcome?: boolean;
}

export async function createUser(ctx: Ctx, input: CreateUserInput) {
  const email = input.email.trim().toLowerCase();
  if (input.userType === 'customer' && !input.customerId) throw new ValidationError('Customer users must belong to a customer');
  if (input.customerId) ctx.requireCustomer(input.customerId);
  const [exists] = await ctx.tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (exists) throw new ConflictError('A user with this email already exists');
  const temporaryPassword = input.password ?? `Tmp-${randomToken(9)}`;
  const [user] = await ctx.tx
    .insert(schema.users)
    .values({
      email,
      name: input.name,
      phone: input.phone,
      title: input.title,
      userType: input.userType,
      customerId: input.userType === 'customer' ? input.customerId : null,
      timezone: input.timezone ?? 'Asia/Kolkata',
      passwordHash: await hashPassword(temporaryPassword),
      status: 'active',
      passwordChangedAt: input.password ? new Date() : null,
    })
    .returning();
  await setUserRoles(ctx, user.id, input.roleIds ?? [], { audit: false });
  if (input.teamIds?.length) await setUserTeams(ctx, user.id, input.teamIds, { audit: false });
  if (input.customerAccess?.length) await setUserCustomerAccess(ctx, user.id, input.customerAccess, { audit: false });
  await ctx.audit({ entityType: 'user', entityId: user.id, entityLabel: user.email, action: 'create', customerId: user.customerId, metadata: { roles: input.roleIds, teams: input.teamIds } });
  if (input.sendWelcome !== false) {
    await queueNotification(ctx.tx, {
      event: 'user.welcome',
      recipients: [{ email: user.email, userId: user.id, name: user.name }],
      data: { user: { name: user.name, email: user.email }, temporaryPassword: input.password ? undefined : temporaryPassword, appUrl: config.APP_URL },
      customerId: user.customerId,
      channels: ['email'],
    });
  }
  return { user: await getUser(ctx, user.id), temporaryPassword: input.password ? undefined : temporaryPassword };
}

export async function updateUser(ctx: Ctx, id: string, patch: Partial<Pick<CreateUserInput, 'name' | 'phone' | 'title' | 'timezone' | 'customerId'>> & { status?: 'active' | 'disabled' }) {
  const [before] = await ctx.tx.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  if (!before) throw new NotFoundError('User');
  if (before.customerId) ctx.requireCustomer(before.customerId);
  if (id === ctx.user.id && patch.status === 'disabled') throw new ValidationError('You cannot disable your own account');
  const values: Partial<typeof schema.users.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.phone !== undefined) values.phone = patch.phone;
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.timezone !== undefined) values.timezone = patch.timezone;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.customerId !== undefined && before.userType === 'customer') {
    ctx.requireCustomer(patch.customerId);
    values.customerId = patch.customerId;
  }
  const [after] = await ctx.tx.update(schema.users).set(values).where(eq(schema.users.id, id)).returning();
  if (patch.status === 'disabled') await ctx.tx.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.userId, id));
  invalidatePrincipal(id);
  await ctx.audit({ entityType: 'user', entityId: id, entityLabel: after.email, action: 'update', customerId: after.customerId, changes: diffChanges(before as Record<string, unknown>, values as Record<string, unknown>) });
  return getUser(ctx, id);
}

export async function adminResetPassword(ctx: Ctx, id: string, password?: string) {
  const [user] = await ctx.tx.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  if (!user) throw new NotFoundError('User');
  if (user.customerId) ctx.requireCustomer(user.customerId);
  const temporaryPassword = password ?? `Tmp-${randomToken(9)}`;
  await ctx.tx.update(schema.users).set({ passwordHash: await hashPassword(temporaryPassword), passwordChangedAt: password ? new Date() : null, failedLoginCount: 0, lockedUntil: null }).where(eq(schema.users.id, id));
  await ctx.tx.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.userId, id));
  invalidatePrincipal(id);
  await ctx.audit({ entityType: 'user', entityId: id, entityLabel: user.email, action: 'password.admin_reset', customerId: user.customerId });
  return { temporaryPassword: password ? undefined : temporaryPassword };
}

export async function setUserRoles(ctx: Ctx, userId: string, assignments: { roleId: string; customerId?: string | null }[], opts = { audit: true }) {
  const [user] = await ctx.tx.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('User');
  const roleIds = [...new Set(assignments.map((a) => a.roleId))];
  const roles = roleIds.length ? await ctx.tx.select().from(schema.roles).where(inArray(schema.roles.id, roleIds)) : [];
  for (const a of assignments) {
    const role = roles.find((r) => r.id === a.roleId);
    if (!role) throw new ValidationError('Unknown role');
    if (role.userType !== user.userType) throw new ValidationError(`Role "${role.name}" cannot be assigned to ${user.userType} users`);
    if (user.userType === 'customer' && a.customerId && a.customerId !== user.customerId) throw new ValidationError('Customer users can only hold roles for their own organization');
    if (a.customerId) ctx.requireCustomer(a.customerId);
    // Only principals holding tenant:all may grant unscoped roles that include tenant:all.
    if (!a.customerId && !ctx.can('tenant:all')) {
      const perms = await ctx.tx.select().from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, role.id));
      if (perms.some((p) => p.permission === 'tenant:all')) throw new ForbiddenError('You cannot grant MSP-wide visibility');
    }
  }
  const before = await ctx.tx.select().from(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  await ctx.tx.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  if (assignments.length) {
    await ctx.tx
      .insert(schema.userRoles)
      .values(assignments.map((a) => ({ userId, roleId: a.roleId, customerId: user.userType === 'customer' ? user.customerId : a.customerId ?? null, createdBy: ctx.user.id })))
      .onConflictDoNothing();
  }
  invalidatePrincipal(userId);
  if (opts.audit) {
    await ctx.audit({ entityType: 'user', entityId: userId, entityLabel: user.email, action: 'roles.update', customerId: user.customerId, changes: { roles: { old: before.map((b) => `${b.roleId}:${b.customerId ?? '*'}`), new: assignments.map((a) => `${a.roleId}:${a.customerId ?? '*'}`) } } });
  }
}

export async function setUserTeams(ctx: Ctx, userId: string, teamIds: string[], opts = { audit: true }) {
  const before = await ctx.tx.select().from(schema.teamMembers).where(eq(schema.teamMembers.userId, userId));
  await ctx.tx.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, userId));
  if (teamIds.length) await ctx.tx.insert(schema.teamMembers).values(teamIds.map((teamId) => ({ teamId, userId }))).onConflictDoNothing();
  invalidatePrincipal(userId);
  if (opts.audit) await ctx.audit({ entityType: 'user', entityId: userId, action: 'teams.update', changes: { teams: { old: before.map((b) => b.teamId), new: teamIds } } });
}

export async function setUserCustomerAccess(ctx: Ctx, userId: string, customerIds: string[], opts = { audit: true }) {
  customerIds.forEach((c) => ctx.requireCustomer(c));
  const before = await ctx.tx.select().from(schema.userCustomerAccess).where(eq(schema.userCustomerAccess.userId, userId));
  await ctx.tx.delete(schema.userCustomerAccess).where(eq(schema.userCustomerAccess.userId, userId));
  if (customerIds.length) await ctx.tx.insert(schema.userCustomerAccess).values(customerIds.map((customerId) => ({ userId, customerId }))).onConflictDoNothing();
  invalidatePrincipal(userId);
  if (opts.audit) await ctx.audit({ entityType: 'user', entityId: userId, action: 'customer_access.update', changes: { customers: { old: before.map((b) => b.customerId), new: customerIds } } });
}

// ---------------------------------------------------------------- roles

export async function listRoles(ctx: Ctx) {
  const roles = await ctx.tx.select().from(schema.roles).orderBy(asc(schema.roles.userType), asc(schema.roles.name));
  const perms = await ctx.tx.select().from(schema.rolePermissions);
  const counts = await ctx.tx.select({ roleId: schema.userRoles.roleId, count: sql<number>`count(distinct ${schema.userRoles.userId})::int` }).from(schema.userRoles).groupBy(schema.userRoles.roleId);
  return roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission), userCount: counts.find((c) => c.roleId === r.id)?.count ?? 0 }));
}

export async function createRole(ctx: Ctx, input: { key: string; name: string; description?: string; userType: 'msp' | 'customer'; permissions: string[] }) {
  validatePermissions(input.permissions, input.userType);
  const [role] = await ctx.tx.insert(schema.roles).values({ key: input.key, name: input.name, description: input.description, userType: input.userType }).returning();
  if (input.permissions.length) await ctx.tx.insert(schema.rolePermissions).values(input.permissions.map((permission) => ({ roleId: role.id, permission })));
  await ctx.audit({ entityType: 'role', entityId: role.id, entityLabel: role.name, action: 'create', metadata: { permissions: input.permissions } });
  return { ...role, permissions: input.permissions };
}

export async function updateRole(ctx: Ctx, id: string, patch: { name?: string; description?: string; permissions?: string[] }) {
  const [role] = await ctx.tx.select().from(schema.roles).where(eq(schema.roles.id, id)).limit(1);
  if (!role) throw new NotFoundError('Role');
  if (role.key === 'admin' && patch.permissions) throw new ValidationError('The Administrator role permissions cannot be modified');
  if (patch.name || patch.description !== undefined) await ctx.tx.update(schema.roles).set({ name: patch.name ?? role.name, description: patch.description ?? role.description, updatedAt: new Date() }).where(eq(schema.roles.id, id));
  let oldPerms: string[] | undefined;
  if (patch.permissions) {
    validatePermissions(patch.permissions, role.userType);
    oldPerms = (await ctx.tx.select().from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, id))).map((p) => p.permission);
    await ctx.tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, id));
    if (patch.permissions.length) await ctx.tx.insert(schema.rolePermissions).values(patch.permissions.map((permission) => ({ roleId: id, permission })));
    invalidatePrincipal();
  }
  await ctx.audit({ entityType: 'role', entityId: id, entityLabel: role.name, action: 'update', changes: { ...(patch.name ? { name: { old: role.name, new: patch.name } } : {}), ...(patch.permissions ? { permissions: { old: oldPerms, new: patch.permissions } } : {}) } });
  return (await listRoles(ctx)).find((r) => r.id === id);
}

export async function deleteRole(ctx: Ctx, id: string) {
  const [role] = await ctx.tx.select().from(schema.roles).where(eq(schema.roles.id, id)).limit(1);
  if (!role) throw new NotFoundError('Role');
  if (role.isSystem) throw new ValidationError('System roles cannot be deleted');
  await ctx.tx.delete(schema.roles).where(eq(schema.roles.id, id));
  invalidatePrincipal();
  await ctx.audit({ entityType: 'role', entityId: id, entityLabel: role.name, action: 'delete' });
}

function validatePermissions(perms: string[], userType: 'msp' | 'customer') {
  for (const p of perms) {
    if (!ALL_PERMISSIONS.includes(p as Permission)) throw new ValidationError(`Unknown permission: ${p}`);
    if (userType === 'customer' && !p.startsWith('portal:') && !p.startsWith('ai:')) throw new ValidationError(`Permission ${p} cannot be granted to customer roles`);
  }
}

export function permissionCatalog() {
  return Object.entries(PERMISSION_MODULES).map(([module, keys]) => ({ module, permissions: keys.map((key) => ({ key, description: PERMISSIONS[key] })) }));
}

// ---------------------------------------------------------------- teams

export async function listTeams(ctx: Ctx) {
  const teams = await ctx.tx.select({ ...getTableColumns(schema.teams), managerName: schema.users.name }).from(schema.teams).leftJoin(schema.users, eq(schema.users.id, schema.teams.managerUserId)).orderBy(asc(schema.teams.name));
  const members = await ctx.tx
    .select({ teamId: schema.teamMembers.teamId, userId: schema.users.id, name: schema.users.name, email: schema.users.email, isLead: schema.teamMembers.isLead, status: schema.users.status })
    .from(schema.teamMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId));
  return teams.map((t) => ({ ...t, members: members.filter((m) => m.teamId === t.id).map(({ teamId: _t, ...m }) => m) }));
}

export async function createTeam(ctx: Ctx, input: { key: string; name: string; description?: string; teamType?: string; email?: string; managerUserId?: string | null }) {
  const [team] = await ctx.tx.insert(schema.teams).values(input).returning();
  await ctx.audit({ entityType: 'team', entityId: team.id, entityLabel: team.name, action: 'create' });
  return team;
}

export async function updateTeam(ctx: Ctx, id: string, patch: Partial<{ name: string; description: string | null; teamType: string; email: string | null; managerUserId: string | null; isActive: boolean }>) {
  const [before] = await ctx.tx.select().from(schema.teams).where(eq(schema.teams.id, id)).limit(1);
  if (!before) throw new NotFoundError('Team');
  const [after] = await ctx.tx.update(schema.teams).set({ ...patch, updatedAt: new Date() }).where(eq(schema.teams.id, id)).returning();
  await ctx.audit({ entityType: 'team', entityId: id, entityLabel: after.name, action: 'update', changes: diffChanges(before as Record<string, unknown>, patch as Record<string, unknown>) });
  return after;
}

export async function setTeamMembers(ctx: Ctx, teamId: string, members: { userId: string; isLead?: boolean }[]) {
  const [team] = await ctx.tx.select().from(schema.teams).where(eq(schema.teams.id, teamId)).limit(1);
  if (!team) throw new NotFoundError('Team');
  const before = await ctx.tx.select().from(schema.teamMembers).where(eq(schema.teamMembers.teamId, teamId));
  await ctx.tx.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, teamId));
  if (members.length) await ctx.tx.insert(schema.teamMembers).values(members.map((m) => ({ teamId, userId: m.userId, isLead: m.isLead ?? false }))).onConflictDoNothing();
  for (const u of new Set([...before.map((b) => b.userId), ...members.map((m) => m.userId)])) invalidatePrincipal(u);
  await ctx.audit({ entityType: 'team', entityId: teamId, entityLabel: team.name, action: 'members.update', changes: { members: { old: before.map((b) => b.userId), new: members.map((m) => m.userId) } } });
}

export async function deleteTeam(ctx: Ctx, id: string) {
  const [team] = await ctx.tx.select().from(schema.teams).where(eq(schema.teams.id, id)).limit(1);
  if (!team) throw new NotFoundError('Team');
  await ctx.tx.delete(schema.teams).where(eq(schema.teams.id, id));
  await ctx.audit({ entityType: 'team', entityId: id, entityLabel: team.name, action: 'delete' });
}

// ---------------------------------------------------------------- API keys

export async function listApiKeys(ctx: Ctx) {
  return ctx.tx
    .select({ id: schema.apiKeys.id, name: schema.apiKeys.name, keyPrefix: schema.apiKeys.keyPrefix, permissions: schema.apiKeys.permissions, customerId: schema.apiKeys.customerId, customerName: schema.customers.name, lastUsedAt: schema.apiKeys.lastUsedAt, expiresAt: schema.apiKeys.expiresAt, revokedAt: schema.apiKeys.revokedAt, createdAt: schema.apiKeys.createdAt })
    .from(schema.apiKeys)
    .leftJoin(schema.customers, eq(schema.customers.id, schema.apiKeys.customerId))
    .orderBy(desc(schema.apiKeys.createdAt));
}

export async function createApiKey(ctx: Ctx, input: { name: string; permissions: string[]; customerId?: string | null; expiresAt?: string | null }) {
  validatePermissions(input.permissions, 'msp');
  const raw = `itsm_${randomToken(32)}`;
  const [row] = await ctx.tx
    .insert(schema.apiKeys)
    .values({ name: input.name, keyPrefix: raw.slice(0, 12), keyHash: sha256(raw), permissions: input.permissions, customerId: input.customerId ?? null, createdBy: ctx.user.id, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null })
    .returning();
  await ctx.audit({ entityType: 'api_key', entityId: row.id, entityLabel: row.name, action: 'create', metadata: { permissions: input.permissions } });
  return { id: row.id, name: row.name, key: raw, keyPrefix: row.keyPrefix };
}

export async function revokeApiKey(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.update(schema.apiKeys).set({ revokedAt: new Date() }).where(eq(schema.apiKeys.id, id)).returning();
  if (!row) throw new NotFoundError('API key');
  await ctx.audit({ entityType: 'api_key', entityId: id, entityLabel: row.name, action: 'revoke' });
}

/** Lightweight directory for assignment pickers (any MSP user). */
export async function engineerDirectory(ctx: Ctx, q?: string) {
  const conds = [eq(schema.users.userType, 'msp'), eq(schema.users.status, 'active')];
  if (q) conds.push(or(ilike(schema.users.name, `%${q}%`), ilike(schema.users.email, `%${q}%`))!);
  const users = await ctx.tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, title: schema.users.title }).from(schema.users).where(and(...conds)).orderBy(asc(schema.users.name)).limit(500);
  const members = await ctx.tx.select({ userId: schema.teamMembers.userId, teamId: schema.teamMembers.teamId }).from(schema.teamMembers);
  return users.map((u) => ({ ...u, teamIds: members.filter((m) => m.userId === u.id).map((m) => m.teamId) }));
}
