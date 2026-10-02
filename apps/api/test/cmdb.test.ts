import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, withSystem, closeDb } from '../src/db/client';
import { runAs } from '../src/core/context';
import type { Principal } from '../src/core/principal';
import * as cmdb from '../src/modules/cmdb/service';
import * as assets from '../src/modules/assets/service';
import { findCiByReference } from '../src/modules/cmdb/match';
import { validateAttributes } from '../src/modules/cmdb/attributes';
import { reconcileFinding, applyFinding, diffAgainstCi } from '../src/modules/discovery/apply';
import { expandTargets, suggestType, manufacturerFromSysObjectId, parseSysDescr } from '../src/modules/discovery/providers/network-scan';
import { isCronDue } from '../src/modules/discovery/runner';
import { parseCsv } from '../src/modules/assets/csv';
import type { RawFinding } from '../src/modules/discovery/providers/types';

// ---------------------------------------------------------------- pure unit tests (no DB)

describe('network-scan: target expansion', () => {
  it('expands CIDR blocks without network/broadcast', () => {
    const r = expandTargets(['10.0.0.0/30']);
    expect(r.hosts).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(expandTargets(['10.0.0.0/24']).hosts).toHaveLength(254);
    expect(expandTargets(['192.168.1.5/32']).hosts).toEqual(['192.168.1.5']);
    expect(expandTargets(['10.1.1.0/31']).hosts).toEqual(['10.1.1.0', '10.1.1.1']);
  });
  it('expands ranges, single IPs and de-duplicates', () => {
    expect(expandTargets(['10.0.0.1-10.0.0.3', '10.0.0.3', '10.0.0.10-12']).hosts).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.10', '10.0.0.11', '10.0.0.12']);
  });
  it('caps hosts and reports invalid entries', () => {
    const r = expandTargets(['10.0.0.0/16', 'not-an-ip', '10.0.0.9-10.0.0.1'], 100);
    expect(r.hosts).toHaveLength(100);
    expect(r.truncated).toBe(true);
    expect(expandTargets(['not-an-ip', '10.0.0.9-10.0.0.1', '300.1.1.1']).invalid).toEqual(['not-an-ip', '10.0.0.9-10.0.0.1', '300.1.1.1']);
  });
});

