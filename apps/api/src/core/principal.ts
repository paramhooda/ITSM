import { eq, inArray, and, isNull } from 'drizzle-orm';
import type { Permission } from '@itsm/shared';
import { db, schema, withSystem } from '@/db/client';

export interface Principal {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  whatsappOptIn?: boolean;
  userType: 'msp' | 'customer';
  customerId: string | null;
  status: string;
  timezone: string;
  preferences: Record<string, unknown>;
  /** Permissions granted by global (unscoped) role assignments. */
  globalPermissions: Set<Permission>;
  /** Permissions granted per customer by scoped role assignments. */
  customerPermissions: Map<string, Set<Permission>>;
  customerScope: 'all' | string[];
  roles: { id: string; key: string; name: string; customerId: string | null }[];
  teams: { id: string; key: string; name: string }[];
  /** Navigation areas (union over roles); null when no role configures them. */
  areas?: string[] | null;
  /** For API-key principals. */
  apiKeyId?: string;
  isSystem?: boolean;
}

/** Short-lived cache of resolved principals (per process). Invalidated on IAM changes. */
const cache = new Map<string, { at: number; p: Principal }>();
const TTL_MS = 15_000;
export const invalidatePrincipal = (userId?: string) => (userId ? cache.delete(userId) : cache.clear());

export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user || user.status !== 'active') return null;

  const assignments = await db
    .select({
      roleId: schema.roles.id,
      roleKey: schema.roles.key,
      roleName: schema.roles.name,
      navAreas: schema.roles.navAreas,
      customerId: schema.userRoles.customerId,
    })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(eq(schema.userRoles.userId, userId));

  const roleIds = [...new Set(assignments.map((a) => a.roleId))];
  const perms = roleIds.length
    ? await db.select().from(schema.rolePermissions).where(inArray(schema.rolePermissions.roleId, roleIds))
    : [];
  const permsByRole = new Map<string, Permission[]>();
  for (const rp of perms) {
    const list = permsByRole.get(rp.roleId) ?? [];
    list.push(rp.permission as Permission);
    permsByRole.set(rp.roleId, list);
  }

  const globalPermissions = new Set<Permission>();
  const customerPermissions = new Map<string, Set<Permission>>();
  const explicitCustomers = new Set<string>();
  for (const a of assignments) {
    const list = permsByRole.get(a.roleId) ?? [];
    if (a.customerId) {
      explicitCustomers.add(a.customerId);
      const set = customerPermissions.get(a.customerId) ?? new Set<Permission>();
      list.forEach((p) => set.add(p));
      customerPermissions.set(a.customerId, set);
    } else {
      list.forEach((p) => globalPermissions.add(p));
    }
  }

  const teamRows = await db
    .select({ id: schema.teams.id, key: schema.teams.key, name: schema.teams.name })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(eq(schema.teamMembers.userId, userId));

  let customerScope: 'all' | string[];
  if (user.userType === 'customer') {
    customerScope = user.customerId ? [user.customerId] : [];
  } else if (globalPermissions.has('tenant:all')) {
    customerScope = 'all';
  } else {
    // Grant tables carry customer_id and are under row-level security; resolving a
    // principal has no tenant context yet, so read them with the system context.
    const { grants, viaTeams } = await withSystem(async (tx) => ({
      grants: await tx.select({ customerId: schema.userCustomerAccess.customerId }).from(schema.userCustomerAccess).where(eq(schema.userCustomerAccess.userId, userId)),
      viaTeams: teamRows.length
        ? await tx
            .select({ customerId: schema.customerTeams.customerId })
            .from(schema.customerTeams)
            .where(inArray(schema.customerTeams.teamId, teamRows.map((t) => t.id)))
        : [],
    }));
    grants.forEach((g) => explicitCustomers.add(g.customerId));
    viaTeams.forEach((g) => explicitCustomers.add(g.customerId));
    customerScope = [...explicitCustomers];
  }

  const principal: Principal = {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    whatsappOptIn: user.whatsappOptIn,
    userType: user.userType,
    customerId: user.customerId,
    status: user.status,
    timezone: user.timezone,
    preferences: user.preferences,
    globalPermissions,
    customerPermissions,
    customerScope,
    roles: assignments.map((a) => ({ id: a.roleId, key: a.roleKey, name: a.roleName, customerId: a.customerId })),
    teams: teamRows,
    areas: assignments.some((a) => a.navAreas) ? [...new Set(assignments.flatMap((a) => a.navAreas ?? []))] : null,
  };
  cache.set(userId, { at: Date.now(), p: principal });
  return principal;
}

export async function loadApiKeyPrincipal(rawKey: string, sha256: (s: string) => string): Promise<Principal | null> {
  const [row] = await db.select().from(schema.apiKeys).where(and(eq(schema.apiKeys.keyHash, sha256(rawKey)), isNull(schema.apiKeys.revokedAt))).limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;
  void db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.id)).catch(() => undefined);
  const perms = new Set<Permission>(row.permissions as Permission[]);
  return {
    id: row.id,
    email: `apikey:${row.keyPrefix}`,
    name: row.name,
    phone: null,
    whatsappOptIn: false,
    userType: 'msp',
    customerId: row.customerId,
    status: 'active',
    timezone: 'UTC',
    preferences: {},
    globalPermissions: perms,
    customerPermissions: new Map(),
    customerScope: row.customerId ? [row.customerId] : perms.has('tenant:all') ? 'all' : [],
    roles: [],
    teams: [],
    areas: null,
    apiKeyId: row.id,
  };
}

export function toPublicPrincipal(p: Principal) {
  const all = new Set<Permission>(p.globalPermissions);
  for (const set of p.customerPermissions.values()) set.forEach((x) => all.add(x));
  return {
    id: p.id,
    email: p.email,
    name: p.name,
    phone: p.phone,
    whatsappOptIn: p.whatsappOptIn ?? false,
    userType: p.userType,
    customerId: p.customerId,
    permissions: [...all],
    customerScope: p.customerScope,
    roles: p.roles,
    teams: p.teams,
    areas: p.areas ?? null,
    timezone: p.timezone,
    preferences: p.preferences,
  };
}
