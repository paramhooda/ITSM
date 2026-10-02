import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { schema, withSystem, closeDb } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, type Principal } from '../src/core/principal';
import * as cmdb from '../src/modules/cmdb/service';
import * as config from '../src/modules/config/service';
import * as views from '../src/modules/tickets/views';
import { createTicket } from '../src/modules/tickets/service';

/**
 * DB-backed tests for the CMDB overview, business-service map/health, bulk
 * updates, list filters, relationship impact metadata and CI saved views.
 * Requires the dev environment (DATABASE_URL etc.) with migrations + seed.
 */
const hasDb = !!process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('x');

describe.skipIf(!hasDb)('cmdb overview, services, bulk + impact metadata (database)', () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  let customerId = '';
  let siteId = '';
  let teamId = '';
  let p1 = '';
  let p4 = '';
  let admin: Principal;
  const types: Record<string, string> = {};
  const relTypes: Record<string, { id: string; impactDirection: string }> = {};
  const ids: Record<string, string> = {};
  const ticketIds: string[] = [];

  const as = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `test-${suffix}`, source: 'api' }, fn);

  beforeAll(async () => {
    await withSystem(async (tx) => {
      const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
      if (!adminUser) throw new Error('admin user missing (seed not applied?)');
      const p = await loadPrincipal(adminUser.id);
      if (!p) throw new Error('could not load admin principal');
      admin = p;
      const [c] = await tx.insert(schema.customers).values({ code: `OV-${suffix}`, name: `Overview customer ${suffix}` }).returning();
      customerId = c.id;
      const [s] = await tx.insert(schema.sites).values({ customerId, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
      siteId = s.id;
      const [team] = await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.key, 'noc')).limit(1);
      teamId = team.id;
      for (const t of await tx.select().from(schema.ciTypes)) types[t.key] = t.id;
      for (const r of await tx.select().from(schema.ciRelationshipTypes)) relTypes[r.key] = { id: r.id, impactDirection: r.impactDirection };
      const prio = await tx.select({ id: schema.configOptions.id, key: schema.configOptions.key }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_priority'), inArray(schema.configOptions.key, ['p1', 'p4'])));
      p1 = prio.find((x) => x.key === 'p1')!.id;
      p4 = prio.find((x) => x.key === 'p4')!.id;
    });
  });

  afterAll(async () => {
    await withSystem(async (tx) => {
      if (ticketIds.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, ticketIds));
      if (customerId) await tx.delete(schema.customers).where(eq(schema.customers.id, customerId));
    });
    await closeDb();
  });

  it('seeds impact metadata on relationship types and exposes it', async () => {
    expect(relTypes.depends_on.impactDirection).toBe('downstream');
    expect(relTypes.runs_on.impactDirection).toBe('downstream');
    expect(relTypes.hosted_on.impactDirection).toBe('downstream');
    expect(relTypes.protected_by.impactDirection).toBe('downstream');
    expect(relTypes.supports.impactDirection).toBe('upstream');
    expect(relTypes.manages.impactDirection).toBe('upstream');
    expect(relTypes.connected_to.impactDirection).toBe('none');
    expect(relTypes.monitored_by.impactDirection).toBe('none');
    const listed = await as((ctx) => cmdb.listTypes(ctx));
    expect(listed.relationshipTypes.find((r) => r.key === 'supports')?.impactDirection).toBe('upstream');
    const lookups = await as((ctx) => config.lookups(ctx));
    expect(lookups.relationshipTypes.find((r) => r.key === 'depends_on')?.impactDirection).toBe('downstream');
  });

  it('validates impactDirection through the generic relationship-type config CRUD', async () => {
    const created = (await as((ctx) => config.createConfig(ctx, 'relationship-types', { key: `rt_${suffix}`, name: `Feeds ${suffix}`, inverseName: 'Fed by', impactDirection: 'downstream' }))) as unknown as { id: string; impactDirection: string };
    expect(created.impactDirection).toBe('downstream');
    await expect(as((ctx) => config.updateConfig(ctx, 'relationship-types', created.id, { impactDirection: 'sideways' }))).rejects.toThrow(/impactDirection must be one of/);
    await expect(as((ctx) => config.createConfig(ctx, 'relationship-types', { key: `rt2_${suffix}`, name: 'Bad', inverseName: 'Bad', impactDirection: 'nope' }))).rejects.toThrow(/impactDirection/);
    const updated = (await as((ctx) => config.updateConfig(ctx, 'relationship-types', created.id, { impactDirection: 'upstream' }))) as unknown as { impactDirection: string };
    expect(updated.impactDirection).toBe('upstream');
    await as((ctx) => config.deleteConfig(ctx, 'relationship-types', created.id));
  });

  it('builds the dependency chain with upstream, downstream and non-propagating edges', async () => {
    const bs = await as((ctx) => cmdb.createCi(ctx, { customerId, siteId, typeId: types.business_service, name: 'Payments', criticality: 'critical', ownerTeamId: teamId, hostname: 'payments', attributes: { tier: 'tier1', owner: 'CFO' } }));
    const bs2 = await as((ctx) => cmdb.createCi(ctx, { customerId, typeId: types.business_service, name: 'Intranet', attributes: { tier: 'tier3' } }));
    const app = await as((ctx) => cmdb.createCi(ctx, { customerId, siteId, typeId: types.application, name: 'pay-app', hostname: 'pay-app-01', ownerTeamId: teamId }));
    const db = await as((ctx) => cmdb.createCi(ctx, { customerId, siteId, typeId: types.database, name: 'pay-db', hostname: 'pay-db-01', serialNumber: 'SN-DB-1', ownerTeamId: teamId }));
    const vm = await as((ctx) => cmdb.createCi(ctx, { customerId, siteId, typeId: types.virtual_machine, name: 'vm-pay-01', hostname: 'vm-pay-01' }));
    const hv = await as((ctx) => cmdb.createCi(ctx, { customerId, siteId, typeId: types.hypervisor, name: 'esx-pay-01', hostname: 'esx-pay-01', serialNumber: 'SN-ESX-1', ownerTeamId: teamId }));
    const monitor = await as((ctx) => cmdb.createCi(ctx, { customerId, typeId: types.other, name: 'zabbix' }));
    const lonely = await as((ctx) => cmdb.createCi(ctx, { customerId, typeId: types.endpoint, name: 'lonely-laptop' }));
    Object.assign(ids, { bs: bs.id, bs2: bs2.id, app: app.id, db: db.id, vm: vm.id, hv: hv.id, monitor: monitor.id, lonely: lonely.id });
    // a discovered CI that has not been seen for 60 days (stale) and has no relationships
    const [staleCi] = await withSystem((tx) => tx.insert(schema.cis).values({ customerId, typeId: types.network_switch, name: 'old-switch', discoverySource: 'network_scan', discoveredAt: new Date(Date.now() - 90 * 86_400_000), lastSeenAt: new Date(Date.now() - 60 * 86_400_000) }).returning());
    ids.stale = staleCi.id;

    await as((ctx) => cmdb.addRelationship(ctx, ids.bs, { targetCiId: ids.app, typeId: relTypes.depends_on.id }));
    await as((ctx) => cmdb.addRelationship(ctx, ids.app, { targetCiId: ids.vm, typeId: relTypes.runs_on.id }));
    await as((ctx) => cmdb.addRelationship(ctx, ids.db, { targetCiId: ids.app, typeId: relTypes.supports.id })); // upstream: app is impacted when db fails
    await as((ctx) => cmdb.addRelationship(ctx, ids.vm, { targetCiId: ids.hv, typeId: relTypes.hosted_on.id }));
    const rels = await as((ctx) => cmdb.addRelationship(ctx, ids.vm, { targetCiId: ids.monitor, typeId: relTypes.monitored_by.id })); // none: never part of impact / map
    expect(rels.outbound.map((r) => [r.typeKey, r.impactDirection])).toEqual([['hosted_on', 'downstream'], ['monitored_by', 'none']]);
  });

  it('produces a layered dependency map from the business service (and from any CI)', async () => {
    const map = await as((ctx) => cmdb.serviceMap(ctx, ids.bs, 6));
    expect(map.root).toMatchObject({ id: ids.bs, name: 'Payments', typeKey: 'business_service', status: 'active', criticality: 'critical' });
    expect(map.truncated).toBe(false);
    const layers = Object.fromEntries(map.nodes.map((n) => [n.name, n.layer]));
    expect(layers).toEqual({ Payments: 0, 'pay-app': 1, 'pay-db': 2, 'vm-pay-01': 2, 'esx-pay-01': 3 });
    expect(map.nodes.every((n) => typeof n.openTickets === 'number' && n.typeName && 'color' in n && 'icon' in n)).toBe(true);
    expect(map.edges.map((e) => e.typeKey).sort()).toEqual(['depends_on', 'hosted_on', 'runs_on', 'supports']);
    expect(map.edges.every((e) => e.id && e.source && e.target && e.typeName)).toBe(true);
    // depth bound and non-service roots
    const shallow = await as((ctx) => cmdb.serviceMap(ctx, ids.bs, 1));
    expect(shallow.nodes.map((n) => n.name).sort()).toEqual(['Payments', 'pay-app']);
    const fromApp = await as((ctx) => cmdb.serviceMap(ctx, ids.app));
    expect(fromApp.nodes.map((n) => n.name).sort()).toEqual(['esx-pay-01', 'pay-app', 'pay-db', 'vm-pay-01']);
    await expect(as((ctx) => cmdb.serviceMap(ctx, '00000000-0000-4000-8000-000000000000'))).rejects.toThrow(/not found/);
  });

  it('impact analysis follows the impact_direction column in both directions', async () => {
    const hv = await as((ctx) => cmdb.impact(ctx, ids.hv));
    expect(hv.dependents.map((d) => [d.name, d.depth, d.via])).toEqual([['vm-pay-01', 1, 'hosted_on'], ['pay-app', 2, 'runs_on'], ['Payments', 3, 'depends_on']]);
    expect(hv.businessServices.map((s) => s.name)).toEqual(['Payments']);
    const db = await as((ctx) => cmdb.impact(ctx, ids.db));
    expect(db.dependents.map((d) => [d.name, d.depth, d.via])).toEqual([['pay-app', 1, 'supports'], ['Payments', 2, 'depends_on']]);
    const monitor = await as((ctx) => cmdb.impact(ctx, ids.monitor));
    expect(monitor.dependents).toHaveLength(0);
    const app = await as((ctx) => cmdb.impact(ctx, ids.app));
    expect(app.dependents.map((d) => d.name)).toEqual(['Payments']);
  });

  it('rates business-service health from open tickets on the root or any dependency', async () => {
    const before = await as((ctx) => cmdb.listBusinessServices(ctx, customerId));
    const pay = before.items.find((s) => s.id === ids.bs)!;
    expect(pay).toMatchObject({ name: 'Payments', customerId, status: 'active', criticality: 'critical', tier: 'tier1', owner: 'CFO', dependencies: 4, openIncidents: 0, health: 'good' });
    expect(pay.customerName).toContain('Overview customer');
    expect(before.items.find((s) => s.id === ids.bs2)).toMatchObject({ tier: 'tier3', owner: null, dependencies: 0, openIncidents: 0, health: 'good' });

    const low = await as((ctx) => createTicket(ctx, { type: 'incident', customerId, title: `VM slow ${suffix}`, priorityId: p4, ciIds: [ids.vm] }));
    ticketIds.push(low.id);
    const warn = await as((ctx) => cmdb.listBusinessServices(ctx, customerId));
    expect(warn.items.find((s) => s.id === ids.bs)).toMatchObject({ openIncidents: 1, health: 'warning' });

    const high = await as((ctx) => createTicket(ctx, { type: 'incident', customerId, title: `Host down ${suffix}`, priorityId: p1, primaryCiId: ids.hv }));
    ticketIds.push(high.id);
    const crit = await as((ctx) => cmdb.listBusinessServices(ctx, customerId));
    expect(crit.items.find((s) => s.id === ids.bs)).toMatchObject({ openIncidents: 2, health: 'critical' });
    expect(crit.items.find((s) => s.id === ids.bs2)).toMatchObject({ openIncidents: 0, health: 'good' });

    const map = await as((ctx) => cmdb.serviceMap(ctx, ids.bs));
    expect(Object.fromEntries(map.nodes.map((n) => [n.name, n.openTickets]))).toEqual({ Payments: 0, 'pay-app': 0, 'pay-db': 0, 'vm-pay-01': 1, 'esx-pay-01': 1 });
  });

  it('computes the overview totals, breakdowns, health ratios, discovery state and top impacted CIs', async () => {
    const o = await as((ctx) => cmdb.cmdbOverview(ctx, customerId));
    expect(o.totals).toEqual({ total: 9, active: 9, retired: 0, stale: 1, discovered: 1, withAsset: 0, critical: 1, unowned: 5, noSite: 4, withoutRelationships: 3, openIncidents: 2 });
    expect(o.byType.find((t) => t.key === 'business_service')).toMatchObject({ name: 'Business Service', count: 2, parentKey: null });
    expect(o.byType.reduce((a, t) => a + t.count, 0)).toBe(9);
    expect(o.byStatus).toEqual([{ status: 'active', count: 9 }]);
    expect(o.byEnvironment).toEqual([{ environment: 'production', count: 9 }]);
    expect(o.byCriticality.find((c) => c.criticality === 'critical')?.count).toBe(1);
    // completeness: site + owner + (serial or hostname) → Payments, pay-app, pay-db, esx-pay-01 = 4 of 9
    expect(o.health.completenessPct).toBe(44.4);
    expect(o.health.freshnessPct).toBe(0); // the only discovered CI is stale
    // active CIs with ≥1 relationship: 6 of 9
    expect(o.health.relationshipCoveragePct).toBe(66.7);
    expect(o.discovery).toEqual({ sources: 0, activeSources: 0, pendingFindings: 0, newFindings: 0, lastRun: null });
    expect(o.recentChanges.length).toBeGreaterThanOrEqual(8);
    expect(o.recentChanges.length).toBeLessThanOrEqual(10);
    expect(o.recentChanges[0]).toMatchObject({ action: expect.any(String), actorName: admin.name });
    expect(o.recentChanges.every((c) => c.id && c.entityId && c.ciName && c.at)).toBe(true);
    expect(o.topImpacted.map((t) => [t.name, t.typeName, t.openTickets])).toEqual([['esx-pay-01', 'Hypervisor', 1], ['vm-pay-01', 'Virtual Machine', 1]]);
    // without a customer filter the overview still answers (tenant-wide numbers are at least ours)
    const all = await as((ctx) => cmdb.cmdbOverview(ctx));
    expect(all.totals.total).toBeGreaterThanOrEqual(9);
    expect(all.byType.length).toBeGreaterThan(0);
  });

  it('list filters: discovered, unowned, withoutRelationships, ownerTeamId and the aligned stale predicate', async () => {
    const list = (q: Partial<Parameters<typeof cmdb.listCisFull>[1]>) => as((ctx) => cmdb.listCisFull(ctx, { page: 1, pageSize: 50, customerId, ...q }));
    expect((await list({ discovered: true })).items.map((i) => i.name)).toEqual(['old-switch']);
    expect((await list({ discovered: false })).total).toBe(8);
    expect((await list({ unowned: true })).items.map((i) => i.name).sort()).toEqual(['Intranet', 'lonely-laptop', 'old-switch', 'vm-pay-01', 'zabbix']);
    expect((await list({ unowned: false })).total).toBe(4);
    expect((await list({ ownerTeamId: teamId })).total).toBe(4);
    expect((await list({ withoutRelationships: true })).items.map((i) => i.name).sort()).toEqual(['Intranet', 'lonely-laptop', 'old-switch']);
    expect((await list({ withoutRelationships: false })).total).toBe(6);
    // stale = discovered AND not seen for 30 days: manual CIs with lastSeenAt null are NOT stale
    const stale = await list({ stale: true });
    expect(stale.items.map((i) => i.name)).toEqual(['old-switch']);
    expect((await list({ stale: false })).total).toBe(8);
    const summary = await as((ctx) => cmdb.ciSummary(ctx, customerId));
    expect(summary.stale).toBe(stale.total);
    expect(summary.discovered).toBe(1);
    // filters compose
    expect((await list({ unowned: true, withoutRelationships: true, discovered: false })).items.map((i) => i.name).sort()).toEqual(['Intranet', 'lonely-laptop']);
  });

  it('bulk updates CIs row by row with per-CI audit entries and partial failure', async () => {
    const missing = '00000000-0000-4000-8000-00000000dead';
    const res = await as((ctx) => cmdb.bulkUpdateCis(ctx, { ids: [ids.lonely, ids.stale, missing], action: 'criticality', payload: { criticality: 'high' } }));
    expect(res).toEqual({ succeeded: 2, failed: 1, errors: [{ id: missing, message: expect.stringMatching(/not found/) }] });
    expect((await as((ctx) => cmdb.getCi(ctx, ids.lonely))).criticality).toBe('high');
    expect((await as((ctx) => cmdb.getCi(ctx, ids.stale))).criticality).toBe('high');
    const history = await as((ctx) => cmdb.history(ctx, ids.lonely));
    const bulkEntry = history.items.find((h) => (h.metadata as { bulk?: boolean })?.bulk);
    expect(bulkEntry).toMatchObject({ action: 'update', changes: { criticality: { old: 'medium', new: 'high' } } });

    const tag = await as((ctx) => cmdb.bulkUpdateCis(ctx, { ids: [ids.lonely, ids.lonely], action: 'addTag', payload: { tag: 'audit-2026' } }));
    expect(tag).toEqual({ succeeded: 1, failed: 0, errors: [] });
    const again = await as((ctx) => cmdb.bulkUpdateCis(ctx, { ids: [ids.lonely], action: 'addTag', payload: { tag: 'audit-2026' } }));
    expect(again.succeeded).toBe(1);
    expect((await as((ctx) => cmdb.getCi(ctx, ids.lonely))).tags).toEqual(['audit-2026']);

    await as((ctx) => cmdb.bulkUpdateCis(ctx, { ids: [ids.monitor], action: 'ownerTeam', payload: { ownerTeamId: teamId } }));
    expect((await as((ctx) => cmdb.getCi(ctx, ids.monitor))).ownerTeamId).toBe(teamId);
    await as((ctx) => cmdb.bulkUpdateCis(ctx, { ids: [ids.monitor], action: 'ownerTeam', payload: { ownerTeamId: null } }));
    expect((await as((ctx) => cmdb.getCi(ctx, ids.monitor))).ownerTeamId).toBeNull();
    await as((ctx) => cmdb.bulkUpdateCis(ctx, { ids: [ids.monitor], action: 'environment', payload: { environment: 'test' } }));
    await as((ctx) => cmdb.bulkUpdateCis(ctx, { ids: [ids.monitor], action: 'status', payload: { status: 'maintenance' } }));
    expect(await as((ctx) => cmdb.getCi(ctx, ids.monitor))).toMatchObject({ environment: 'test', status: 'maintenance' });

    const retire = await as((ctx) => cmdb.bulkUpdateCis(ctx, { ids: [ids.lonely, ids.stale], action: 'retire', payload: {} }));
    expect(retire.succeeded).toBe(2);
    expect((await as((ctx) => cmdb.getCi(ctx, ids.stale))).status).toBe('retired');
    // retired CIs drop out of "unowned" and "noSite" but stay in the total
    const o = await as((ctx) => cmdb.cmdbOverview(ctx, customerId));
    expect(o.totals).toMatchObject({ total: 9, active: 6, retired: 2, unowned: 3, noSite: 2 });

    await expect(as((ctx) => cmdb.bulkUpdateCis(ctx, { ids: [ids.lonely], action: 'status', payload: {} }))).rejects.toThrow(/payload.status is required/);
    await expect(as((ctx) => cmdb.bulkUpdateCis(ctx, { ids: [ids.lonely], action: 'ownerTeam', payload: { ownerTeamId: missing } }))).rejects.toThrow(/Unknown owner team/);
  });

  it('saved views accept the ci entity', async () => {
    const view = await as((ctx) => views.createView(ctx, { name: `Stale network ${suffix}`, entity: 'ci', filters: { stale: true, typeKey: 'network_switch' }, columns: ['name', 'lastSeenAt'], sort: null }));
    expect(view.entity).toBe('ci');
    const ciViews = await as((ctx) => views.listViews(ctx, 'ci'));
    expect(ciViews.items.some((v) => v.id === view.id)).toBe(true);
    const ticketViews = await as((ctx) => views.listViews(ctx, 'ticket'));
    expect(ticketViews.items.some((v) => v.id === view.id)).toBe(false);
    const asset = await as((ctx) => views.createView(ctx, { name: `Assets ${suffix}`, entity: 'asset', filters: {}, columns: [] }));
    expect(asset.entity).toBe('asset');
    await as((ctx) => views.deleteView(ctx, view.id));
    await as((ctx) => views.deleteView(ctx, asset.id));
  });
});