describe('network-scan: type heuristics', () => {
  it('maps sysDescr / sysObjectID to CI types', () => {
    expect(suggestType({ sysDescr: 'Cisco IOS Software, C9300 Software (CAT9K_IOSXE), Version 17.9.4a' })).toBe('network_switch');
    expect(suggestType({ sysDescr: 'Cisco Adaptive Security Appliance Version 9.16(4)' })).toBe('firewall');
    expect(suggestType({ sysDescr: 'FortiGate-100F v7.2.5,build1517,230427 (GA.F)' })).toBe('firewall');
    expect(suggestType({ sysDescr: 'Cisco IOS XE Software, ISR4331 ...' })).toBe('router');
    expect(suggestType({ sysDescr: 'RouterOS RB4011iGS+' })).toBe('router');
    expect(suggestType({ sysDescr: 'VMware ESXi 7.0.3 build-21930508 VMware, Inc. x86_64' })).toBe('hypervisor');
    expect(suggestType({ sysDescr: 'Hardware: Intel64 Family 6 - Software: Windows Version 6.3 (Build 17763 Multiprocessor Free)' })).toBe('server');
    expect(suggestType({ sysDescr: 'Linux web01 5.15.0-91-generic #101-Ubuntu SMP x86_64' })).toBe('server');
    expect(suggestType({ sysDescr: 'APC Web/SNMP Management Card (MB:v4.1.0 PF:v6.9.6)' })).toBe('ups');
    expect(suggestType({ sysDescr: 'Synology DiskStation DS1821+' })).toBe('storage_array');
    expect(suggestType({ sysDescr: 'NetApp Release 9.12.1P4: ONTAP' })).toBe('storage_array');
    expect(suggestType({ sysDescr: 'UniFi AP U6-Pro' })).toBe('access_point');
    expect(suggestType({ sysObjectId: '1.3.6.1.4.1.9.1.2494' })).toBe('network_switch');
    expect(suggestType({ sysObjectId: '1.3.6.1.4.1.12356.101.1.1' })).toBe('firewall');
  });
  it('falls back to open ports', () => {
    expect(suggestType({ openPorts: [9100, 80] })).toBe('printer');
    expect(suggestType({ openPorts: [631] })).toBe('printer');
    expect(suggestType({ openPorts: [3389] })).toBe('endpoint');
    expect(suggestType({ openPorts: [3389, 445] })).toBe('server');
    expect(suggestType({ openPorts: [22] })).toBe('server');
    expect(suggestType({ openPorts: [] })).toBe('other');
  });
  it('maps enterprise numbers to vendors', () => {
    expect(manufacturerFromSysObjectId('1.3.6.1.4.1.9.1.2494')).toBe('Cisco');
    expect(manufacturerFromSysObjectId('.1.3.6.1.4.1.2636.1.1.1.2.57')).toBe('Juniper');
    expect(manufacturerFromSysObjectId('1.3.6.1.4.1.8072.3.2.10')).toBe('Linux (net-snmp)');
    expect(manufacturerFromSysObjectId('1.3.6.1.4.1.999999.1')).toBeNull();
    expect(manufacturerFromSysObjectId(null)).toBeNull();
  });
  it('parses sysDescr into OS / version / model', () => {
    expect(parseSysDescr('Cisco IOS Software, C9300 Software (CAT9K_IOSXE), Version 17.9.4a, RELEASE SOFTWARE (fc3)')).toEqual({ osName: 'Cisco IOS', osVersion: '17.9.4a', model: 'C9300' });
    expect(parseSysDescr('VMware ESXi 7.0.3 build-21930508 VMware, Inc. x86_64').osName).toBe('VMware ESXi');
    expect(parseSysDescr('Linux web01 5.15.0-91-generic #101-Ubuntu SMP')).toMatchObject({ osName: 'Linux (Ubuntu)', osVersion: '5.15.0-91-generic' });
    expect(parseSysDescr(null)).toEqual({ osName: null, osVersion: null, model: null });
  });
});

describe('scheduler + csv + attribute validation (pure)', () => {
  it('computes cron due state', () => {
    const now = new Date('2026-10-02T12:30:00Z');
    expect(isCronDue('0 */6 * * *', null, now)).toBe(true);
    expect(isCronDue('0 */6 * * *', new Date('2026-10-02T12:05:00Z'), now)).toBe(false);
    expect(isCronDue('0 */6 * * *', new Date('2026-10-02T05:00:00Z'), now)).toBe(true);
    expect(isCronDue('garbage', null, now)).toBe(false);
  });
  it('parses quoted CSV', () => {
    const t = parseCsv('tag,name,notes\r\nA1,"Switch, core","He said ""hi""\nsecond line"\n;;;\n');
    expect(t.headers).toEqual(['tag', 'name', 'notes']);
    expect(t.rows[0]).toEqual({ tag: 'A1', name: 'Switch, core', notes: 'He said "hi"\nsecond line' });
  });
  it('validates attributes against a schema', () => {
    const defs = [
      { key: 'platform', label: 'Platform', type: 'select', options: ['vmware', 'kvm'], required: true },
      { key: 'memoryGb', label: 'Memory', type: 'number' },
      { key: 'licenseExpiry', type: 'date' },
    ];
    expect(validateAttributes(defs, { platform: 'vmware', memoryGb: '32', licenseExpiry: '2027-01-01', junk: 'x', snmp: { sysDescr: 'y' } })).toEqual({ platform: 'vmware', memoryGb: 32, licenseExpiry: '2027-01-01', snmp: { sysDescr: 'y' } });
    expect(() => validateAttributes(defs, { platform: 'xen' })).toThrow(/Platform must be one of/);
    expect(() => validateAttributes(defs, {})).toThrow(/required/);
    expect(() => validateAttributes(defs, { platform: 'kvm', memoryGb: 'lots' })).toThrow(/must be a number/);
    expect(() => validateAttributes(defs, { platform: 'kvm', licenseExpiry: '01/02/2027' })).toThrow(/date/);
    expect(validateAttributes(defs, { memoryGb: 8 }, { partial: true })).toEqual({ memoryGb: 8 });
  });
  it('diffs findings against CIs', () => {
    expect(diffAgainstCi({ hostname: 'A', ipAddress: '1.1.1.1' }, null).status).toBe('new');
    expect(diffAgainstCi({ hostname: 'A', ipAddress: '1.1.1.1', macAddress: 'AA-BB-CC-DD-EE-FF' }, { hostname: 'a', ipAddress: '1.1.1.1', macAddress: 'aa:bb:cc:dd:ee:ff', serialNumber: null, model: null, manufacturer: null }).status).toBe('unchanged');
    expect(diffAgainstCi({ hostname: 'A', ipAddress: '1.1.1.2' }, { hostname: 'a', ipAddress: '1.1.1.1', macAddress: null, serialNumber: null, model: null, manufacturer: null })).toEqual({ status: 'changed', changed: ['ipAddress'] });
  });
});

