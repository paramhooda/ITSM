/**
 * Navigation areas on roles and the team directory (DB-backed).
 * Run with the dev environment sourced:  npx vitest run test/iam.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { SYSTEM_ROLE_AREAS } from '@itsm/shared';
import { withSystem, closeDb, schema } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, toPublicPrincipal, type Principal } from '../src/core/principal';
import * as iam from '../src/modules/iam/service';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-iam-${S}`, ip: '127.0.0.1' };
let admin: Principal;
const ids = { user: '', teamA: '', teamB: '', customRole: '' };
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [a] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    const roles = await tx.select({ id: schema.roles.id, key: schema.roles.key }).from(schema.roles).where(inArray(schema.roles.key, ['noc_engineer', 'engineer']));
    const roleId = (key: string) => roles.find((r) => r.key === key)!.id;
    const [u] = await tx.insert(schema.users).values({ email: `iam-${S}@msp.local`, name: `IAM Tester ${S}`, title: 'Network engineer', userType: 'msp', status: 'active' }).returning({ id: schema.users.id });
    ids.user = u!.id;
    await tx.insert(schema.userRoles).values([{ userId: u!.id, roleId: roleId('noc_engineer'), customerId: null }, { userId: u!.id, roleId: roleId('engineer'), customerId: null }]);
    const [ta] = await tx.insert(schema.teams).values({ key: `iam_a_${S}`, name: `IAM Team A ${S}`, teamType: 'noc' }).returning({ id: schema.teams.id });
    const [tb] = await tx.insert(schema.teams).values({ key: `iam_b_${S}`, name: `IAM Team B ${S}`, teamType: 'field' }).returning({ id: schema.teams.id });
    ids.teamA = ta!.id;
    ids.teamB = tb!.id;
    await tx.insert(schema.teamMembers).values([{ teamId: ta!.id, userId: u!.id, isLead: true }, { teamId: tb!.id, userId: u!.id, isLead: false }]);
    invalidatePrincipal();
    admin = (await loadPrincipal(a!.id))!;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (ids.customRole) await tx.delete(schema.roles).where(eq(schema.roles.id, ids.customRole));
    await tx.delete(schema.teams).where(inArray(schema.teams.id, [ids.teamA, ids.teamB].filter(Boolean)));
    if (ids.user) await tx.delete(schema.users).where(eq(schema.users.id, ids.user));
  });
  await closeDb();
});

describe('navigation areas', () => {
  it('system roles carry their default areas after seeding', async () => {
    const roles = await asAdmin((ctx) => iam.listRoles(ctx));
    const noc = roles.find((r) => r.key === 'noc_engineer')!;
    expect(noc.navAreas).toEqual(SYSTEM_ROLE_AREAS.noc_engineer);
    expect(noc.navAreas).not.toContain('customers');
    expect(roles.find((r) => r.key === 'admin')!.navAreas).toContain('reports');
  });

  it('a user with two roles sees the union of their areas', async () => {
    invalidatePrincipal(ids.user);
    const p = (await loadPrincipal(ids.user))!;
    const areas = toPublicPrincipal(p).areas ?? [];
    for (const a of [...SYSTEM_ROLE_AREAS.noc_engineer!, ...SYSTEM_ROLE_AREAS.engineer!]) expect(areas).toContain(a);
    expect(areas).not.toContain('contracts');
  });

  it('custom roles accept areas, reject unknown ones, and null means everything', async () => {
    const role = await asAdmin((ctx) => iam.createRole(ctx, { key: `iam_custom_${S}`, name: `Custom ${S}`, userType: 'msp', permissions: ['tickets:read'], navAreas: ['tickets', 'knowledge'] }));
    ids.customRole = role.id;
    expect((await asAdmin((ctx) => iam.listRoles(ctx))).find((r) => r.id === role.id)!.navAreas).toEqual(['tickets', 'knowledge']);
    await expect(asAdmin((ctx) => iam.updateRole(ctx, role.id, { navAreas: ['tickets', 'spaceships'] }))).rejects.toMatchObject({ statusCode: 422 });
    await asAdmin((ctx) => iam.updateRole(ctx, role.id, { navAreas: null }));
    expect((await asAdmin((ctx) => iam.listRoles(ctx))).find((r) => r.id === role.id)!.navAreas).toBeNull();
  });
});

describe('team directory', () => {
  it('lists teams with members, leads, roles and cross-team membership', async () => {
    const dir = await asAdmin((ctx) => iam.teamDirectory(ctx));
    const a = dir.teams.find((t) => t.id === ids.teamA)!;
    const b = dir.teams.find((t) => t.id === ids.teamB)!;
    expect(a.members.map((m) => m.id)).toContain(ids.user);
    const me = a.members.find((m) => m.id === ids.user)!;
    expect(me.isLead).toBe(true);
    expect(me.title).toBe('Network engineer');
    expect(me.roles.map((r) => r.key).sort()).toEqual(['engineer', 'noc_engineer']);
    expect(me.otherTeamIds).toEqual([ids.teamB]);
    expect(b.members.find((m) => m.id === ids.user)!.isLead).toBe(false);
    expect(dir.totals.multiTeam).toBeGreaterThanOrEqual(1);
    expect(typeof a.load.open).toBe('number');
  });
});
