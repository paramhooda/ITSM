/**
 * Software asset management: the catalogue key and the compliance maths (pure),
 * the live licence status, titles (duplicates, delete refusal, permissions),
 * installations (host filling from the CI or the asset, de-duplication, the
 * customer fence), the compliance position per metric over live hosts only,
 * the CSV import with host matching, the renewals view, renewal without an
 * entitlement gap, the daily job's once-only notifications, the overview, the
 * portal projections pinned to the organisation with no commercial fields,
 * proof-of-purchase attachment access, the assistant tools and the two
 * reports.
 * Run with the dev environment sourced: npx vitest run test/software.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, like, asc } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../src/core/errors';
import { todayStr, addDays } from '../src/core/overview';
import * as svc from '../src/modules/software/service';
import { importInstallations } from '../src/modules/software/import';
import { softwareOverview } from '../src/modules/software/overview';
import { runSoftwareDaily } from '../src/jobs/processors/software';
import { portalSoftware, portalSoftwareLicences, portalSoftwareInstallations } from '../src/modules/portal/service';
import { attachmentAccess } from '../src/modules/attachments/service';
import { runReport } from '../src/modules/reports/service';
import { findReport } from '../src/modules/reports/registry';
import '../src/modules/reports/definitions';
import { toolByName, availableTools } from '../src/modules/ai/tools';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-software-${S}`, ip: '127.0.0.1' };
const PUBLISHER = `SwTest ${S}`;
const KEY_PREFIX = `swtest-${S}/`;
const ALPHA_CODE = `SWA-${S}`;
const BETA_CODE = `SWB-${S}`;
const BETA_LICENCE = `Beta Secret ${S}`;
const ids = { alpha: '', beta: '', siteA: '', siteB: '', srv: '', old: '', lt1: '', lt2: '', betaSrv: '', assetA1: '', assetA2: '', contractA: '', contractB: '', mgr: '', eng: '', viewer: '', padmin: '', puser: '' };
const products: Record<string, string> = {};
let admin: Principal;
let eng: Principal;
let viewer: Principal;
let padmin: Principal;
let puser: Principal;
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asEng = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(eng, meta, fn);
const asViewer = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(viewer, meta, fn);
const asPadmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(padmin, meta, fn);
const asPuser = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(puser, meta, fn);
const text = (v: unknown) => JSON.stringify(v);
const today = todayStr();
const day = (offset: number) => addDays(today, offset);
const setSetting = (key: string, value: unknown) => withSystem((tx) => tx.update(schema.systemSettings).set({ value: value as never }).where(eq(schema.systemSettings.key, key)));
const outboxCount = (event: string, entityId: string) => withSystem(async (tx) => (await tx.select({ id: schema.notificationOutbox.id }).from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, event), eq(schema.notificationOutbox.entityId, entityId)))).length);
const milestoneRows = (scopeId: string, milestone: string) => withSystem((tx) => tx.select().from(schema.softwareNotifications).where(and(eq(schema.softwareNotifications.scopeId, scopeId), eq(schema.softwareNotifications.milestone, milestone))));

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing (seed not applied?)`);
  return row.id;
}
async function ciTypeId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.ciTypes.id }).from(schema.ciTypes).where(eq(schema.ciTypes.key, key)).limit(1);
  if (!row) throw new Error(`CI type ${key} missing`);
  return row.id;
}

const mkProduct = (name: string, licenceModel = 'per_device') => asAdmin((ctx) => svc.createProduct(ctx, { publisher: PUBLISHER, name, versionFamily: null, licenceModel: licenceModel as never }));
const mkLicence = (over: Partial<Parameters<typeof svc.createLicence>[1]> & { productId: string; name: string }) =>
  asAdmin((ctx) => svc.createLicence(ctx, { customerId: ids.alpha, quantity: 1, metric: 'per_device', term: 'subscription', startDate: day(-30), ...over } as Parameters<typeof svc.createLicence>[1]));
const mkInstall = (over: Partial<Parameters<typeof svc.createInstallation>[1]> & { productId: string }) => asAdmin((ctx) => svc.createInstallation(ctx, { customerId: ids.alpha, ...over } as Parameters<typeof svc.createInstallation>[1]));

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [adm] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    const mkUser = async (email: string, name: string, role: string, customerId: string | null, userType: 'msp' | 'customer') => {
      const [u] = await tx.insert(schema.users).values({ email, name, userType, customerId, status: 'active' }).returning();
      await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: await roleId(tx, role), customerId });
      return u!.id;
    };
    ids.mgr = await mkUser(`sw-mgr-${S}@test.local`, 'Software Service Manager', 'service_manager', null, 'msp');
    const [a] = await tx.insert(schema.customers).values({ code: ALPHA_CODE, name: `Alpha Software ${S}`, accountManagerId: ids.mgr }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: BETA_CODE, name: `Beta Software ${S}` }).returning();
    ids.alpha = a!.id;
    ids.beta = b!.id;
    const [siteA] = await tx.insert(schema.sites).values({ customerId: a!.id, code: 'HQ', name: `Alpha HQ ${S}`, isPrimary: true }).returning();
    const [siteB] = await tx.insert(schema.sites).values({ customerId: b!.id, code: 'HQ', name: `Beta HQ ${S}`, isPrimary: true }).returning();
    ids.siteA = siteA!.id;
    ids.siteB = siteB!.id;
    const server = await ciTypeId(tx, 'server');
    const endpoint = await ciTypeId(tx, 'endpoint');
    const ci = async (customerId: string, siteId: string, typeId: string, name: string, extra: Partial<typeof schema.cis.$inferInsert> = {}) => (await tx.insert(schema.cis).values({ customerId, siteId, typeId, name, hostname: name, ...extra }).returning({ id: schema.cis.id }))[0]!.id;
    ids.srv = await ci(a!.id, siteA!.id, server, `alpha-srv-${S}`, { serialNumber: `SN-A-${S}`, osName: 'Windows Server', osVersion: '2022' });
    ids.old = await ci(a!.id, siteA!.id, server, `alpha-old-${S}`, { status: 'retired' });
    ids.lt1 = await ci(a!.id, siteA!.id, endpoint, `alpha-lt1-${S}`);
    ids.lt2 = await ci(a!.id, siteA!.id, endpoint, `alpha-lt2-${S}`);
    ids.betaSrv = await ci(b!.id, siteB!.id, server, `beta-srv-${S}`);
    const [a1] = await tx.insert(schema.assets).values({ customerId: a!.id, siteId: siteA!.id, tag: `SW-A-${S}-1`, name: `Alpha laptop ${S}`, serialNumber: `SN-LT-${S}`, ciId: ids.lt1 }).returning({ id: schema.assets.id });
    const [a2] = await tx.insert(schema.assets).values({ customerId: a!.id, siteId: siteA!.id, tag: `SW-A-${S}-2`, name: `Alpha retired box ${S}`, serialNumber: `SN-A2-${S}`, lifecycleStage: 'retired' }).returning({ id: schema.assets.id });
    ids.assetA1 = a1!.id;
    ids.assetA2 = a2!.id;
    await tx.update(schema.cis).set({ assetId: a1!.id }).where(eq(schema.cis.id, ids.lt1));
    const [policy] = await tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    const [ca] = await tx.insert(schema.contracts).values({ customerId: a!.id, number: `SWC-A-${S}`, name: `Alpha software support ${S}`, status: 'active', startDate: day(-30), endDate: day(300), slaPolicyId: policy?.id ?? null, escalationMatrix: [] }).returning();
    const [cb] = await tx.insert(schema.contracts).values({ customerId: b!.id, number: `SWC-B-${S}`, name: `Beta software support ${S}`, status: 'active', startDate: day(-30), endDate: day(300), slaPolicyId: policy?.id ?? null, escalationMatrix: [] }).returning();
    ids.contractA = ca!.id;
    ids.contractB = cb!.id;
    ids.eng = await mkUser(`eng-${S}@test.local`, 'Software Engineer', 'engineer', a!.id, 'msp');
    await tx.insert(schema.userCustomerAccess).values({ userId: ids.eng, customerId: a!.id });
    ids.viewer = await mkUser(`viewer-${S}@test.local`, 'Software Viewer', 'management', null, 'msp');
    ids.padmin = await mkUser(`padmin-${S}@test.local`, 'Alpha Portal Admin', 'customer_admin', a!.id, 'customer');
    ids.puser = await mkUser(`puser-${S}@test.local`, 'Alpha Portal User', 'customer_user', a!.id, 'customer');
    invalidatePrincipal(adm!.id);
    admin = (await loadPrincipal(adm!.id))!;
  });
  eng = (await loadPrincipal(ids.eng))!;
  viewer = (await loadPrincipal(ids.viewer))!;
  padmin = (await loadPrincipal(ids.padmin))!;
  puser = (await loadPrincipal(ids.puser))!;
  for (const [key, name, model] of [['office', 'Office', 'per_device'], ['users', 'Users', 'per_user'], ['cores', 'Cores', 'per_core'], ['site', 'Site', 'per_device'], ['expired', 'Expired', 'per_device'], ['imported', 'Imported', 'per_device'], ['renewal', 'Renewal', 'per_device'], ['ending', 'Ending', 'per_device'], ['renewed25', 'Renewed25', 'per_device'], ['over', 'Over', 'per_device'], ['betaonly', 'BetaOnly', 'per_device']] as const) {
    products[key] = (await mkProduct(name, model)).id;
  }
});

afterAll(async () => {
  await setSetting('software.unused_seat_pct', 80);
  await setSetting('software.import_creates_products', true);
  await setSetting('software.licence_notice_days', [90, 30, 7]);
  await withSystem(async (tx) => {
    const licenceIds = (await tx.select({ id: schema.softwareLicences.id }).from(schema.softwareLicences).where(inArray(schema.softwareLicences.customerId, [ids.alpha, ids.beta]))).map((r) => r.id);
    const entityIds = [...licenceIds, ...Object.values(products)];
    if (entityIds.length) {
      await tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.entityId, entityIds));
      await tx.delete(schema.notifications).where(inArray(schema.notifications.entityId, entityIds));
    }
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.alpha, ids.beta]));
    await tx.delete(schema.softwareProducts).where(like(schema.softwareProducts.key, `${KEY_PREFIX}%`));
    await tx.delete(schema.softwareProducts).where(like(schema.softwareProducts.key, `nobody-${S}/%`));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.mgr, ids.eng, ids.viewer, ids.padmin, ids.puser]));
  });
  await closeDb();
});

describe('pure maths', () => {
  it('titleOf joins publisher, name and version family without repeating a publisher the name starts with', () => {
    expect(svc.titleOf({ publisher: 'Microsoft', name: 'Office LTSC', versionFamily: '2021' })).toBe('Microsoft Office LTSC 2021');
    expect(svc.titleOf({ publisher: 'Microsoft', name: 'Microsoft 365 E3', versionFamily: null })).toBe('Microsoft 365 E3');
    expect(svc.titleOf({ publisher: 'Zoom', name: 'Zoom', versionFamily: null })).toBe('Zoom Zoom');
  });

  it('productKey normalises case and punctuation; computePosition follows the installed-against-entitled rules', () => {
    expect(svc.productKey('Microsoft', 'Office LTSC', '2021')).toBe('microsoft/office-ltsc/2021');
    expect(svc.productKey('  MICROSOFT ', 'office  ltsc', ' 2021 ')).toBe('microsoft/office-ltsc/2021');
    expect(svc.productKey('Veeam', 'Backup & Replication', null)).toBe('veeam/backup-replication');
    expect(svc.productKey('Red Hat', 'Enterprise Linux', '')).toBe('red-hat/enterprise-linux');
    expect(svc.computePosition(0, 0, 80)).toBe('compliant');
    expect(svc.computePosition(3, 0, 80)).toBe('unlicensed');
    expect(svc.computePosition(10, 8, 80)).toBe('over_deployed');
    expect(svc.computePosition(5, 10, 80)).toBe('under_deployed');
    expect(svc.computePosition(9, 10, 80)).toBe('compliant');
    expect(svc.computePosition(4, null, 80)).toBe('unlimited');
  });

  it('licenceStatus: inactive beats everything, a successor beats the dates, then expired, future, expiring and active', () => {
    const notice = [90, 30, 7];
    const base = { isActive: true, successorId: null as string | null, startDate: day(-100), endDate: day(200) };
    expect(svc.licenceStatus({ ...base, isActive: false, endDate: day(-5) }, notice)).toBe('inactive');
    expect(svc.licenceStatus({ ...base, successorId: 'x', endDate: day(-5) }, notice)).toBe('renewed');
    expect(svc.licenceStatus({ ...base, endDate: day(-1) }, notice)).toBe('expired');
    expect(svc.licenceStatus({ ...base, startDate: day(5), endDate: day(400) }, notice)).toBe('future');
    expect(svc.licenceStatus({ ...base, endDate: day(45) }, notice)).toBe('expiring');
    expect(svc.licenceStatus({ ...base, endDate: day(90) }, notice)).toBe('expiring');
    expect(svc.licenceStatus({ ...base, endDate: day(91) }, notice)).toBe('active');
    expect(svc.licenceStatus({ ...base, endDate: null }, notice)).toBe('active');
  });
});

describe('titles', () => {
  it('returns the normalised key, refuses a duplicate differing only in case, refuses to delete a title with a licence, and needs software:manage', async () => {
    const created = await mkProduct('Dup Check');
    expect(created.key).toBe(`${KEY_PREFIX}dup-check`);
    products.dup = created.id;
    await expect(asAdmin((ctx) => svc.createProduct(ctx, { publisher: PUBLISHER.toUpperCase(), name: 'DUP CHECK', versionFamily: null }))).rejects.toBeInstanceOf(ConflictError);
    await mkLicence({ productId: created.id, name: `Dup licence ${S}`, quantity: 2 });
    await expect(asAdmin((ctx) => svc.deleteProduct(ctx, created.id))).rejects.toThrow(/Deactivate the title instead/);
    await expect(asViewer((ctx) => svc.createProduct(ctx, { publisher: PUBLISHER, name: 'Viewer title', versionFamily: null }))).rejects.toThrow(/permission/i);
    const list = await asViewer((ctx) => svc.listProducts(ctx, { page: 1, pageSize: 50, publisher: PUBLISHER, fields: 'full', includeInactive: undefined, inUseOnly: undefined } as never));
    expect(list.items.some((p) => p.id === created.id)).toBe(true);
    const full = await asAdmin((ctx) => svc.getProduct(ctx, created.id));
    expect(full.licensedSeats).toBe(2);
    expect(full.licences[0]?.status).toBe('active');
  });
});

describe('installations', () => {
  it('fills the host name from the CI, de-duplicates, fences the customer and links the asset half of the pair', async () => {
    const first = await mkInstall({ productId: products.office!, ciId: ids.srv, version: '1.0' });
    expect(first.hostName).toBe(`alpha-srv-${S}`);
    await expect(mkInstall({ productId: products.office!, ciId: ids.srv })).rejects.toBeInstanceOf(ConflictError);
    await expect(mkInstall({ productId: products.office!, ciId: ids.betaSrv })).rejects.toBeInstanceOf(ValidationError);
    await expect(asEng((ctx) => svc.createInstallation(ctx, { customerId: ids.beta, productId: products.office!, ciId: ids.betaSrv }))).rejects.toThrow(/permission|access/i);
    const viaAsset = await mkInstall({ productId: products.office!, assetId: ids.assetA1 });
    expect(viaAsset.ciId).toBe(ids.lt1);
    expect(viaAsset.assetId).toBe(ids.assetA1);
    // An edit of the older record answers with the list-row shape (title, host, stale flag), and a discovered record starts its freshness clock.
    const edited = await asAdmin((ctx) => svc.updateInstallation(ctx, first.id, { version: '1.1', source: 'discovery' }));
    expect(edited.id).toBe(first.id);
    expect(edited.productName).toBe('Office');
    expect(edited.ciName).toBe(`alpha-srv-${S}`);
    expect(edited.version).toBe('1.1');
    expect(edited.lastSeenAt).toBeInstanceOf(Date);
    expect(edited.stale).toBe(false);
    const onCi = await asAdmin((ctx) => svc.installationsForHost(ctx.tx, { ciId: ids.lt1 }));
    expect(onCi.map((i) => i.id)).toContain(viaAsset.id);
    const list = await asAdmin((ctx) => svc.listInstallations(ctx, { page: 1, pageSize: 50, customerId: ids.alpha, productId: products.office!, host: 'ci', stale: undefined } as never));
    expect(list.total).toBe(2);
    expect(list.items.every((i) => i.stale === false)).toBe(true);
  });
});

describe('compliance maths', () => {
  it('counts live hosts only, per metric, with licences in term, site licences and the unused-seat threshold', async () => {
    // Office: installs on the live server, the retired CI and the retired asset -> only the server and the laptop count.
    await mkInstall({ productId: products.office!, ciId: ids.old });
    await mkInstall({ productId: products.office!, assetId: ids.assetA2 });
    const office = await mkLicence({ productId: products.office!, name: `Office seats ${S}`, quantity: 2 });
    let pos = (await asAdmin((ctx) => svc.positionFor(ctx, ids.alpha, products.office!)))!;
    expect(pos.installed).toBe(2);
    expect(pos.entitled).toBe(2);
    expect(pos.position).toBe('compliant');
    await asAdmin((ctx) => svc.updateLicence(ctx, office.id, { isActive: false }));
    pos = (await asAdmin((ctx) => svc.positionFor(ctx, ids.alpha, products.office!)))!;
    expect(pos.entitled).toBe(0);
    expect(pos.position).toBe('unlicensed');
    await asAdmin((ctx) => svc.updateLicence(ctx, office.id, { isActive: true }));
    // per_user: distinct users regardless of case, plus the install without a user.
    for (const [host, user] of [['h1', 'u1'], ['h2', 'U1'], ['h3', 'u2'], ['h4', null]] as const) await mkInstall({ productId: products.users!, hostName: `${host}-${S}`, assignedUser: user });
    await mkLicence({ productId: products.users!, name: `User seats ${S}`, metric: 'per_user', quantity: 10 });
    pos = (await asAdmin((ctx) => svc.positionFor(ctx, ids.alpha, products.users!)))!;
    expect(pos.metric).toBe('per_user');
    expect(pos.installed).toBe(3);
    // per_core: cores summed, null counts as one.
    for (const [host, cores] of [['c1', 8], ['c2', 16], ['c3', null]] as const) await mkInstall({ productId: products.cores!, hostName: `${host}-${S}`, cores });
    await mkLicence({ productId: products.cores!, name: `Core packs ${S}`, metric: 'per_core', quantity: 32 });
    pos = (await asAdmin((ctx) => svc.positionFor(ctx, ids.alpha, products.cores!)))!;
    expect(pos.installed).toBe(25);
    expect(pos.position).toBe('under_deployed');
    // an expired licence contributes nothing; a site licence makes the title unlimited.
    await mkInstall({ productId: products.expired!, hostName: `e1-${S}` });
    const expired = await mkLicence({ productId: products.expired!, name: `Expired seats ${S}`, quantity: 5, startDate: day(-400), endDate: day(-20) });
    expect(expired.status).toBe('expired');
    pos = (await asAdmin((ctx) => svc.positionFor(ctx, ids.alpha, products.expired!)))!;
    expect(pos.entitled).toBe(0);
    expect(pos.position).toBe('unlicensed');
    await mkInstall({ productId: products.site!, hostName: `s1-${S}` });
    await mkLicence({ productId: products.site!, name: `Site licence ${S}`, metric: 'site', quantity: 0 });
    pos = (await asAdmin((ctx) => svc.positionFor(ctx, ids.alpha, products.site!)))!;
    expect(pos.entitled).toBeNull();
    expect(pos.position).toBe('unlimited');
    await expect(mkLicence({ productId: products.site!, name: `Zero seats ${S}`, quantity: 0 })).rejects.toBeInstanceOf(ValidationError);
    // the unused-seat threshold: 6 of 10 is under-deployed at 80 %, compliant at 50 %.
    for (let i = 1; i <= 6; i++) await mkInstall({ productId: products.dup!, hostName: `d${i}-${S}` });
    const dupLicence = (await asAdmin((ctx) => svc.listLicences(ctx, { page: 1, pageSize: 10, productId: products.dup! } as never))).items[0]!;
    await asAdmin((ctx) => svc.updateLicence(ctx, dupLicence.id, { quantity: 10 }));
    pos = (await asAdmin((ctx) => svc.positionFor(ctx, ids.alpha, products.dup!)))!;
    expect(pos.installed).toBe(6);
    expect(pos.position).toBe('under_deployed');
    await setSetting('software.unused_seat_pct', 50);
    try {
      pos = (await asAdmin((ctx) => svc.positionFor(ctx, ids.alpha, products.dup!)))!;
      expect(pos.position).toBe('compliant');
    } finally {
      await setSetting('software.unused_seat_pct', 80);
    }
    const listed = await asAdmin((ctx) => svc.listCompliance(ctx, { customerId: ids.alpha, position: 'unlicensed', page: 1, pageSize: 50, expiringOnly: undefined } as never));
    expect(listed.items.map((r) => r.productId)).toContain(products.expired);
    expect(listed.items.every((r) => r.position === 'unlicensed')).toBe(true);
  });
});

describe('CSV import', () => {
  it('matches hosts by host name, asset tag and serial, rejects unknown titles when the setting is off, updates on re-import and needs the two columns', async () => {
    await setSetting('software.import_creates_products', false);
    try {
      const header = 'publisher,product,versionFamily,version,edition,hostname,assetTag,serialNumber,user,cores,installedAt,source,notes';
      const rows = (version: string) => [header, `${PUBLISHER},Imported,,${version},,alpha-srv-${S},,,,,,,`, `${PUBLISHER},Imported,,${version},,,SW-A-${S}-1,,,,,,`, `${PUBLISHER},Imported,,${version},,,,SN-A2-${S},,,,,`, `Nobody ${S},Unknown,,,,,,,someone@example.test,,,,`].join('\n');
      const first = await asAdmin((ctx) => importInstallations(ctx, ids.alpha, Buffer.from(rows('1.0'))));
      expect(first.created).toBe(3);
      expect(first.updated).toBe(0);
      expect(first.errors).toHaveLength(1);
      expect(first.errors[0]!.message).toMatch(/Unknown title/);
      const installs = await withSystem((tx) => tx.select().from(schema.softwareInstallations).where(eq(schema.softwareInstallations.productId, products.imported!)));
      expect(installs).toHaveLength(3);
      expect(installs.every((i) => i.source === 'csv' && i.lastSeenAt instanceof Date && i.version === '1.0')).toBe(true);
      expect(installs.find((i) => i.ciId === ids.srv)).toBeDefined();
      expect(installs.find((i) => i.assetId === ids.assetA1)?.ciId).toBe(ids.lt1);
      expect(installs.find((i) => i.assetId === ids.assetA2)).toBeDefined();
      const second = await asAdmin((ctx) => importInstallations(ctx, ids.alpha, Buffer.from(rows('2.0'))));
      expect(second.created).toBe(0);
      expect(second.updated).toBe(3);
      const again = await withSystem((tx) => tx.select().from(schema.softwareInstallations).where(eq(schema.softwareInstallations.productId, products.imported!)));
      expect(again).toHaveLength(3);
      expect(again.every((i) => i.version === '2.0')).toBe(true);
      await expect(asAdmin((ctx) => importInstallations(ctx, ids.alpha, Buffer.from('product,hostname\nX,host')))).rejects.toBeInstanceOf(ValidationError);
      await expect(asViewer((ctx) => importInstallations(ctx, ids.alpha, Buffer.from(rows('3.0'))))).rejects.toThrow(/permission/i);
    } finally {
      await setSetting('software.import_creates_products', true);
    }
  });
});

describe('CSV import, titles created on the way', () => {
  it('forgets a title created by a row that then fails, so the next row of that title creates it again', async () => {
    const header = 'publisher,product,hostname';
    const csv = [header, `Nobody ${S},Created ${S},`, `Nobody ${S},Created ${S},alpha-srv-${S}`].join('\n');
    const res = await asAdmin((ctx) => importInstallations(ctx, ids.alpha, Buffer.from(csv)));
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.row).toBe(2);
    expect(res.created).toBe(1);
    const created = await withSystem((tx) => tx.select({ id: schema.softwareProducts.id }).from(schema.softwareProducts).where(eq(schema.softwareProducts.key, `nobody-${S}/created-${S}`)));
    expect(created).toHaveLength(1);
    const installs = await withSystem((tx) => tx.select({ ciId: schema.softwareInstallations.ciId }).from(schema.softwareInstallations).where(eq(schema.softwareInstallations.productId, created[0]!.id)));
    expect(installs).toEqual([{ ciId: ids.srv }]);
  });
});

describe('renewals', () => {
  it('lists licences ending or renewing within the window, expired first, and filters by status', async () => {
    const mkBeta = (name: string, over: Partial<Parameters<typeof svc.createLicence>[1]>) => asAdmin((ctx) => svc.createLicence(ctx, { customerId: ids.beta, productId: products.betaonly!, quantity: 3, metric: 'per_device', term: 'subscription', startDate: day(-300), name, ...over } as Parameters<typeof svc.createLicence>[1]));
    await mkBeta(`${BETA_LICENCE} ends soon`, { endDate: day(10) });
    await mkBeta(`${BETA_LICENCE} renews soon`, { endDate: day(200), renewalDate: day(20) });
    await mkBeta(`${BETA_LICENCE} expired`, { endDate: day(-5) });
    await mkBeta(`${BETA_LICENCE} far`, { endDate: day(200) });
    const all = await asAdmin((ctx) => svc.listRenewals(ctx, { days: 90, customerId: ids.beta, status: 'all', limit: 100 }));
    expect(all.items.map((l) => l.name)).toEqual([`${BETA_LICENCE} expired`, `${BETA_LICENCE} ends soon`, `${BETA_LICENCE} renews soon`]);
    expect(all.items[0]!.status).toBe('expired');
    expect(all.expired).toBe(1);
    const expired = await asAdmin((ctx) => svc.listRenewals(ctx, { days: 90, customerId: ids.beta, status: 'expired', limit: 100 }));
    expect(expired.items.map((l) => l.name)).toEqual([`${BETA_LICENCE} expired`]);
    const expiring = await asAdmin((ctx) => svc.listRenewals(ctx, { days: 90, customerId: ids.beta, status: 'expiring', limit: 100 }));
    expect(expiring.items).toHaveLength(2);
    const ending = await asAdmin((ctx) => svc.listLicences(ctx, { page: 1, pageSize: 20, customerId: ids.beta, endingWithinDays: 30 } as never));
    expect(ending.items.map((l) => l.name)).toEqual([`${BETA_LICENCE} ends soon`]);
    const byStatus = await asAdmin((ctx) => svc.listLicences(ctx, { page: 1, pageSize: 20, customerId: ids.beta, status: 'expired' } as never));
    expect(byStatus.items.map((l) => l.name)).toEqual([`${BETA_LICENCE} expired`]);
    const inTerm = await asAdmin((ctx) => svc.listLicences(ctx, { page: 1, pageSize: 20, customerId: ids.beta, inTerm: true } as never));
    expect(inTerm.items.map((l) => l.name).sort()).toEqual([`${BETA_LICENCE} ends soon`, `${BETA_LICENCE} far`, `${BETA_LICENCE} renews soon`]);
  });

  it('renewLicence records the next term without an entitlement gap and refuses a second renewal', async () => {
    await mkInstall({ productId: products.renewal!, hostName: `r1-${S}` });
    const old = await mkLicence({ productId: products.renewal!, name: `Renewal seats ${S}`, quantity: 5, endDate: day(45) });
    expect(old.status).toBe('expiring');
    await expect(asAdmin((ctx) => svc.renewLicence(ctx, old.id, { startDate: day(45) }))).rejects.toBeInstanceOf(ValidationError);
    const next = await asAdmin((ctx) => svc.renewLicence(ctx, old.id, {}));
    expect(next.startDate).toBe(day(46));
    expect(next.endDate).toBe(addDays(day(46), 365));
    expect(next.quantity).toBe(5);
    expect(next.status).toBe('future');
    expect(next.predecessor?.id).toBe(old.id);
    const after = await asAdmin((ctx) => svc.getLicence(ctx, old.id));
    expect(after.isActive).toBe(true);
    expect(after.successorId).toBe(next.id);
    expect(after.status).toBe('renewed');
    expect(after.successor?.id).toBe(next.id);
    const pos = (await asAdmin((ctx) => svc.positionFor(ctx, ids.alpha, products.renewal!)))!;
    expect(pos.entitled).toBe(5);
    expect(pos.licencesActive).toBe(1);
    const renewals = await asAdmin((ctx) => svc.listRenewals(ctx, { days: 90, customerId: ids.alpha, status: 'all', limit: 100 }));
    expect(renewals.items.map((l) => l.id)).not.toContain(old.id);
    await expect(asAdmin((ctx) => svc.renewLicence(ctx, old.id, {}))).rejects.toBeInstanceOf(ConflictError);
    const audits = await withSystem((tx) => tx.select({ entityId: schema.auditLog.entityId, action: schema.auditLog.action }).from(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'software_licence'), inArray(schema.auditLog.entityId, [old.id, next.id]))));
    expect(audits.some((a) => a.entityId === old.id && a.action === 'renew')).toBe(true);
    expect(audits.some((a) => a.entityId === next.id && a.action === 'create')).toBe(true);
  });
});

describe('daily job', () => {
  it('notifies once per threshold crossing and on expiry, never for a renewed licence, and once per over-deployment until it recovers', async () => {
    await setSetting('software.licence_notice_days', [90, 30, 7]);
    const ending = await mkLicence({ productId: products.ending!, name: `Ending seats ${S}`, quantity: 4, endDate: day(25) });
    const renewed = await mkLicence({ productId: products.renewed25!, name: `Renewed seats ${S}`, quantity: 4, endDate: day(25) });
    await asAdmin((ctx) => svc.renewLicence(ctx, renewed.id, {}));
    for (const ci of [ids.srv, ids.lt1, ids.lt2]) await mkInstall({ productId: products.over!, ciId: ci });
    const over = await mkLicence({ productId: products.over!, name: `Over seats ${S}`, quantity: 2 });
    const expiredId = (await asAdmin((ctx) => svc.listLicences(ctx, { page: 1, pageSize: 5, productId: products.expired! } as never))).items[0]!.id;
    const milestone = `over_deployed:${ids.alpha}`;

    await runSoftwareDaily();
    const expiringRows = await outboxCount('licence.expiring', ending.id);
    expect(expiringRows).toBeGreaterThanOrEqual(1);
    expect(await outboxCount('licence.expiring', renewed.id)).toBe(0);
    expect(await outboxCount('licence.expired', renewed.id)).toBe(0);
    const overRows = await outboxCount('software.over_deployed', products.over!);
    expect(overRows).toBeGreaterThanOrEqual(1);
    const expiredRows = await outboxCount('licence.expired', expiredId);
    expect(expiredRows).toBeGreaterThanOrEqual(1);
    expect(await milestoneRows(products.over!, milestone)).toHaveLength(1);
    expect(await milestoneRows(ending.id, 'expiring:90')).toHaveLength(1);
    expect(await milestoneRows(ending.id, 'expiring:30')).toHaveLength(1);
    expect(await milestoneRows(ending.id, 'expiring:7')).toHaveLength(0);

    await runSoftwareDaily();
    expect(await outboxCount('licence.expiring', ending.id)).toBe(expiringRows);
    expect(await outboxCount('software.over_deployed', products.over!)).toBe(overRows);
    expect(await outboxCount('licence.expired', expiredId)).toBe(expiredRows);

    await asAdmin((ctx) => svc.updateLicence(ctx, over.id, { quantity: 10 }));
    await runSoftwareDaily();
    expect(await milestoneRows(products.over!, milestone)).toHaveLength(0);
    expect(await outboxCount('software.over_deployed', products.over!)).toBe(overRows);
    await asAdmin((ctx) => svc.updateLicence(ctx, over.id, { quantity: 2 }));
    await runSoftwareDaily();
    expect(await outboxCount('software.over_deployed', products.over!)).toBeGreaterThan(overRows);
    // A corrected end date starts the milestones afresh: the next crossing notifies again (one outbox row per recipient, so the count grows rather than increments).
    try {
      await asAdmin((ctx) => svc.updateLicence(ctx, ending.id, { endDate: day(80) }));
      expect(await milestoneRows(ending.id, 'expiring:90')).toHaveLength(0);
      expect(await milestoneRows(ending.id, 'expiring:30')).toHaveLength(0);
      await runSoftwareDaily();
      expect(await outboxCount('licence.expiring', ending.id)).toBeGreaterThan(expiringRows);
      expect(await milestoneRows(ending.id, 'expiring:90')).toHaveLength(1);
      expect(await milestoneRows(ending.id, 'expiring:30')).toHaveLength(0);
    } finally {
      await asAdmin((ctx) => svc.updateLicence(ctx, ending.id, { endDate: day(25) }));
    }
    // the first notice (the 25-day one): without an order the row the database hands back first is arbitrary under load
    const [row] = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'licence.expiring'), eq(schema.notificationOutbox.entityId, ending.id))).orderBy(asc(schema.notificationOutbox.createdAt)).limit(1));
    expect(row?.subject).toContain(`Ending seats ${S}`);
    expect(row?.subject).toContain('ends in 25 days');
  });
});

describe('overview', () => {
  it('reports the estate of one customer', async () => {
    const o = await asAdmin((ctx) => softwareOverview(ctx, ids.alpha));
    const positions = await asAdmin((ctx) => svc.complianceFor(ctx, { customerId: ids.alpha }));
    const [{ n }] = await withSystem((tx) => tx.select({ n: schema.softwareInstallations.id }).from(schema.softwareInstallations).where(eq(schema.softwareInstallations.customerId, ids.alpha)).then((rows) => [{ n: rows.length }]));
    expect(o.installations).toBe(n);
    expect(o.positions.reduce((s, b) => s + b.count, 0)).toBe(positions.length);
    expect(o.positions.find((b) => b.key === 'over_deployed')!.count).toBe(positions.filter((p) => p.position === 'over_deployed').length);
    expect(o.titlesInUse).toBe(new Set(positions.map((p) => p.productId)).size);
    expect(o.renewals.d30).toBeGreaterThanOrEqual(1);
    expect(o.renewals.expired).toBeGreaterThanOrEqual(1);
    expect(o.topOverDeployed.some((t) => t.productId === products.over)).toBe(true);
    expect(o.renewingSoon.some((l) => l.name === `Ending seats ${S}` && l.daysLeft === 25)).toBe(true);
    expect(o.bySource.find((b) => b.key === 'csv')!.count).toBeGreaterThanOrEqual(3);
    expect(o.byCustomer).toEqual([]);
    await expect(asViewer((ctx) => softwareOverview(ctx, ids.beta))).resolves.toBeDefined();
    await expect(asEng((ctx) => softwareOverview(ctx, ids.beta))).rejects.toThrow(/permission|access/i);
  });
});

describe('portal', () => {
  it('pins the organisation, hides the other one and every commercial field, refuses users without portal:software and lets staff preview', async () => {
    const res = await asPadmin((ctx) => portalSoftware(ctx));
    expect(res.preview).toBe(false);
    expect(res.positions.length).toBeGreaterThan(0);
    expect(res.positions.some((p) => p.productId === products.betaonly)).toBe(false);
    expect(res.totals.overDeployed).toBeGreaterThanOrEqual(1);
    const out = text(res);
    for (const needle of [BETA_CODE, BETA_LICENCE, `Beta Software ${S}`, 'cost', 'licenceKey', 'poNumber', 'vendor', 'notes', 'ownerUserId']) expect(out, `leaked ${needle}`).not.toContain(needle);
    const asked = await asPadmin((ctx) => portalSoftware(ctx, ids.beta));
    expect(text(asked)).not.toContain(BETA_LICENCE);
    expect(asked.positions.length).toBe(res.positions.length);
    await expect(asPuser((ctx) => portalSoftware(ctx))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(asPuser((ctx) => portalSoftwareLicences(ctx, { page: 1, pageSize: 10 }))).rejects.toBeInstanceOf(ForbiddenError);
    const preview = await asAdmin((ctx) => portalSoftware(ctx, ids.alpha));
    expect(preview.preview).toBe(true);
    expect(preview.totals.titles).toBe(res.totals.titles);
    const licences = await asPadmin((ctx) => portalSoftwareLicences(ctx, { page: 1, pageSize: 50 }));
    expect(licences.items.length).toBeGreaterThan(0);
    expect(licences.items.every((l) => typeof l.status === 'string' && typeof l.installed === 'number')).toBe(true);
    const lic = text(licences);
    for (const needle of ['cost', 'licenceKey', 'poNumber', 'invoiceNumber', 'vendor', 'notes', 'ownerUserId', BETA_LICENCE]) expect(lic, `leaked ${needle}`).not.toContain(needle);
    expect(licences.items.find((l) => l.name === `Renewal seats ${S}`)?.status).toBe('renewed');
    const installs = await asPadmin((ctx) => portalSoftwareInstallations(ctx, { page: 1, pageSize: 500 }));
    expect(installs.items.some((i) => i.host === `alpha-srv-${S}`)).toBe(true);
    expect(text(installs)).not.toContain('customerId');
    const searched = await asPadmin((ctx) => portalSoftwareLicences(ctx, { page: 1, pageSize: 50, q: 'Office seats' }));
    expect(searched.items.map((l) => l.name)).toEqual([`Office seats ${S}`]);
  });
});

describe('attachments', () => {
  it('proof of purchase: staff with software:manage upload, read-only staff do not, portal users never, and another customer\'s licence is invisible', async () => {
    const office = (await asAdmin((ctx) => svc.listLicences(ctx, { page: 1, pageSize: 5, productId: products.office! } as never))).items[0]!;
    const beta = (await asAdmin((ctx) => svc.listLicences(ctx, { page: 1, pageSize: 5, customerId: ids.beta } as never))).items[0]!;
    const adminAccess = await asAdmin((ctx) => attachmentAccess(ctx, 'software_licence', office.id));
    expect(adminAccess).toMatchObject({ canUpload: true, canManage: true, customerId: ids.alpha, label: office.name });
    const viewerAccess = await asViewer((ctx) => attachmentAccess(ctx, 'software_licence', office.id));
    expect(viewerAccess).toMatchObject({ canUpload: false, canManage: false });
    const engAccess = await asEng((ctx) => attachmentAccess(ctx, 'software_licence', office.id));
    expect(engAccess.canUpload).toBe(true);
    await expect(asPadmin((ctx) => attachmentAccess(ctx, 'software_licence', office.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(asPadmin((ctx) => attachmentAccess(ctx, 'software_licence', beta.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(asEng((ctx) => attachmentAccess(ctx, 'software_licence', beta.id))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('assistant tools', () => {
  it('answers with facts and links for staff, takes the portal branch for customer administrators without leaking another organisation or commercial fields, and previews actions against resolved records', async () => {
    const compliance = toolByName('software_compliance')!;
    const staff = (await asAdmin((ctx) => compliance.run(ctx, { customer: ALPHA_CODE }))) as { total: number; facts: string[]; items: { link: string; position: string; title: string }[] };
    expect(staff.facts[0]).toMatch(/^\d+ title\(s\) for /);
    expect(staff.facts[0]).toMatch(/over-deployed, \d+ unlicensed, \d+ under-deployed/);
    expect(staff.items.length).toBeGreaterThan(0);
    expect(staff.items.every((i) => i.link.startsWith('/assets/software/titles/'))).toBe(true);
    const onlyOver = (await asAdmin((ctx) => compliance.run(ctx, { customer: ALPHA_CODE, position: 'over_deployed' }))) as { items: { position: string }[] };
    expect(onlyOver.items.every((i) => i.position === 'over_deployed')).toBe(true);
    const oneTitle = (await asAdmin((ctx) => compliance.run(ctx, { customer: ALPHA_CODE, product: `${PUBLISHER} Over` }))) as { total: number; items: { title: string }[] };
    expect(oneTitle.total).toBe(1);
    expect(oneTitle.items[0]!.title).toBe(`${PUBLISHER} Over`);

    const portalNeedles = [BETA_CODE, BETA_LICENCE, `Beta Software ${S}`, 'cost', 'licenceKey', 'poNumber', 'vendor'];
    const pc = (await asPadmin((ctx) => compliance.run(ctx, { customer: BETA_CODE }))) as { total: number; items: { link: string }[]; link: string };
    expect(pc.total).toBeGreaterThan(0);
    expect(pc.items.every((i) => i.link === '/portal/assets/software')).toBe(true);
    for (const n of portalNeedles) expect(text(pc), `software_compliance leaked ${n}`).not.toContain(n);
    const pi = (await asPadmin((ctx) => toolByName('software_inventory')!.run(ctx, { customer: BETA_CODE, q: 'Office' }))) as { total: number; items: { title: string }[] };
    expect(pi.total).toBeGreaterThanOrEqual(1);
    for (const n of portalNeedles) expect(text(pi), `software_inventory leaked ${n}`).not.toContain(n);
    const pr = (await asPadmin((ctx) => toolByName('licence_renewals')!.run(ctx, { customer: BETA_CODE, withinDays: 90 }))) as { total: number; facts: string[]; items: { licence: string }[] };
    expect(pr.items.some((l) => l.licence === `Ending seats ${S}`)).toBe(true);
    for (const n of portalNeedles) expect(text(pr), `licence_renewals leaked ${n}`).not.toContain(n);
    const si = (await asAdmin((ctx) => toolByName('software_inventory')!.run(ctx, { customer: ALPHA_CODE, publisher: PUBLISHER }))) as { total: number; facts: string[]; items: { installations: number; link: string }[] };
    expect(si.facts[0]).toMatch(/software title\(s\) in use for Alpha Software/);
    expect(si.items.every((i) => i.link.startsWith('/assets/software/titles/'))).toBe(true);
    const sr = (await asAdmin((ctx) => toolByName('licence_renewals')!.run(ctx, { customer: BETA_CODE, withinDays: 90 }))) as { total: number; facts: string[] };
    expect(sr.total).toBe(3);
    expect(sr.facts[0]).toContain('1 already expired');

    const get = toolByName('get_licence')!;
    await expect(asPadmin((ctx) => get.run(ctx, { licence: `${BETA_LICENCE} ends soon` }))).rejects.toBeInstanceOf(NotFoundError);
    const mine = (await asPadmin((ctx) => get.run(ctx, { licence: `Office seats ${S}` }))) as Record<string, unknown>;
    expect(mine.name).toBe(`Office seats ${S}`);
    expect('cost' in mine).toBe(false);
    expect(mine.link).toBe('/portal/assets/software');
    const partial = (await asPadmin((ctx) => get.run(ctx, { licence: 'Office seats' }))) as Record<string, unknown>;
    expect(partial.name).toBe(`Office seats ${S}`);
    await expect(asPadmin((ctx) => get.run(ctx, { licence: `Nothing like it ${S}` }))).rejects.toBeInstanceOf(NotFoundError);
    const staffGet = (await asAdmin((ctx) => get.run(ctx, { licence: `Office seats ${S}`, customer: ALPHA_CODE }))) as Record<string, unknown> & { compliance: { position: string }; facts: string[] };
    expect(staffGet.compliance.position).toBe('compliant');
    expect(staffGet.facts[0]).toMatch(/^Licence "Office seats/);
    expect('cost' in staffGet).toBe(true);
    await expect(asAdmin((ctx) => get.run(ctx, { licence: `No such licence ${S}` }))).rejects.toBeInstanceOf(NotFoundError);

    const open = toolByName('open_record')!;
    await expect(asPuser((ctx) => open.run(ctx, { kind: 'licence', ref: `Office seats ${S}` }))).rejects.toBeInstanceOf(ForbiddenError);
    const staffOpen = (await asAdmin((ctx) => open.run(ctx, { kind: 'licence', ref: `Office seats ${S}` }))) as { to: string; label: string; uiAction: { type: string; to: string } };
    expect(staffOpen.to).toMatch(/^\/assets\/software\/licences\/[0-9a-f-]{36}$/);
    expect(staffOpen.label).toBe(`Office seats ${S}`);
    expect(staffOpen.uiAction.type).toBe('navigate');
    const padminOpen = (await asPadmin((ctx) => open.run(ctx, { kind: 'licence', ref: `Office seats ${S}` }))) as { to: string };
    expect(padminOpen.to).toBe('/portal/assets/software');
    await expect(asPadmin((ctx) => open.run(ctx, { kind: 'licence', ref: BETA_LICENCE }))).rejects.toBeInstanceOf(NotFoundError);

    const recordLicence = toolByName('record_licence')!;
    expect(recordLicence.action).toBe(true);
    expect(recordLicence.invalidates).toEqual(['software']);
    const preview = await asAdmin((ctx) => recordLicence.preview!(ctx, { customer: ALPHA_CODE, product: `${PUBLISHER} Office`, quantity: 12, contract: `SWC-A-${S}`, endDate: day(300) }));
    const previewText = typeof preview === 'string' ? preview : preview.text;
    expect(previewText).toContain(`Alpha Software ${S}`);
    expect(previewText).toContain(`${PUBLISHER} Office`);
    expect(previewText).toContain(`SWC-A-${S}`);
    await expect(asAdmin((ctx) => recordLicence.preview!(ctx, { customer: ALPHA_CODE, product: `${PUBLISHER} Office`, quantity: 12, contract: `SWC-B-${S}` }))).rejects.toBeInstanceOf(ValidationError);
    const recorded = (await asAdmin((ctx) => recordLicence.run(ctx, { customer: ALPHA_CODE, product: `${PUBLISHER} Office`, quantity: 12, contract: `SWC-A-${S}`, endDate: day(300) }))) as { id: string; name: string; link: string };
    expect(recorded.name).toBe('Office (12 per device)');
    expect(recorded.link).toBe(`/assets/software/licences/${recorded.id}`);

    const recordInstall = toolByName('record_installation')!;
    await expect(asEng((ctx) => recordInstall.preview!(ctx, { customer: BETA_CODE, product: `${PUBLISHER} Office`, ci: `beta-srv-${S}` }))).rejects.toThrow();
    const ip = await asAdmin((ctx) => recordInstall.preview!(ctx, { customer: ALPHA_CODE, product: `${PUBLISHER} Users`, ci: `alpha-lt2-${S}`, version: '3.1' }));
    expect(typeof ip === 'string' ? ip : ip.text).toContain(`alpha-lt2-${S}`);
    const ran = (await asAdmin((ctx) => recordInstall.run(ctx, { customer: ALPHA_CODE, product: `${PUBLISHER} Users`, ci: `alpha-lt2-${S}`, version: '3.1' }))) as { host: string; title: string };
    expect(ran.host).toBe(`alpha-lt2-${S}`);

    for (const name of ['software_inventory', 'software_compliance', 'licence_renewals', 'get_licence', 'record_licence', 'record_installation']) {
      const t = toolByName(name)!;
      expect(t.toolset).toBe('assets');
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description.length).toBeLessThan(700);
      if (t.action) expect(typeof t.preview).toBe('function');
      if (t.portal) for (const p of t.portal) expect(p).toMatch(/^portal:/);
    }
    const offeredToAdmin = await asPadmin(async (ctx) => availableTools(ctx).map((t) => t.name));
    for (const n of ['software_inventory', 'software_compliance', 'licence_renewals', 'get_licence']) expect(offeredToAdmin).toContain(n);
    for (const n of ['record_licence', 'record_installation']) expect(offeredToAdmin).not.toContain(n);
    const offeredToUser = await asPuser(async (ctx) => availableTools(ctx).map((t) => t.name));
    expect(offeredToUser).not.toContain('software_compliance');
  });
});

describe('reports', () => {
  it('software_inventory lists the fixture host and licence_compliance counts the positions, without a cost column for the portal', async () => {
    const inv = await asAdmin((ctx) => runReport(ctx, { reportKey: 'software_inventory', parameters: { customerId: ids.alpha } } as never));
    const invRows = (inv as { result: { rows: Record<string, unknown>[]; summary: { label: string; value: unknown }[] } }).result;
    expect(invRows.rows.some((r) => r.host === `alpha-srv-${S}`)).toBe(true);
    expect(invRows.summary.find((s) => s.label === 'Installations')!.value).toBe(invRows.rows.length);
    const positions = await asAdmin((ctx) => svc.complianceFor(ctx, { customerId: ids.alpha }));
    const comp = (await asAdmin((ctx) => runReport(ctx, { reportKey: 'licence_compliance', parameters: { customerId: ids.alpha } } as never))) as { result: { rows: Record<string, unknown>[]; summary: { label: string; value: unknown }[]; sections: { title: string; columns: { key: string }[]; rows: Record<string, unknown>[] }[] } };
    expect(comp.result.summary.map((s) => s.label)).toEqual(['Titles', 'Over-deployed', 'Unlicensed', 'Under-deployed', 'Licences ending (90d)']);
    expect(comp.result.summary.find((s) => s.label === 'Over-deployed')!.value).toBe(positions.filter((p) => p.position === 'over_deployed').length);
    expect(comp.result.rows.length).toBe(positions.length);
    const licences = comp.result.sections.find((s) => s.title === 'Licences')!;
    expect(licences.columns.some((c) => c.key === 'cost')).toBe(true);
    const portal = (await asPadmin((ctx) => runReport(ctx, { reportKey: 'licence_compliance', parameters: { customerId: ids.beta } } as never))) as typeof comp;
    expect(portal.result.rows.length).toBe(positions.length);
    expect(portal.result.rows.every((r) => r.customer === `Alpha Software ${S}`)).toBe(true);
    const portalLicences = portal.result.sections.find((s) => s.title === 'Licences')!;
    expect(portalLicences.columns.some((c) => c.key === 'cost')).toBe(false);
    expect(portalLicences.rows.every((r) => !('cost' in r))).toBe(true);
    expect(text(portal)).not.toContain(BETA_LICENCE);
    // A customer user holding portal:reports but not portal:software is refused by the definitions themselves.
    await expect(asPuser((ctx) => findReport('licence_compliance')!.run(ctx, { customerId: ids.alpha } as never))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(asPuser((ctx) => findReport('software_inventory')!.run(ctx, { customerId: ids.alpha } as never))).rejects.toBeInstanceOf(ForbiddenError);
    const unlinked = invRows.summary.find((s) => s.label === 'Unlinked')!.value;
    expect(unlinked).toBe(invRows.rows.filter((r) => !r.ci_id && !r.asset_id).length);
  });
});