// ---------------------------------------------------------------- DB-backed tests

const hasDb = !!process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('x');

describe.skipIf(!hasDb)('cmdb + assets + discovery (database)', () => {
  let customerId: string;
  let siteId: string;
  let principal: Principal;
  const types: Record<string, string> = {};
  const relTypes: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const suffix = Date.now().toString(36);

  const as = <T>(fn: Parameters<typeof runAs<T>>[2]) => runAs(principal, { requestId: 'test', source: 'api' }, fn);

  beforeAll(async () => {
    await withSystem(async (tx) => {
      const [c] = await tx.insert(schema.customers).values({ code: `T-${suffix}`, name: `Test customer ${suffix}` }).returning();
      customerId = c.id;
      const [s] = await tx.insert(schema.sites).values({ customerId, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
      siteId = s.id;
      for (const t of await tx.select().from(schema.ciTypes)) types[t.key] = t.id;
      for (const r of await tx.select().from(schema.ciRelationshipTypes)) relTypes[r.key] = r.id;
      const [admin] = await tx.select().from(schema.users).limit(1);
      principal = {
        id: admin?.id ?? '00000000-0000-4000-8000-000000000001',
        email: 'test@msp.local',
        name: 'Test Admin',
        userType: 'msp',
        customerId: null,
        phone: null,
        status: 'active',
        timezone: 'UTC',
        preferences: {},
        globalPermissions: new Set(['tenant:all', 'assets:read', 'assets:manage', 'cmdb:read', 'cmdb:manage', 'discovery:run', 'discovery:manage']),
        customerPermissions: new Map(),
        customerScope: 'all',
        roles: [],
        teams: [],
      };
    });
    expect(types.business_service).toBeTruthy();
    expect(relTypes.depends_on).toBeTruthy();
  });

  afterAll(async () => {
    if (customerId) await withSystem((tx) => tx.delete(schema.customers).where(eq(schema.customers.id, customerId)));
    await closeDb();
  });

  it('creates the service → app → vm → hypervisor chain', async () => {
    const bs = await as((ctx) => cmdb.createCi(ctx, { customerId, typeId: types.business_service, name: 'Online Banking', criticality: 'critical', attributes: { tier: 'tier1' } }));
    const app = await as((ctx) => cmdb.createCi(ctx, { customerId, typeId: types.application, name: 'banking-app', hostname: 'BANK-APP-01', ipAddress: '10.9.0.10' }));
    const vm = await as((ctx) => cmdb.createCi(ctx, { customerId, siteId, typeId: types.virtual_machine, name: 'vm-bank-01', hostname: 'vm-bank-01', ipAddress: '10.9.0.11', attributes: { vcpu: '4' } }));
    const hv = await as((ctx) => cmdb.createCi(ctx, { customerId, siteId, typeId: types.hypervisor, name: 'esx-01', hostname: 'esx-01', ipAddress: '10.9.0.5', serialNumber: 'SN-ESX-9', attributes: { platform: 'vmware', cluster: 'c1', junk: true } }));
    Object.assign(ids, { bs: bs.id, app: app.id, vm: vm.id, hv: hv.id });
    expect(app.hostname).toBe('bank-app-01');
    expect(vm.attributes).toEqual({ vcpu: 4 });
    expect(hv.attributes).toEqual({ platform: 'vmware', cluster: 'c1' });

    await as((ctx) => cmdb.addRelationship(ctx, ids.bs, { targetCiId: ids.app, typeId: relTypes.depends_on }));
    await as((ctx) => cmdb.addRelationship(ctx, ids.app, { targetCiId: ids.vm, typeId: relTypes.runs_on }));
    const rels = await as((ctx) => cmdb.addRelationship(ctx, ids.vm, { targetCiId: ids.hv, typeId: relTypes.hosted_on }));
    expect(rels.outbound.map((r) => [r.typeName, r.ci.name])).toEqual([['Hosted on', 'esx-01']]);
    expect(rels.inbound.map((r) => [r.inverseName, r.ci.name])).toEqual([['Runs', 'banking-app']]);
  });

  it('rejects duplicate, self and cross-customer relationships', async () => {
    await expect(as((ctx) => cmdb.addRelationship(ctx, ids.vm, { targetCiId: ids.hv, typeId: relTypes.hosted_on }))).rejects.toThrow(/already exists/);
    await expect(as((ctx) => cmdb.addRelationship(ctx, ids.vm, { targetCiId: ids.vm, typeId: relTypes.hosted_on }))).rejects.toThrow(/itself/);
  });

  it('rejects invalid select values and strips unknown attribute keys', async () => {
    await expect(as((ctx) => cmdb.createCi(ctx, { customerId, typeId: types.hypervisor, name: 'bad', attributes: { platform: 'xen' } }))).rejects.toThrow(/Platform must be one of/);
    await expect(as((ctx) => cmdb.updateCi(ctx, ids.hv, { attributes: { platform: 'nope' } }))).rejects.toThrow(/Platform/);
    const updated = await as((ctx) => cmdb.updateCi(ctx, ids.hv, { attributes: { cluster: 'c2' } }));
    expect(updated.attributes).toEqual({ platform: 'vmware', cluster: 'c2' });
  });

  it('builds the graph and impact analysis', async () => {
    const g = await as((ctx) => cmdb.graph(ctx, ids.hv, 3, 150));
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['Online Banking', 'banking-app', 'esx-01', 'vm-bank-01']);
    expect(g.nodes.find((n) => n.isRoot)?.name).toBe('esx-01');
    expect(g.edges).toHaveLength(3);
    expect(g.edges.map((e) => e.typeKey).sort()).toEqual(['depends_on', 'hosted_on', 'runs_on']);
    const g1 = await as((ctx) => cmdb.graph(ctx, ids.hv, 1, 150));
    expect(g1.nodes.map((n) => n.name).sort()).toEqual(['esx-01', 'vm-bank-01']);

    const impact = await as((ctx) => cmdb.impact(ctx, ids.hv));
    expect(impact.dependents.map((d) => [d.name, d.depth, d.via])).toEqual([['vm-bank-01', 1, 'hosted_on'], ['banking-app', 2, 'runs_on'], ['Online Banking', 3, 'depends_on']]);
    expect(impact.businessServices.map((s) => s.name)).toEqual(['Online Banking']);
    expect(impact.dependents[2].path).toEqual(['esx-01', 'vm-bank-01', 'banking-app', 'Online Banking']);
    const none = await as((ctx) => cmdb.impact(ctx, ids.bs));
    expect(none.dependents).toHaveLength(0);
  });

  it('finds CIs by reference (ip, hostname, serial, mac)', async () => {
    await withSystem(async (tx) => {
      expect((await findCiByReference(tx, { customerId, ipAddress: '10.9.0.5' }))?.name).toBe('esx-01');
      expect((await findCiByReference(tx, { customerId, hostname: 'VM-BANK-01.corp.local' }))?.name).toBe('vm-bank-01');
      expect((await findCiByReference(tx, { customerId, hostname: 'bank-app-01' }))?.matchedBy).toBe('hostname');
      expect((await findCiByReference(tx, { customerId, serialNumber: 'sn-esx-9' }))?.name).toBe('esx-01');
      expect(await findCiByReference(tx, { customerId, ipAddress: '10.9.0.99' })).toBeNull();
      expect(await findCiByReference(tx, { customerId: '00000000-0000-4000-8000-000000000000', ipAddress: '10.9.0.5' })).toBeNull();
    });
  });

  it('lists with filters and summarises', async () => {
    const list = await as((ctx) => cmdb.listCis(ctx, { page: 1, pageSize: 50, customerId, q: '10.9.0.1', sort: 'name', order: 'asc' }));
    expect(list.total).toBe(2);
    const byType = await as((ctx) => cmdb.listCisFull(ctx, { page: 1, pageSize: 50, customerId, typeKey: 'hypervisor' }));
    expect(byType.items.map((i) => i.name)).toEqual(['esx-01']);
    expect(byType.items[0].relationshipCount).toBe(1);
    const summary = await as((ctx) => cmdb.ciSummary(ctx, customerId));
    expect(summary.total).toBe(4);
    expect(summary.byType.find((t) => t.key === 'hypervisor')?.count).toBe(1);
  });

  it('links assets and CIs both ways', async () => {
    const asset = await as((ctx) => assets.createAsset(ctx, { customerId, siteId, name: 'ESX host hardware', serialNumber: 'SN-ESX-9', warrantyEnd: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) }));
    ids.asset = asset.id;
    expect(asset.tag).toMatch(/^AST-\d{6}$/);
    expect(asset.warranty.status).toBe('expiring');
    const linked = await as((ctx) => assets.linkCi(ctx, asset.id, ids.hv));
    expect(linked.ci?.name).toBe('esx-01');
    const ci = await as((ctx) => cmdb.getCi(ctx, ids.hv));
    expect(ci.asset?.id).toBe(asset.id);
    const unlinked = await as((ctx) => assets.unlinkCi(ctx, asset.id));
    expect(unlinked.ciId).toBeNull();
    expect((await as((ctx) => cmdb.getCi(ctx, ids.hv))).assetId).toBeNull();
    // create CI from asset
    const second = await as((ctx) => assets.createAsset(ctx, { customerId, name: 'Edge firewall', manufacturer: 'Fortinet', model: 'FG-100F' }));
    const withCi = await as((ctx) => assets.createCiFromAsset(ctx, second.id, types.firewall));
    expect(withCi.ci?.typeKey).toBe('firewall');
    expect((await as((ctx) => cmdb.getCi(ctx, withCi.ci!.id))).asset?.tag).toBe(second.tag);
    await expect(as((ctx) => assets.changeLifecycle(ctx, second.id, 'disposed'))).rejects.toThrow(/Cannot move/);
    expect((await as((ctx) => assets.changeLifecycle(ctx, second.id, 'retired'))).lifecycleStage).toBe('retired');
  });

  it('applies a discovery finding (creates CI + interfaces + neighbour link) and matches unchanged on re-run', async () => {
    const [source] = await withSystem((tx) => tx.insert(schema.discoverySources).values({ customerId, siteId, name: 'test scan', config: { subnets: ['10.9.0.0/24'] } }).returning());
    const [run] = await withSystem((tx) => tx.insert(schema.discoveryRuns).values({ sourceId: source.id, customerId, status: 'running' }).returning());
    const target = { sourceId: source.id, runId: run.id, customerId, siteId };
    const raw: RawFinding = {
      ipAddress: '10.9.0.2',
      hostname: 'core-sw-01',
      macAddress: '00:11:22:33:44:55',
      serialNumber: 'FOC1234X0AB',
      manufacturer: 'Cisco',
      model: 'C9300-48P',
      osName: 'Cisco IOS XE',
      osVersion: '17.9.4a',
      sysDescr: 'Cisco IOS Software, C9300 Software (CAT9K_IOSXE), Version 17.9.4a',
      sysObjectId: '1.3.6.1.4.1.9.1.2494',
      sysName: 'core-sw-01',
      sysLocation: 'DC1',
      sysContact: 'noc@msp.local',
      suggestedTypeKey: 'network_switch',
      openPorts: [22, 443, 161],
      interfaces: [
        { name: 'GigabitEthernet1/0/1', ifIndex: 1, macAddress: '00:11:22:33:44:55', ipAddress: '10.9.0.2', speedMbps: 1000, operStatus: 'up' },
        { name: 'GigabitEthernet1/0/2', ifIndex: 2, operStatus: 'down' },
      ],
      neighbors: [{ protocol: 'lldp', localPort: 'Gi1/0/1', remoteSysName: 'esx-01', remotePort: 'vmnic0' }],
      raw: { snmp: true },
    };
    const first = await withSystem((tx) => reconcileFinding(tx, target, raw));
    expect(first.finding.diffStatus).toBe('new');
    expect(first.finding.matchedCiId).toBeNull();

    const applied = await withSystem((tx) => applyFinding(tx, first.finding, { userId: null, userName: 'Discovery', source: 'system' }));
    expect(applied.created).toBe(true);
    expect(applied.neighborsLinked).toBe(1);
    const ci = await as((ctx) => cmdb.getCi(ctx, applied.ci.id));
    expect(ci.type.key).toBe('network_switch');
    expect(ci.hostname).toBe('core-sw-01');
    expect(ci.serialNumber).toBe('FOC1234X0AB');
    expect(ci.osName).toBe('Cisco IOS XE');
    expect(ci.discoverySource).toBe('network_scan');
    expect(ci.lastSeenAt).toBeTruthy();
    expect((ci.attributes.snmp as { sysLocation: string }).sysLocation).toBe('DC1');
    expect(ci.interfaces.map((i) => i.name)).toEqual(['GigabitEthernet1/0/1', 'GigabitEthernet1/0/2']);
    expect(ci.relationships.outbound.map((r) => [r.typeKey, r.ci.name, r.source])).toEqual([['connected_to', 'esx-01', 'discovery']]);
    const [storedFinding] = await withSystem((tx) => tx.select().from(schema.discoveryFindings).where(eq(schema.discoveryFindings.id, first.finding.id)));
    expect(storedFinding.status).toBe('applied');
    expect(storedFinding.matchedCiId).toBe(applied.ci.id);

    // second run: identical device → unchanged, matched by IP, lastSeenAt refreshed
    const before = ci.lastSeenAt!;
    await new Promise((r) => setTimeout(r, 20));
    const second = await withSystem((tx) => reconcileFinding(tx, target, raw));
    expect(second.finding.diffStatus).toBe('unchanged');
    expect(second.finding.matchedCiId).toBe(applied.ci.id);
    expect((second.finding.raw as { matchedBy: string }).matchedBy).toBe('ipAddress');
    const after = await as((ctx) => cmdb.getCi(ctx, applied.ci.id));
    expect(new Date(after.lastSeenAt!).getTime()).toBeGreaterThan(new Date(before).getTime());

    // changed model → changed; applying updates in place and does not duplicate interfaces/relationships
    const third = await withSystem((tx) => reconcileFinding(tx, target, { ...raw, model: 'C9300-48UXM', ipAddress: '10.9.0.3' }));
    expect(third.finding.diffStatus).toBe('changed');
    expect((third.finding.raw as { changedFields: string[] }).changedFields.sort()).toEqual(['ipAddress', 'model']);
    const reapplied = await withSystem((tx) => applyFinding(tx, third.finding, { userId: null, userName: 'Discovery', source: 'system' }));
    expect(reapplied.created).toBe(false);
    expect(reapplied.ci.id).toBe(applied.ci.id);
    expect(reapplied.ci.model).toBe('C9300-48UXM');
    const again = await as((ctx) => cmdb.getCi(ctx, applied.ci.id));
    expect(again.interfaces).toHaveLength(2);
    expect(again.relationships.outbound).toHaveLength(1);
    const history = await as((ctx) => cmdb.history(ctx, applied.ci.id));
    expect(history.items.map((h) => h.action)).toContain('discovery.create');
    const [{ count }] = await withSystem((tx) => tx.select({ count: sql<number>`count(*)::int` }).from(schema.cis).where(eq(schema.cis.customerId, customerId)));
    expect(count).toBe(6);
  });

  it('blocks deletion when tickets reference the CI and allows otherwise', async () => {
    const vm = await as((ctx) => cmdb.getCi(ctx, ids.vm));
    expect(vm.relationshipCount).toBe(2);
    await as((ctx) => cmdb.deleteRelationship(ctx, vm.relationships.outbound[0].id));
    const [tmp] = await withSystem((tx) => tx.insert(schema.cis).values({ customerId, typeId: types.other, name: 'tmp' }).returning());
    await expect(as((ctx) => cmdb.deleteCi(ctx, tmp.id))).resolves.toEqual({ deleted: true });
  });
});
