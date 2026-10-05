import { eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { productKey } from '@/modules/software/service';
import { user, type DemoState } from './state';
import { addDays, hashHex, isoDate } from './rng';

/**
 * Software asset management demo data for ABC Manufacturing, Meridian Bank
 * and Northwind Pharma: a shared catalogue of thirteen titles, installations
 * derived from the committed CIs (servers, hypervisors, backup servers,
 * databases, virtual machines) plus imported endpoint and named-user rows, and
 * licences chosen so every compliance position, the expiring and expired
 * states and one renewed licence appear.
 */

interface TitleSpec { key: string; publisher: string; name: string; versionFamily: string | null; licenceModel: string; categoryKey: string; website?: string }

const TITLES: TitleSpec[] = [
  { key: 'winsrv', publisher: 'Microsoft', name: 'Windows Server', versionFamily: '2022', licenceModel: 'per_core', categoryKey: 'operating_system' },
  { key: 'sql', publisher: 'Microsoft', name: 'SQL Server Standard', versionFamily: '2019', licenceModel: 'per_core', categoryKey: 'database' },
  { key: 'm365', publisher: 'Microsoft', name: 'Microsoft 365 E3', versionFamily: null, licenceModel: 'subscription', categoryKey: 'productivity' },
  { key: 'office', publisher: 'Microsoft', name: 'Office LTSC', versionFamily: '2021', licenceModel: 'per_device', categoryKey: 'productivity' },
  { key: 'vsphere', publisher: 'VMware', name: 'vSphere Enterprise Plus', versionFamily: '8', licenceModel: 'per_core', categoryKey: 'virtualisation' },
  { key: 'veeam', publisher: 'Veeam', name: 'Backup & Replication', versionFamily: '12', licenceModel: 'per_device', categoryKey: 'backup' },
  { key: 'forti', publisher: 'Fortinet', name: 'FortiClient EMS', versionFamily: null, licenceModel: 'per_user', categoryKey: 'security' },
  { key: 'acrobat', publisher: 'Adobe', name: 'Acrobat Pro', versionFamily: null, licenceModel: 'subscription', categoryKey: 'productivity' },
  { key: 'rhel', publisher: 'Red Hat', name: 'Enterprise Linux', versionFamily: '9', licenceModel: 'subscription', categoryKey: 'operating_system' },
  { key: 'oracle', publisher: 'Oracle', name: 'Database Enterprise', versionFamily: '19c', licenceModel: 'per_core', categoryKey: 'database' },
  { key: 'zoom', publisher: 'Zoom', name: 'Workplace', versionFamily: null, licenceModel: 'subscription', categoryKey: 'collaboration' },
  { key: 'autocad', publisher: 'Autodesk', name: 'AutoCAD', versionFamily: '2025', licenceModel: 'subscription', categoryKey: 'design' },
  { key: 'sap', publisher: 'SAP', name: 'ERP named user', versionFamily: null, licenceModel: 'per_user', categoryKey: 'business_application' },
];

interface LicenceSpec { cust: string; name: string; title: string; metric: string; term: string; qty: number; start: number; end: number | null; renewal: number | null; contract: string | null; cost: number; renewedBy?: string; id?: string }

const LICENCES: LicenceSpec[] = [
  { cust: 'abc', name: 'Microsoft 365 E3 annual (250)', title: 'm365', metric: 'per_user', term: 'subscription', qty: 250, start: -320, end: 45, renewal: 30, contract: 'abc_ms', cost: 7_500_000 },
  { cust: 'abc', name: 'Windows Server 2022 16-core packs (3)', title: 'winsrv', metric: 'per_core', term: 'perpetual', qty: 48, start: -400, end: null, renewal: null, contract: 'abc_amc', cost: 960_000 },
  { cust: 'abc', name: 'SQL Server 2019 Std 2-core packs', title: 'sql', metric: 'per_core', term: 'perpetual', qty: 8, start: -400, end: null, renewal: null, contract: 'abc_amc', cost: 920_000 },
  { cust: 'abc', name: 'Veeam B&R sockets', title: 'veeam', metric: 'per_device', term: 'subscription', qty: 10, start: -200, end: 165, renewal: 150, contract: 'abc_ms', cost: 410_000 },
  { cust: 'abc', name: 'Office LTSC 2021 devices', title: 'office', metric: 'per_device', term: 'perpetual', qty: 40, start: -600, end: null, renewal: null, contract: null, cost: 1_100_000 },
  { cust: 'abc', name: 'FortiClient EMS subscription', title: 'forti', metric: 'per_user', term: 'subscription', qty: 300, start: -100, end: 265, renewal: 250, contract: 'abc_ms', cost: 540_000 },
  { cust: 'abc', name: 'AutoCAD 2025 seats', title: 'autocad', metric: 'per_user', term: 'subscription', qty: 5, start: -60, end: 305, renewal: 290, contract: null, cost: 1_250_000 },
  { cust: 'abc', name: 'Acrobat Pro (expired)', title: 'acrobat', metric: 'per_user', term: 'subscription', qty: 20, start: -385, end: -20, renewal: -35, contract: null, cost: 380_000 },
  { cust: 'abc', name: 'vSphere 8 Ent Plus 32-core', title: 'vsphere', metric: 'per_core', term: 'subscription', qty: 64, start: -300, end: 65, renewal: 50, contract: 'abc_ms', cost: 2_600_000 },
  { cust: 'abc', name: 'SAP ERP named users (40)', title: 'sap', metric: 'per_user', term: 'subscription', qty: 40, start: -150, end: 215, renewal: 200, contract: null, cost: 4_800_000 },
  { cust: 'abc', name: 'RHEL 9 subscriptions (4)', title: 'rhel', metric: 'per_device', term: 'subscription', qty: 4, start: -120, end: 245, renewal: 230, contract: 'abc_amc', cost: 140_000 },
  { cust: 'meridian', name: 'Microsoft 365 E3 annual (200) 2025', title: 'm365', metric: 'per_user', term: 'subscription', qty: 200, start: -565, end: -201, renewal: -216, contract: 'mrd_ms', cost: 5_800_000, renewedBy: 'Microsoft 365 E3 annual (200)' },
  { cust: 'meridian', name: 'Microsoft 365 E3 annual (200)', title: 'm365', metric: 'per_user', term: 'subscription', qty: 200, start: -200, end: 160, renewal: 145, contract: 'mrd_ms', cost: 6_000_000 },
  { cust: 'meridian', name: 'Windows Server 2022 cores', title: 'winsrv', metric: 'per_core', term: 'perpetual', qty: 96, start: -500, end: null, renewal: null, contract: 'mrd_ms', cost: 1_920_000 },
  { cust: 'meridian', name: 'Oracle DB 19c EE processor (HO + DR)', title: 'oracle', metric: 'per_core', term: 'perpetual', qty: 32, start: -700, end: null, renewal: null, contract: null, cost: 19_600_000 },
  { cust: 'meridian', name: 'FortiClient EMS', title: 'forti', metric: 'per_user', term: 'subscription', qty: 250, start: -150, end: 215, renewal: 200, contract: 'mrd_soc', cost: 450_000 },
  { cust: 'meridian', name: 'vSphere 8 cores', title: 'vsphere', metric: 'per_core', term: 'subscription', qty: 96, start: -250, end: 115, renewal: 100, contract: 'mrd_ms', cost: 3_900_000 },
  { cust: 'meridian', name: 'Veeam sockets', title: 'veeam', metric: 'per_device', term: 'subscription', qty: 12, start: -250, end: 115, renewal: 100, contract: 'mrd_ms', cost: 490_000 },
  { cust: 'meridian', name: 'Zoom Workplace', title: 'zoom', metric: 'per_user', term: 'subscription', qty: 150, start: -90, end: 275, renewal: 260, contract: null, cost: 900_000 },
  { cust: 'meridian', name: 'Acrobat Pro', title: 'acrobat', metric: 'per_user', term: 'subscription', qty: 30, start: -120, end: 245, renewal: 230, contract: null, cost: 570_000 },
  { cust: 'meridian', name: 'RHEL 9 subscriptions', title: 'rhel', metric: 'per_device', term: 'subscription', qty: 10, start: -30, end: 335, renewal: 320, contract: 'mrd_ms', cost: 350_000 },
  { cust: 'northwind', name: 'Microsoft 365 E3 (150)', title: 'm365', metric: 'per_user', term: 'subscription', qty: 150, start: -345, end: 20, renewal: 10, contract: 'nwp_ms', cost: 4_500_000 },
  { cust: 'northwind', name: 'Windows Server 2022 cores', title: 'winsrv', metric: 'per_core', term: 'perpetual', qty: 24, start: -380, end: null, renewal: null, contract: 'nwp_amc', cost: 480_000 },
  { cust: 'northwind', name: 'Office LTSC 2021', title: 'office', metric: 'per_device', term: 'perpetual', qty: 60, start: -500, end: null, renewal: null, contract: null, cost: 1_650_000 },
  { cust: 'northwind', name: 'Veeam sockets', title: 'veeam', metric: 'per_device', term: 'subscription', qty: 1, start: -180, end: 185, renewal: 170, contract: 'nwp_amc', cost: 41_000 },
  { cust: 'northwind', name: 'RHEL 9', title: 'rhel', metric: 'per_device', term: 'subscription', qty: 10, start: -60, end: 305, renewal: 290, contract: 'nwp_ms', cost: 350_000 },
  { cust: 'northwind', name: 'vSphere 8 Standard 64-core', title: 'vsphere', metric: 'per_core', term: 'subscription', qty: 64, start: -280, end: 85, renewal: 70, contract: 'nwp_amc', cost: 1_300_000 },
];

/** Endpoint software per customer (every endpoint gets the first entries; every third endpoint also gets `third`). Named-user rows per customer for Microsoft 365. */
const ENDPOINTS: Record<string, { count: number; titles: string[]; third?: string; m365: number }> = {
  abc: { count: 48, titles: ['office', 'forti'], third: 'acrobat', m365: 262 },
  meridian: { count: 36, titles: ['forti'], third: 'acrobat', m365: 180 },
  northwind: { count: 52, titles: ['office'], m365: 100 },
};

const SOFTWARE_CUSTOMERS = ['abc', 'meridian', 'northwind'];

export async function seedSoftware(state: DemoState, tx: Tx) {
  const { refs, rng, now } = state;
  const owner = user(state, 'lakshmi').id;

  // Catalogue (shared; idempotent on the normalised key)
  const productRows = TITLES.map((t) => ({ key: productKey(t.publisher, t.name, t.versionFamily), publisher: t.publisher, name: t.name, versionFamily: t.versionFamily, licenceModel: t.licenceModel, categoryId: refs.option('software_category', t.categoryKey), customerId: null as string | null, isActive: true, tags: [t.categoryKey] }));
  await tx.insert(schema.softwareProducts).values(productRows).onConflictDoNothing();
  const stored = await tx.select({ id: schema.softwareProducts.id, key: schema.softwareProducts.key }).from(schema.softwareProducts).where(inArray(schema.softwareProducts.key, productRows.map((p) => p.key)));
  const productId = new Map<string, string>();
  TITLES.forEach((t, i) => {
    const row = stored.find((s) => s.key === productRows[i]!.key);
    if (!row) throw new Error(`software title ${t.key} missing`);
    productId.set(t.key, row.id);
  });

  // Installations from the committed CIs plus imported endpoint and named-user rows
  const installRows: (typeof schema.softwareInstallations.$inferInsert)[] = [];
  const seen = (days: number) => addDays(now, -days);
  for (const key of SOFTWARE_CUSTOMERS) {
    const cust = state.customers.find((c) => c.key === key);
    if (!cust) continue;
    const domain = cust.portalUsers[0]?.email.split('@')[1] ?? `${cust.short}.example`;
    const cisOfCustomer = await tx
      .select({ id: schema.cis.id, name: schema.cis.name, hostname: schema.cis.hostname, osName: schema.cis.osName, osVersion: schema.cis.osVersion, assetId: schema.cis.assetId, typeKey: schema.ciTypes.key, attributes: schema.cis.attributes })
      .from(schema.cis)
      .innerJoin(schema.ciTypes, eq(schema.ciTypes.id, schema.cis.typeId))
      .where(eq(schema.cis.customerId, cust.id));
    const onCi = (ci: (typeof cisOfCustomer)[number], title: string, extra: Partial<typeof schema.softwareInstallations.$inferInsert> = {}) =>
      installRows.push({ customerId: cust.id, productId: productId.get(title)!, ciId: ci.id, assetId: ci.assetId, hostName: ci.hostname ?? ci.name, source: 'discovery', discoveredAt: seen(rng.int(30, 120)), lastSeenAt: seen(rng.int(1, 20)), ...extra });
    let sqlOnBackup = key === 'abc';
    for (const ci of cisOfCustomer) {
      const attrs = (ci.attributes ?? {}) as Record<string, unknown>;
      if (ci.osName === 'Windows Server') onCi(ci, 'winsrv', { version: ci.osVersion, cores: ci.typeKey === 'virtual_machine' ? Number(attrs.vcpu ?? 8) : 24 });
      if (ci.typeKey === 'hypervisor') onCi(ci, 'vsphere', { version: ci.osVersion, cores: 32 });
      if (ci.typeKey === 'backup_system') {
        onCi(ci, 'veeam', { version: '12.1' });
        // The backup product keeps its configuration database on a SQL Server instance on the main backup server.
        if (sqlOnBackup) {
          onCi(ci, 'sql', { version: '2019', cores: 8, notes: 'Backup configuration database' });
          sqlOnBackup = false;
        }
      }
      if (ci.typeKey === 'database' && typeof attrs.engine === 'string') {
        if (attrs.engine.startsWith('Microsoft SQL Server')) onCi(ci, 'sql', { version: String(attrs.version ?? '2019'), cores: 8 });
        else if (attrs.engine.startsWith('Oracle')) onCi(ci, 'oracle', { version: '19.21', cores: 16 });
      }
      if (ci.typeKey === 'virtual_machine' && ci.osName === 'Red Hat Enterprise Linux') onCi(ci, 'rhel', { version: '9.4' });
    }
    // Endpoints: the real endpoint CIs first, then imported laptops by host name and user.
    const plan = ENDPOINTS[key]!;
    const endpointCis = cisOfCustomer.filter((c) => c.typeKey === 'endpoint');
    for (let n = 1; n <= plan.count; n++) {
      const ci = endpointCis[n - 1];
      const host = ci ? { ciId: ci.id, assetId: ci.assetId, hostName: ci.hostname ?? ci.name } : { ciId: null, assetId: null, hostName: `${cust.short}-lt${String(n).padStart(2, '0')}` };
      const assignedUser = `user${String(n).padStart(2, '0')}@${domain}`;
      const titles = [...plan.titles, ...(plan.third && n % 3 === 0 ? [plan.third] : [])];
      for (const t of titles) installRows.push({ customerId: cust.id, productId: productId.get(t)!, ...host, assignedUser, version: t === 'office' ? '16.0.17928' : t === 'forti' ? '7.2.4' : '24.2', source: 'csv', lastSeenAt: seen(rng.int(0, 10)) });
    }
    // Named-user subscriptions, imported from the tenant export.
    for (let n = 1; n <= plan.m365; n++) installRows.push({ customerId: cust.id, productId: productId.get('m365')!, assignedUser: `user${String(n).padStart(2, '0')}@${domain}`, source: 'csv', lastSeenAt: seen(3) });
    if (key === 'abc') for (let n = 1; n <= 30; n++) installRows.push({ customerId: cust.id, productId: productId.get('sap')!, assignedUser: `user${String(n).padStart(2, '0')}@${domain}`, source: 'manual', notes: 'SAP GUI named user' });
  }
  // Three imported installations at ABC were last seen long ago (stale).
  const abc = state.customers.find((c) => c.key === 'abc');
  if (abc) {
    const candidates = installRows.filter((r) => r.customerId === abc.id && r.source === 'csv' && r.ciId === null && r.hostName);
    for (const r of candidates.slice(0, 3)) r.lastSeenAt = seen(70);
  }
  for (let i = 0; i < installRows.length; i += 500) await tx.insert(schema.softwareInstallations).values(installRows.slice(i, i + 500));

  // Licences
  const byName = new Map<string, string>();
  for (const l of LICENCES) {
    const cust = state.customers.find((c) => c.key === l.cust);
    if (!cust) continue;
    const contract = l.contract ? cust.contracts.find((c) => c.key === l.contract) : null;
    const [row] = await tx
      .insert(schema.softwareLicences)
      .values({
        customerId: cust.id, productId: productId.get(l.title)!, contractId: contract?.id ?? null, name: l.name, metric: l.metric, term: l.term, quantity: String(l.qty),
        startDate: isoDate(addDays(now, l.start)), endDate: l.end === null ? null : isoDate(addDays(now, l.end)), renewalDate: l.renewal === null ? null : isoDate(addDays(now, l.renewal)), autoRenew: l.term === 'subscription' && l.contract !== null,
        cost: String(l.cost), currency: 'INR', vendor: 'Ingram Micro', poNumber: `${cust.code}/PO/SW/${hashHex(`${cust.key}:${l.name}`, 4)}`, invoiceNumber: `INV-${hashHex(`${cust.key}:${l.name}:inv`, 6)}`,
        licenceKey: l.term === 'perpetual' ? `${hashHex(`${cust.key}:${l.name}:key`, 5)}-${hashHex(`${l.name}:k2`, 5)}-${hashHex(`${l.name}:k3`, 5)}`.toUpperCase() : null,
        ownerUserId: owner, isActive: true,
      })
      .returning({ id: schema.softwareLicences.id });
    byName.set(`${l.cust}:${l.name}`, row!.id);
    state.counts.softwareLicences = (state.counts.softwareLicences ?? 0) + 1;
  }
  for (const l of LICENCES.filter((x) => x.renewedBy)) {
    const id = byName.get(`${l.cust}:${l.name}`);
    const successorId = byName.get(`${l.cust}:${l.renewedBy}`);
    if (id && successorId) await tx.update(schema.softwareLicences).set({ successorId, renewedAt: addDays(now, -230) }).where(eq(schema.softwareLicences.id, id));
  }

  state.counts.softwareProducts = TITLES.length;
  state.counts.softwareInstallations = installRows.length;
}
