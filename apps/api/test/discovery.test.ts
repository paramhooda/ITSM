import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, withSystem, closeDb } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, type Principal } from '../src/core/principal';
import * as cmdb from '../src/modules/cmdb/service';
import * as disc from '../src/modules/discovery/service';
import { reconcileFinding, applyFinding } from '../src/modules/discovery/apply';
import { executeRun } from '../src/modules/discovery/runner';
import { registerProvider } from '../src/modules/discovery/providers';
import type { RawFinding } from '../src/modules/discovery/providers/types';

/**
 * DB-backed tests for the discovery overview, cross-source run list, run
 * cancellation (API + worker), finding detail/stats and source-typed apply.
 * Requires the dev environment (DATABASE_URL etc.) with migrations + seed.
 */
const hasDb = !!process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('x');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rawOf = (ip: string, hostname: string, extra: Partial<RawFinding> = {}): RawFinding => ({ ipAddress: ip, hostname, openPorts: [22], interfaces: [], neighbors: [], raw: { snmp: false }, suggestedTypeKey: 'other', ...extra });

describe.skipIf(!hasDb)('discovery overview, runs, cancel, findings (database)', () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  let customerId = '';
  let siteId = '';
  let admin: Principal;
  const ids: Record<string, string> = {};

  const as = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `test-${suffix}`, source: 'api' }, fn);
  const SYSTEM = { userId: null, userName: 'Discovery', source: 'system' } as const;

  beforeAll(async () => {
    await withSystem(async (tx) => {
      const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
      if (!adminUser) throw new Error('admin user missing (seed not applied?)');
      const p = await loadPrincipal(adminUser.id);
      if (!p) throw new Error('could not load admin principal');
      admin = p;
      const [c] = await tx.insert(schema.customers).values({ code: `DS-${suffix}`, name: `Discovery customer ${suffix}` }).returning();
      customerId = c.id;
      const [s] = await tx.insert(schema.sites).values({ customerId, code: 'LAB', name: 'Lab', isPrimary: true }).returning();
      siteId = s.id;
    });
    const switchType = await typeId('network_switch');
    const sw = await as((ctx) => cmdb.createCi(ctx, { customerId, siteId, typeId: switchType, name: 'lab-sw-01', hostname: 'lab-sw-01', ipAddress: '10.50.0.2', model: 'C9300-24P', manufacturer: 'Cisco' }));
    ids.sw = sw.id;
    await withSystem(async (tx) => {
      const [source] = await tx.insert(schema.discoverySources).values({ customerId, siteId, name: `lab scan ${suffix}`, config: { subnets: ['10.50.0.0/24'] } }).returning();
      ids.source = source.id;
      const now = Date.now();
      // explicit createdAt: rows inserted in one transaction would otherwise share now() and have no stable "most recent" order
      const [completed] = await tx.insert(schema.discoveryRuns).values({ sourceId: source.id, customerId, status: 'completed', createdAt: new Date(now - 121_000), startedAt: new Date(now - 120_000), finishedAt: new Date(now - 60_000), stats: { hostsScanned: 10 }, triggeredBy: admin.id }).returning();
      const [failed] = await tx.insert(schema.discoveryRuns).values({ sourceId: source.id, customerId, status: 'failed', createdAt: new Date(now - 3_601_000), startedAt: new Date(now - 3_600_000), finishedAt: new Date(now - 3_500_000), error: 'boom' }).returning();
      const [queued] = await tx.insert(schema.discoveryRuns).values({ sourceId: source.id, customerId, status: 'queued', createdAt: new Date(now - 5_000) }).returning();
      Object.assign(ids, { completed: completed.id, failed: failed.id, queued: queued.id });
      const target = { sourceId: source.id, runId: completed.id, customerId, siteId };
      const changed = await reconcileFinding(tx, target, rawOf('10.50.0.2', 'lab-sw-01', { model: 'C9300-48P', manufacturer: 'Cisco', suggestedTypeKey: 'network_switch', interfaces: [{ name: 'Gi1/0/1', ifIndex: 1, operStatus: 'up' }], neighbors: [{ protocol: 'lldp', remoteSysName: 'lab-core', remotePort: 'Te1/1' }] }));
      const fresh = await reconcileFinding(tx, target, rawOf('10.50.0.9', 'new-ap', { suggestedTypeKey: 'access_point' }));
      Object.assign(ids, { changedFinding: changed.finding.id, newFinding: fresh.finding.id });
    });
  });

  async function typeId(key: string) {
    const [t] = await withSystem((tx) => tx.select({ id: schema.ciTypes.id }).from(schema.ciTypes).where(eq(schema.ciTypes.key, key)).limit(1));
    return t.id;
  }

  afterAll(async () => {
    if (customerId) await withSystem((tx) => tx.delete(schema.customers).where(eq(schema.customers.id, customerId)));
    await closeDb();
  });

  it('summarises sources, runs, findings, latest runs and per-customer rollups', async () => {
    const o = await as((ctx) => disc.discoveryOverview(ctx, customerId));
    expect(o.sources).toEqual({ total: 1, active: 1, scheduled: 0 });
    expect(o.runs).toEqual({ running: 0, queued: 1, completed7d: 1, failed7d: 1 });
    expect(o.findings).toEqual({ pending: 2, pendingNew: 1, pendingChanged: 1, pendingUnchanged: 0, applied7d: 0, ignored7d: 0 });
    expect(o.lastRuns).toHaveLength(3);
    expect(o.lastRuns.map((r) => r.status)).toEqual(['queued', 'completed', 'failed']);
    expect(o.lastRuns[1]).toMatchObject({ id: ids.completed, sourceId: ids.source, sourceName: `lab scan ${suffix}`, customerId, customerName: `Discovery customer ${suffix}`, triggeredBy: admin.id, triggeredByName: admin.name, stats: { hostsScanned: 10 } });
    expect(o.lastRuns[1].startedAt).toBeInstanceOf(Date);
    expect(o.byCustomer).toEqual([{ customerId, customerName: `Discovery customer ${suffix}`, sources: 1, pendingFindings: 2, lastRunAt: expect.any(Date) }]);
    const all = await as((ctx) => disc.discoveryOverview(ctx));
    expect(all.sources.total).toBeGreaterThanOrEqual(1);
    expect(all.byCustomer.some((c) => c.customerId === customerId)).toBe(true);
  });

  it('lists runs across sources with names, duration and finding counts', async () => {
    const page = await as((ctx) => disc.listAllRuns(ctx, { page: 1, pageSize: 50, customerId }));
    expect(page.total).toBe(3);
    expect(page.items.map((r) => r.status)).toEqual(['queued', 'completed', 'failed']);
    const completed = page.items.find((r) => r.id === ids.completed)!;
    expect(completed).toMatchObject({ sourceName: `lab scan ${suffix}`, customerName: `Discovery customer ${suffix}`, triggeredByName: admin.name, findings: { total: 2, new: 1, changed: 1, unchanged: 0 } });
    expect(completed.durationSec).toBeGreaterThanOrEqual(59);
    expect(completed.durationSec).toBeLessThanOrEqual(61);
    expect(page.items.find((r) => r.id === ids.queued)).toMatchObject({ durationSec: null, findings: { total: 0, new: 0, changed: 0, unchanged: 0 } });
    const failed = await as((ctx) => disc.listAllRuns(ctx, { page: 1, pageSize: 50, customerId, status: 'failed' }));
    expect(failed.total).toBe(1);
    expect(failed.items[0]).toMatchObject({ id: ids.failed, error: 'boom', durationSec: 100 });
    const sorted = await as((ctx) => disc.listAllRuns(ctx, { page: 1, pageSize: 50, sourceId: ids.source, sort: 'status', order: 'asc' }));
    expect(sorted.items.map((r) => r.status)).toEqual(['completed', 'failed', 'queued']);
    const paged = await as((ctx) => disc.listAllRuns(ctx, { page: 2, pageSize: 2, customerId, sort: 'createdAt', order: 'asc' }));
    expect(paged.items.map((r) => r.id)).toEqual([ids.queued]);
  });

  it('aggregates finding stats by status, diff and suggested type', async () => {
    const s = await as((ctx) => disc.findingStats(ctx, { runId: ids.completed }));
    expect(s.byStatus).toEqual({ pending: 2 });
    expect(s.byDiff).toEqual({ new: 1, changed: 1 });
    expect(s.total).toBe(2);
    expect(s.bySuggestedType).toEqual(expect.arrayContaining([{ key: 'network_switch', name: 'Network Switch', count: 1 }, { key: 'access_point', name: 'Access Point', count: 1 }]));
    expect((await as((ctx) => disc.findingStats(ctx, { customerId }))).total).toBe(2);
    expect((await as((ctx) => disc.findingStats(ctx, { sourceId: ids.source, runId: ids.queued }))).total).toBe(0);
  });

  it('returns a finding with source, run, matched CI, field comparison and suggested type', async () => {
    const f = await as((ctx) => disc.getFinding(ctx, ids.changedFinding));
    expect(f.source).toEqual({ id: ids.source, name: `lab scan ${suffix}` });
    expect(f.run).toMatchObject({ id: ids.completed, status: 'completed' });
    expect(f.run?.startedAt).toBeInstanceOf(Date);
    expect(f.matchedCi).toMatchObject({ id: ids.sw, name: 'lab-sw-01', typeKey: 'network_switch', typeName: 'Network Switch', hostname: 'lab-sw-01', ipAddress: '10.50.0.2', model: 'C9300-24P', manufacturer: 'Cisco', status: 'active' });
    expect(f.matchedCi?.lastSeenAt).toBeInstanceOf(Date);
    expect(f.diffStatus).toBe('changed');
    expect(f.changes.map((c) => c.field)).toEqual(['hostname', 'ipAddress', 'macAddress', 'serialNumber', 'model', 'manufacturer']);
    expect(f.changes.find((c) => c.field === 'model')).toEqual({ field: 'model', current: 'C9300-24P', discovered: 'C9300-48P', changed: true });
    expect(f.changes.find((c) => c.field === 'hostname')).toEqual({ field: 'hostname', current: 'lab-sw-01', discovered: 'lab-sw-01', changed: false });
    expect(f.changes.find((c) => c.field === 'serialNumber')).toEqual({ field: 'serialNumber', current: null, discovered: null, changed: false });
    expect(f.interfaces).toEqual([{ name: 'Gi1/0/1', ifIndex: 1, operStatus: 'up' }]);
    expect(f.neighbors).toEqual([{ protocol: 'lldp', remoteSysName: 'lab-core', remotePort: 'Te1/1' }]);
    expect(f.suggestedType).toEqual({ key: 'network_switch', name: 'Network Switch', color: 'green', icon: 'network' });

    const n = await as((ctx) => disc.getFinding(ctx, ids.newFinding));
    expect(n.matchedCi).toBeNull();
    expect(n.changes.every((c) => c.changed === false && c.current === null)).toBe(true);
    expect(n.changes.find((c) => c.field === 'hostname')?.discovered).toBe('new-ap');
    expect(n.suggestedType?.key).toBe('access_point');
    await expect(as((ctx) => disc.getFinding(ctx, '00000000-0000-4000-8000-00000000dead'))).rejects.toThrow(/not found/);
  });

  it('cancels queued runs through the API and refuses finished ones', async () => {
    const run = await as((ctx) => disc.cancelRun(ctx, ids.queued));
    expect(run.status).toBe('cancelled');
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.log).toContain(`Cancelled by ${admin.name}`);
    await expect(as((ctx) => disc.cancelRun(ctx, ids.queued))).rejects.toThrow(/already cancelled/);
    await expect(as((ctx) => disc.cancelRun(ctx, ids.completed))).rejects.toThrow(/already completed/);
    expect((await as((ctx) => disc.discoveryOverview(ctx, customerId))).runs.queued).toBe(0);
    // the worker skips a run that was cancelled while still queued
    await executeRun(ids.queued);
    const [row] = await withSystem((tx) => tx.select({ status: schema.discoveryRuns.status }).from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, ids.queued)));
    expect(row.status).toBe('cancelled');
  });

  it('worker stops a running scan when the run is cancelled and keeps findings reconciled so far', async () => {
    let sawAbort = false;
    let scanStarted = false;
    registerProvider({
      type: `slow_${suffix}`,
      label: 'Slow test provider',
      async discover(_source, ctx) {
        scanStarted = true;
        await ctx.onFinding(rawOf('10.50.1.1', 'slow-host-1'));
        const deadline = Date.now() + 10_000;
        while (!ctx.signal?.aborted && Date.now() < deadline) await sleep(20);
        sawAbort = !!ctx.signal?.aborted;
        return { hostsScanned: 1, responsive: 1, snmp: 0 };
      },
    });
    const [source] = await withSystem((tx) => tx.insert(schema.discoverySources).values({ customerId, siteId, name: `slow ${suffix}`, sourceType: `slow_${suffix}`, config: {} }).returning());
    const [run] = await withSystem((tx) => tx.insert(schema.discoveryRuns).values({ sourceId: source.id, customerId, status: 'queued' }).returning());

    const exec = executeRun(run.id, undefined, { pollMs: 100 });
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const [{ count }] = await withSystem((tx) => tx.select({ count: sql<number>`count(*)::int` }).from(schema.discoveryFindings).where(eq(schema.discoveryFindings.runId, run.id)));
      if (count > 0) break;
      await sleep(25);
    }
    expect(scanStarted).toBe(true);
    const cancelled = await as((ctx) => disc.cancelRun(ctx, run.id));
    expect(cancelled.status).toBe('cancelled');
    await exec;
    expect(sawAbort).toBe(true);

    const [after] = await withSystem((tx) => tx.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, run.id)));
    expect(after.status).toBe('cancelled');
    expect(after.finishedAt).toBeInstanceOf(Date);
    expect(after.log).toContain('Cancellation requested');
    expect(after.log).toContain('Cancelled: 1 scanned');
    expect(after.stats).toMatchObject({ findings: 1, hostsScanned: 1 });
    const [{ count }] = await withSystem((tx) => tx.select({ count: sql<number>`count(*)::int` }).from(schema.discoveryFindings).where(eq(schema.discoveryFindings.runId, run.id)));
    expect(count).toBe(1);
    const runs = await as((ctx) => disc.listAllRuns(ctx, { page: 1, pageSize: 10, sourceId: source.id }));
    expect(runs.items[0]).toMatchObject({ status: 'cancelled', findings: { total: 1, new: 1 } });
  });

  it('stamps the CI discoverySource with the source type when a finding is applied', async () => {
    const [source] = await withSystem((tx) => tx.insert(schema.discoverySources).values({ customerId, siteId, name: `agent ${suffix}`, sourceType: 'agent_x', config: {} }).returning());
    const [run] = await withSystem((tx) => tx.insert(schema.discoveryRuns).values({ sourceId: source.id, customerId, status: 'running' }).returning());
    const { finding } = await withSystem((tx) => reconcileFinding(tx, { sourceId: source.id, runId: run.id, customerId, siteId }, rawOf('10.50.0.77', 'agent-host')));
    const applied = await withSystem((tx) => applyFinding(tx, finding, SYSTEM));
    expect(applied.created).toBe(true);
    expect(applied.ci.discoverySource).toBe('agent_x');
    // and the network-scan source keeps the familiar value
    const [sw] = await withSystem((tx) => tx.select().from(schema.discoveryFindings).where(eq(schema.discoveryFindings.id, ids.changedFinding)));
    const reapplied = await withSystem((tx) => applyFinding(tx, sw, SYSTEM));
    expect(reapplied.created).toBe(false);
    expect(reapplied.ci.discoverySource).toBe('network_scan');
    expect(reapplied.ci.model).toBe('C9300-48P');
    // remaining: the untouched new finding + the one reconciled by the cancelled slow run
    const stats = await as((ctx) => disc.findingStats(ctx, { customerId }));
    expect(stats.byStatus).toEqual({ pending: 2, applied: 2 });
    expect((await as((ctx) => disc.discoveryOverview(ctx, customerId))).findings).toMatchObject({ pending: 2, pendingNew: 2, applied7d: 2 });
  });
});
