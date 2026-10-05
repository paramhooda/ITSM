import { and, asc, desc, eq, gte, ilike, inArray, isNull, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { LicenceStatus } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema, withSystem, type Tx } from '@/db/client';
import { storage } from '@/lib/storage';
import { ConflictError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { searchFts, orderBy, limitOffset } from '@/core/query';
import { todayStr, addDays, daysBetween } from '@/core/overview';
import { complianceFor, positionFor, type CompliancePosition } from './compliance';
import { loadSoftwareSettings, defaultMetric, defaultTerm } from './settings';
import { NEEDS_HOST, DATES_IN_ORDER, endAfterStart, type ProductListQuery, type ProductBody, type ProductPatch, type InstallationListQuery, type InstallationBody, type InstallationPatch, type LicenceListQuery, type LicenceBody, type LicencePatch, type RenewBody, type ComplianceQuery, type RenewalsQuery } from './schemas';

export { complianceFor, computePosition, positionFor, type CompliancePosition } from './compliance';
export { loadSoftwareSettings, defaultMetric, defaultTerm, type SoftwareSettings } from './settings';

const { softwareProducts: products, softwareInstallations: installs, softwareLicences: licences, softwareNotifications, customers, contracts, cis, assets, sites, configOptions, users } = schema;

export type ProductRow = typeof products.$inferSelect;
export type InstallationRow = typeof installs.$inferSelect;
export type LicenceRow = typeof licences.$inferSelect;

// ---------------------------------------------------------------- helpers

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Normalised `publisher/name[/version-family]` key, unique across the catalogue. */
export function productKey(publisher: string, name: string, versionFamily?: string | null) {
  const parts = [slug(publisher), slug(name)];
  const vf = versionFamily?.trim() ? slug(versionFamily) : '';
  if (vf) parts.push(vf);
  return parts.join('/');
}

/** "Microsoft Office LTSC 2021"; the publisher is not repeated when the product name already starts with it ("Microsoft 365 E3"). */
export const titleOf = (p: Pick<ProductRow, 'publisher' | 'name' | 'versionFamily'>) => {
  const publisher = p.publisher.trim();
  const name = p.name.trim();
  const named = publisher && name.toLowerCase().startsWith(`${publisher.toLowerCase()} `) ? name : `${publisher} ${name}`.trim();
  return `${named}${p.versionFamily ? ` ${p.versionFamily}` : ''}`;
};

async function loadProduct(ctx: Ctx, id: string): Promise<ProductRow> {
  const [row] = await ctx.tx.select().from(products).where(eq(products.id, id)).limit(1);
  if (!row) throw new NotFoundError('Software title');
  if (row.customerId) ctx.requireCustomer(row.customerId);
  return row;
}

async function loadInstallation(ctx: Ctx, id: string): Promise<InstallationRow> {
  const [row] = await ctx.tx.select().from(installs).where(eq(installs.id, id)).limit(1);
  if (!row) throw new NotFoundError('Software installation');
  ctx.requireCustomer(row.customerId);
  return row;
}

async function loadLicence(ctx: Ctx, id: string): Promise<LicenceRow> {
  const [row] = await ctx.tx.select().from(licences).where(eq(licences.id, id)).limit(1);
  if (!row) throw new NotFoundError('Licence');
  ctx.requireCustomer(row.customerId);
  return row;
}

async function assertContract(ctx: Ctx, customerId: string, contractId?: string | null) {
  if (!contractId) return;
  const [c] = await ctx.tx.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.customerId, customerId))).limit(1);
  if (!c) throw new ValidationError('Contract does not belong to this customer');
}

async function assertCategory(ctx: Ctx, id?: string | null) {
  if (!id) return;
  const [o] = await ctx.tx.select({ id: configOptions.id }).from(configOptions).where(and(eq(configOptions.id, id), eq(configOptions.type, 'software_category'))).limit(1);
  if (!o) throw new ValidationError('Invalid software category');
}

/**
 * The live state of a licence term, in this precedence: inactive, renewed (a
 * successor exists, even past the end date), expired, future, expiring
 * (ends within the longest notice period), active.
 */
export function licenceStatus(l: Pick<LicenceRow, 'isActive' | 'successorId' | 'startDate' | 'endDate'>, noticeDays: number[], today = todayStr()): LicenceStatus {
  if (!l.isActive) return 'inactive';
  if (l.successorId) return 'renewed';
  if (l.endDate && l.endDate < today) return 'expired';
  if (l.startDate && l.startDate > today) return 'future';
  if (l.endDate && l.endDate <= addDays(today, Math.max(0, ...noticeDays))) return 'expiring';
  return 'active';
}

/** SQL for one status, the same precedence as `licenceStatus` (used by the staff and the portal licence lists so pagination stays exact). */
export function licenceStatusCond(status: LicenceStatus, today: string, maxNotice: number): SQL {
  const l = licences;
  const horizon = addDays(today, maxNotice);
  const live = and(eq(l.isActive, true), isNull(l.successorId))!;
  const started = or(isNull(l.startDate), lte(l.startDate, today))!;
  const notEnded = or(isNull(l.endDate), gte(l.endDate, today))!;
  switch (status) {
    case 'inactive': return eq(l.isActive, false);
    case 'renewed': return and(eq(l.isActive, true), isNotNull(l.successorId))!;
    case 'expired': return and(live, sql`${l.endDate} < ${today}::date`)!;
    case 'future': return and(live, notEnded, sql`${l.startDate} > ${today}::date`)!;
    case 'expiring': return and(live, started, sql`${l.endDate} >= ${today}::date`, sql`${l.endDate} <= ${horizon}::date`)!;
    case 'active': return and(live, started, or(isNull(l.endDate), sql`${l.endDate} > ${horizon}::date`))!;
  }
}

const daysLeftOf = (endDate: string | null, today: string) => (endDate ? daysBetween(today, endDate) : null);
const numOrNull = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------- products

const category = alias(configOptions, 'software_category');

/** Per-customer narrowing for the correlated subqueries; the column is qualified with the inner alias because software_products carries a customer_id too. */
const customerCond = (alias: 'i' | 'l', customerId?: string) => (customerId ? sql` AND ${sql.raw(alias)}.customer_id = ${customerId}::uuid` : sql``);

function productCounts(customerId?: string) {
  const ci = customerCond('i', customerId);
  const cl = customerCond('l', customerId);
  return {
    installations: sql<number>`(SELECT count(*)::int FROM software_installations i WHERE i.product_id = ${products.id}${ci})`,
    customers: sql<number>`(SELECT count(DISTINCT x.customer_id)::int FROM (SELECT i.customer_id FROM software_installations i WHERE i.product_id = ${products.id}${ci} UNION SELECT l.customer_id FROM software_licences l WHERE l.product_id = ${products.id}${cl}) x)`,
    licensedSeats: sql<number>`(SELECT coalesce(sum(l.quantity), 0)::int FROM software_licences l WHERE l.product_id = ${products.id} AND l.is_active AND l.metric <> 'site' AND (l.start_date IS NULL OR l.start_date <= current_date) AND (l.end_date IS NULL OR l.end_date >= current_date)${cl})`,
  };
}

function buildProductWhere(ctx: Ctx, q: ProductListQuery) {
  const conds: (SQL | undefined)[] = [];
  if (q.customerId) ctx.requireCustomer(q.customerId);
  if (!q.includeInactive) conds.push(eq(products.isActive, true));
  if (q.categoryId) conds.push(eq(products.categoryId, q.categoryId));
  if (q.publisher) conds.push(ilike(products.publisher, `%${q.publisher.replace(/[%_]/g, (m) => `\\${m}`)}%`));
  if (q.licenceModel) conds.push(eq(products.licenceModel, q.licenceModel));
  if (q.inUseOnly) {
    conds.push(sql`(EXISTS (SELECT 1 FROM software_installations i WHERE i.product_id = ${products.id}${customerCond('i', q.customerId)}) OR EXISTS (SELECT 1 FROM software_licences l WHERE l.product_id = ${products.id}${customerCond('l', q.customerId)}))`);
  }
  if (q.q) conds.push(searchFts(q.q, products.searchVector, products.name, products.publisher));
  const where = and(...conds.filter((c): c is SQL => !!c));
  const counts = productCounts(q.customerId);
  const sortable = { name: products.name, publisher: products.publisher, installations: counts.installations, customers: counts.customers, createdAt: products.createdAt, updatedAt: products.updatedAt };
  const order = orderBy(sortable, q.sort, q.order ?? 'asc', products.name);
  return { where, order, counts, ...limitOffset(q) };
}

export async function listProducts(ctx: Ctx, q: ProductListQuery) {
  ctx.require('software:read', q.customerId ?? null);
  const { where, order, counts, limit, offset } = buildProductWhere(ctx, q);
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(products).where(where);
  if (q.fields === 'min') {
    const items = await ctx.tx.select({ id: products.id, key: products.key, publisher: products.publisher, name: products.name, versionFamily: products.versionFamily, licenceModel: products.licenceModel, isActive: products.isActive }).from(products).where(where).orderBy(order, asc(products.name)).limit(limit).offset(offset);
    return { items, total: count, page: q.page, pageSize: q.pageSize };
  }
  const rows = await ctx.tx
    .select({
      id: products.id, key: products.key, customerId: products.customerId, publisher: products.publisher, name: products.name, versionFamily: products.versionFamily,
      categoryId: products.categoryId, categoryLabel: category.label, licenceModel: products.licenceModel, description: products.description, website: products.website, eolDate: products.eolDate,
      isActive: products.isActive, tags: products.tags, createdAt: products.createdAt, updatedAt: products.updatedAt,
      installations: counts.installations, customers: counts.customers, licensedSeats: counts.licensedSeats,
    })
    .from(products)
    .leftJoin(category, eq(category.id, products.categoryId))
    .where(where)
    .orderBy(order, asc(products.name))
    .limit(limit)
    .offset(offset);
  const positions = rows.length ? await complianceFor(ctx, { customerId: q.customerId }) : [];
  const byProduct = new Map<string, CompliancePosition[]>();
  for (const p of positions) byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p]);
  const items = rows.map((r) => {
    const list = byProduct.get(r.id) ?? [];
    const positionsOf = { compliant: 0, under_deployed: 0, over_deployed: 0, unlicensed: 0, unlimited: 0 };
    for (const p of list) positionsOf[p.position]++;
    return { ...r, overDeployedCustomers: positionsOf.over_deployed + positionsOf.unlicensed, positions: positionsOf };
  });
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

export async function getProduct(ctx: Ctx, id: string, customerId?: string) {
  ctx.require('software:read', customerId ?? null);
  if (customerId) ctx.requireCustomer(customerId);
  const p = await loadProduct(ctx, id);
  const [cat] = p.categoryId ? await ctx.tx.select({ label: configOptions.label, key: configOptions.key }).from(configOptions).where(eq(configOptions.id, p.categoryId)).limit(1) : [];
  const settings = await loadSoftwareSettings(ctx.tx);
  const compliance = await complianceFor(ctx, { productId: id, customerId });
  const installations = (await listInstallations(ctx, { page: 1, pageSize: 100, productId: id, customerId, sort: 'lastSeenAt', order: 'desc', stale: undefined } as InstallationListQuery)).items;
  const owner = alias(users, 'licence_owner');
  const licenceRows = await ctx.tx
    .select({ ...licenceColumns(), customerName: customers.name, contractNumber: contracts.number, ownerName: owner.name })
    .from(licences)
    .leftJoin(customers, eq(customers.id, licences.customerId))
    .leftJoin(contracts, eq(contracts.id, licences.contractId))
    .leftJoin(owner, eq(owner.id, licences.ownerUserId))
    .where(and(eq(licences.productId, id), customerId ? eq(licences.customerId, customerId) : undefined))
    .orderBy(desc(licences.isActive), asc(licences.endDate), asc(licences.name))
    .limit(200);
  const today = todayStr();
  return {
    ...p,
    categoryLabel: cat?.label ?? null,
    categoryKey: cat?.key ?? null,
    installationCount: compliance.reduce((s, c) => s + c.installed, 0),
    customerCount: new Set(compliance.map((c) => c.customerId)).size,
    licensedSeats: compliance.reduce((s, c) => s + (c.entitled ?? 0), 0),
    overDeployedCustomers: compliance.filter((c) => c.position === 'over_deployed' || c.position === 'unlicensed').length,
    compliance,
    installations,
    licences: licenceRows.map((l) => ({ ...decorateLicence(l, settings.noticeDays, today), customerName: l.customerName, contractNumber: l.contractNumber, ownerName: l.ownerName })),
  };
}

async function assertUniqueKey(ctx: Ctx, key: string, exceptId?: string) {
  const [dup] = await ctx.tx.select({ id: products.id }).from(products).where(and(eq(products.key, key), exceptId ? sql`${products.id} <> ${exceptId}` : undefined)).limit(1);
  if (dup) throw new ConflictError('A title with this publisher, name and version family already exists');
}

export async function createProduct(ctx: Ctx, input: ProductBody) {
  ctx.require('software:manage');
  await assertCategory(ctx, input.categoryId);
  const key = productKey(input.publisher, input.name, input.versionFamily);
  await assertUniqueKey(ctx, key);
  const [row] = await ctx.tx.insert(products).values({ ...input, versionFamily: input.versionFamily?.trim() || null, key, customerId: null } as typeof products.$inferInsert).returning();
  await ctx.audit({ entityType: 'software_product', entityId: row!.id, entityLabel: titleOf(row!), action: 'create', customerId: null, metadata: { key } });
  return getProduct(ctx, row!.id);
}

export async function updateProduct(ctx: Ctx, id: string, patch: ProductPatch) {
  ctx.require('software:manage');
  const before = await loadProduct(ctx, id);
  if (patch.categoryId !== undefined) await assertCategory(ctx, patch.categoryId);
  const merged = { publisher: patch.publisher ?? before.publisher, name: patch.name ?? before.name, versionFamily: patch.versionFamily === undefined ? before.versionFamily : patch.versionFamily?.trim() || null };
  const key = productKey(merged.publisher, merged.name, merged.versionFamily);
  if (key !== before.key) await assertUniqueKey(ctx, key, id);
  const values = { ...patch, ...(patch.versionFamily !== undefined ? { versionFamily: merged.versionFamily } : {}), key };
  const [after] = await ctx.tx.update(products).set({ ...values, updatedAt: new Date() } as never).where(eq(products.id, id)).returning();
  const changes = diffChanges(before as Record<string, unknown>, values as Record<string, unknown>);
  if (Object.keys(changes).length) await ctx.audit({ entityType: 'software_product', entityId: id, entityLabel: titleOf(after!), action: 'update', customerId: null, changes });
  return getProduct(ctx, id);
}

export async function deleteProduct(ctx: Ctx, id: string) {
  ctx.require('software:manage');
  const p = await loadProduct(ctx, id);
  // Counted as the system: a customer-scoped caller sees only its own customers' rows under RLS, while the restrict FK counts every customer's.
  const { installCount, licenceCount } = await withSystem(async (tx) => {
    const [i] = await tx.select({ n: sql<number>`count(*)::int` }).from(installs).where(eq(installs.productId, id));
    const [l] = await tx.select({ n: sql<number>`count(*)::int` }).from(licences).where(eq(licences.productId, id));
    return { installCount: i?.n ?? 0, licenceCount: l?.n ?? 0 };
  });
  if (installCount > 0 || licenceCount > 0) throw new ConflictError(`${titleOf(p)} has ${installCount} installation(s) and ${licenceCount} licence(s). Deactivate the title instead.`);
  await ctx.tx.delete(softwareNotifications).where(and(eq(softwareNotifications.scopeType, 'product'), eq(softwareNotifications.scopeId, id)));
  await ctx.tx.delete(products).where(eq(products.id, id));
  await ctx.audit({ entityType: 'software_product', entityId: id, entityLabel: titleOf(p), action: 'delete', customerId: null });
  return { deleted: true };
}

// ---------------------------------------------------------------- installations

const ciAsset = alias(assets, 'ci_asset');
const ciSite = alias(sites, 'ci_site');
const assetSite = alias(sites, 'asset_site');

function staleCond(days: number) {
  return sql`(${installs.source} <> 'manual' AND ${installs.lastSeenAt} < now() - make_interval(days => ${days}::int))`;
}

async function buildInstallWhere(ctx: Ctx, q: InstallationListQuery) {
  const conds: (SQL | undefined)[] = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(installs.customerId, q.customerId));
  }
  if (q.productId) conds.push(eq(installs.productId, q.productId));
  if (q.ciId) conds.push(eq(installs.ciId, q.ciId));
  if (q.assetId) conds.push(eq(installs.assetId, q.assetId));
  if (q.siteId) conds.push(or(eq(cis.siteId, q.siteId), eq(assets.siteId, q.siteId)));
  if (q.source) conds.push(eq(installs.source, q.source));
  if (q.host === 'ci') conds.push(isNotNull(installs.ciId));
  if (q.host === 'asset') conds.push(and(isNull(installs.ciId), isNotNull(installs.assetId)));
  if (q.host === 'unlinked') conds.push(and(isNull(installs.ciId), isNull(installs.assetId)));
  const settings = await loadSoftwareSettings(ctx.tx);
  if (q.stale === true) conds.push(staleCond(settings.staleInstallDays));
  if (q.stale === false) conds.push(sql`NOT ${staleCond(settings.staleInstallDays)}`);
  if (q.q) conds.push(searchFts(q.q, products.searchVector, products.name, installs.hostName, installs.assignedUser));
  const where = and(...conds.filter((c): c is SQL => !!c));
  const hostExpr = sql`coalesce(${cis.name}, ${assets.tag}, ${installs.hostName}, ${installs.assignedUser})`;
  const sortable = { product: products.name, host: hostExpr, customer: customers.name, version: installs.version, lastSeenAt: installs.lastSeenAt, createdAt: installs.createdAt, updatedAt: installs.updatedAt };
  const order = orderBy(sortable, q.sort, q.order ?? (q.sort ? 'asc' : 'desc'), installs.createdAt);
  return { where, order, settings, ...limitOffset(q) };
}

/** The list-row shape: the installation with its title, customer, host, site and stale flag. */
function installationSelect(ctx: Ctx, staleDays: number) {
  return ctx.tx
    .select({
      id: installs.id, customerId: installs.customerId, customerName: customers.name, productId: installs.productId, productPublisher: products.publisher, productName: products.name, versionFamily: products.versionFamily,
      ciId: installs.ciId, ciName: cis.name, ciHostname: cis.hostname, ciStatus: cis.status, assetId: installs.assetId, assetTag: assets.tag, assetName: assets.name, siteName: sql<string | null>`coalesce(${ciSite.name}, ${assetSite.name})`,
      hostName: installs.hostName, assignedUser: installs.assignedUser, version: installs.version, edition: installs.edition, cores: installs.cores, installPath: installs.installPath, installedAt: installs.installedAt,
      source: installs.source, discoveredAt: installs.discoveredAt, lastSeenAt: installs.lastSeenAt, notes: installs.notes, createdAt: installs.createdAt, updatedAt: installs.updatedAt,
      stale: sql<boolean>`${staleCond(staleDays)}`,
    })
    .from(installs)
    .innerJoin(products, eq(products.id, installs.productId))
    .leftJoin(customers, eq(customers.id, installs.customerId))
    .leftJoin(cis, eq(cis.id, installs.ciId))
    .leftJoin(assets, eq(assets.id, installs.assetId))
    .leftJoin(ciSite, eq(ciSite.id, cis.siteId))
    .leftJoin(assetSite, eq(assetSite.id, assets.siteId));
}

/** One installation in the list-row shape, looked up by id (the create and update responses). */
async function installationRow(ctx: Ctx, id: string) {
  const settings = await loadSoftwareSettings(ctx.tx);
  const [row] = await installationSelect(ctx, settings.staleInstallDays).where(eq(installs.id, id)).limit(1);
  if (!row) throw new NotFoundError('Software installation');
  return row;
}

export async function listInstallations(ctx: Ctx, q: InstallationListQuery) {
  ctx.require('software:read', q.customerId ?? null);
  const { where, order, settings, limit, offset } = await buildInstallWhere(ctx, q);
  const base = () => installationSelect(ctx, settings.staleInstallDays);
  const [{ count }] = await ctx.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(installs)
    .innerJoin(products, eq(products.id, installs.productId))
    .leftJoin(customers, eq(customers.id, installs.customerId))
    .leftJoin(cis, eq(cis.id, installs.ciId))
    .leftJoin(assets, eq(assets.id, installs.assetId))
    .where(where);
  const items = await base().where(where).orderBy(order, asc(installs.id)).limit(limit).offset(offset);
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

/** The installations recorded on one host, for the CI and asset record pages (limit 100). */
export async function installationsForHost(tx: Tx, host: { ciId?: string; assetId?: string }) {
  const cond = host.ciId ? eq(installs.ciId, host.ciId) : host.assetId ? eq(installs.assetId, host.assetId) : undefined;
  if (!cond) return [];
  return tx
    .select({ id: installs.id, productId: installs.productId, publisher: products.publisher, name: products.name, versionFamily: products.versionFamily, version: installs.version, edition: installs.edition, source: installs.source, lastSeenAt: installs.lastSeenAt, assignedUser: installs.assignedUser })
    .from(installs)
    .innerJoin(products, eq(products.id, installs.productId))
    .where(cond)
    .orderBy(asc(products.publisher), asc(products.name))
    .limit(100);
}

export interface InstallationRef { customerId: string; productId: string; ciId?: string | null; assetId?: string | null; hostName?: string | null; assignedUser?: string | null }

/**
 * The installation an import row or a manual record would duplicate: the same
 * title on the same CI, else the same asset, else the same host name and user,
 * else the same user with no host at all.
 */
export async function findInstallation(tx: Tx, ref: InstallationRef): Promise<InstallationRow | null> {
  const base = [eq(installs.customerId, ref.customerId), eq(installs.productId, ref.productId)];
  const one = async (cond: SQL) => (await tx.select().from(installs).where(and(...base, cond)).orderBy(asc(installs.createdAt)).limit(1))[0] ?? null;
  if (ref.ciId) {
    const hit = await one(eq(installs.ciId, ref.ciId));
    if (hit) return hit;
  }
  if (ref.assetId) {
    const hit = await one(eq(installs.assetId, ref.assetId));
    if (hit) return hit;
  }
  const host = ref.hostName?.trim().toLowerCase();
  const user = ref.assignedUser?.trim().toLowerCase() ?? '';
  if (host) {
    const hit = await one(sql`lower(${installs.hostName}) = ${host} AND coalesce(lower(${installs.assignedUser}), '') = ${user}`);
    if (hit) return hit;
  }
  if (user && !ref.ciId && !ref.assetId && !host) {
    const hit = await one(sql`lower(${installs.assignedUser}) = ${user} AND ${installs.ciId} IS NULL AND ${installs.assetId} IS NULL AND ${installs.hostName} IS NULL`);
    if (hit) return hit;
  }
  return null;
}

/** Checks the CI and the asset belong to the customer and fills the other half of the pair plus the host name. */
export async function resolveHost(tx: Tx, customerId: string, input: { ciId?: string | null; assetId?: string | null; hostName?: string | null }) {
  let ciId = input.ciId ?? null;
  let assetId = input.assetId ?? null;
  let hostName = input.hostName?.trim() || null;
  let ci: { id: string; name: string; hostname: string | null; assetId: string | null } | null = null;
  let asset: { id: string; tag: string; ciId: string | null } | null = null;
  if (ciId) {
    [ci] = await tx.select({ id: cis.id, name: cis.name, hostname: cis.hostname, assetId: cis.assetId }).from(cis).where(and(eq(cis.id, ciId), eq(cis.customerId, customerId))).limit(1);
    if (!ci) throw new ValidationError('CI does not belong to this customer');
    if (!assetId && ci.assetId) assetId = ci.assetId;
  }
  if (assetId) {
    [asset] = await tx.select({ id: assets.id, tag: assets.tag, ciId: assets.ciId }).from(assets).where(and(eq(assets.id, assetId), eq(assets.customerId, customerId))).limit(1);
    if (!asset) throw new ValidationError('Asset does not belong to this customer');
    if (!ciId && asset.ciId) {
      ciId = asset.ciId;
      [ci] = await tx.select({ id: cis.id, name: cis.name, hostname: cis.hostname, assetId: cis.assetId }).from(cis).where(eq(cis.id, ciId)).limit(1);
    }
  }
  if (!hostName) hostName = ci?.hostname ?? ci?.name ?? asset?.tag ?? null;
  return { ciId, assetId, hostName, ci, asset };
}

const hostLabel = (h: { ci?: { name: string } | null; asset?: { tag: string } | null; hostName: string | null }, assignedUser?: string | null) => h.ci?.name ?? h.asset?.tag ?? h.hostName ?? assignedUser ?? 'unknown host';

export async function createInstallation(ctx: Ctx, input: InstallationBody) {
  ctx.requireCustomer(input.customerId);
  ctx.require('software:manage', input.customerId);
  const product = await loadProduct(ctx, input.productId);
  const host = await resolveHost(ctx.tx, input.customerId, input);
  const assignedUser = input.assignedUser?.trim() || null;
  if (!host.ciId && !host.assetId && !host.hostName && !assignedUser) throw new ValidationError(NEEDS_HOST);
  const dup = await findInstallation(ctx.tx, { customerId: input.customerId, productId: input.productId, ciId: host.ciId, assetId: host.assetId, hostName: host.hostName, assignedUser });
  if (dup) throw new ConflictError('This title is already recorded on that host');
  const [row] = await ctx.tx
    .insert(installs)
    .values({ ...input, ciId: host.ciId, assetId: host.assetId, hostName: host.hostName, assignedUser, source: input.source ?? 'manual', lastSeenAt: input.source && input.source !== 'manual' ? new Date() : null } as typeof installs.$inferInsert)
    .returning();
  await ctx.audit({ entityType: 'software_installation', entityId: row!.id, entityLabel: `${titleOf(product)} @ ${hostLabel(host, assignedUser)}`, action: 'create', customerId: input.customerId, metadata: { productId: product.id, ciId: host.ciId, assetId: host.assetId } });
  return installationRow(ctx, row!.id);
}

export async function updateInstallation(ctx: Ctx, id: string, patch: InstallationPatch) {
  const before = await loadInstallation(ctx, id);
  ctx.require('software:manage', before.customerId);
  const merged = { ciId: patch.ciId === undefined ? before.ciId : patch.ciId, assetId: patch.assetId === undefined ? before.assetId : patch.assetId, hostName: patch.hostName === undefined ? before.hostName : patch.hostName };
  const host = await resolveHost(ctx.tx, before.customerId, merged);
  const assignedUser = patch.assignedUser === undefined ? before.assignedUser : patch.assignedUser?.trim() || null;
  if (!host.ciId && !host.assetId && !host.hostName && !assignedUser) throw new ValidationError(NEEDS_HOST);
  // A record that becomes imported or discovered starts its freshness clock now, as a create with that source does.
  const source = patch.source ?? before.source;
  const values = { ...patch, ciId: host.ciId, assetId: host.assetId, hostName: host.hostName, assignedUser, ...(source !== 'manual' && !before.lastSeenAt ? { lastSeenAt: new Date() } : {}) };
  await ctx.tx.update(installs).set({ ...values, updatedAt: new Date() } as never).where(eq(installs.id, id));
  const changes = diffChanges(before as Record<string, unknown>, values as Record<string, unknown>);
  const product = await loadProduct(ctx, before.productId);
  if (Object.keys(changes).length) await ctx.audit({ entityType: 'software_installation', entityId: id, entityLabel: `${titleOf(product)} @ ${hostLabel(host, assignedUser)}`, action: 'update', customerId: before.customerId, changes });
  return installationRow(ctx, id);
}

export async function deleteInstallation(ctx: Ctx, id: string) {
  const row = await loadInstallation(ctx, id);
  ctx.require('software:manage', row.customerId);
  const product = await loadProduct(ctx, row.productId);
  await ctx.tx.delete(installs).where(eq(installs.id, id));
  await ctx.audit({ entityType: 'software_installation', entityId: id, entityLabel: `${titleOf(product)} @ ${row.hostName ?? row.assignedUser ?? 'unknown host'}`, action: 'delete', customerId: row.customerId });
  return { deleted: true };
}

// ---------------------------------------------------------------- licences

function licenceColumns() {
  return {
    id: licences.id, customerId: licences.customerId, productId: licences.productId, contractId: licences.contractId, name: licences.name, metric: licences.metric, term: licences.term, quantity: licences.quantity,
    startDate: licences.startDate, endDate: licences.endDate, renewalDate: licences.renewalDate, autoRenew: licences.autoRenew, cost: licences.cost, currency: licences.currency, vendor: licences.vendor,
    poNumber: licences.poNumber, invoiceNumber: licences.invoiceNumber, licenceKey: licences.licenceKey, ownerUserId: licences.ownerUserId, notes: licences.notes, isActive: licences.isActive,
    successorId: licences.successorId, renewedAt: licences.renewedAt, createdAt: licences.createdAt, updatedAt: licences.updatedAt,
  };
}

/** Adds the live status, the days left and numeric seats and cost to a licence row. */
function decorateLicence<T extends Pick<LicenceRow, 'isActive' | 'successorId' | 'startDate' | 'endDate' | 'quantity' | 'cost'>>(l: T, noticeDays: number[], today: string) {
  return { ...l, quantity: Number(l.quantity), cost: numOrNull(l.cost), status: licenceStatus(l, noticeDays, today), daysLeft: daysLeftOf(l.endDate, today) };
}

const owner = alias(users, 'licence_owner');

function buildLicenceWhere(ctx: Ctx, q: LicenceListQuery, today: string, maxNotice: number) {
  const conds: (SQL | undefined)[] = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(licences.customerId, q.customerId));
  }
  if (q.productId) conds.push(eq(licences.productId, q.productId));
  if (q.contractId) conds.push(eq(licences.contractId, q.contractId));
  if (q.metric) conds.push(eq(licences.metric, q.metric));
  if (q.status) conds.push(licenceStatusCond(q.status, today, maxNotice));
  if (q.endingWithinDays !== undefined) conds.push(and(eq(licences.isActive, true), isNull(licences.successorId), isNotNull(licences.endDate), gte(licences.endDate, today), lte(licences.endDate, addDays(today, q.endingWithinDays))));
  // In term today: active, started and not ended (renewed licences still in term included), the same rule as the overview's "licences in term".
  if (q.inTerm === true) conds.push(and(eq(licences.isActive, true), or(isNull(licences.startDate), lte(licences.startDate, today)), or(isNull(licences.endDate), gte(licences.endDate, today))));
  if (q.q) conds.push(or(ilike(licences.name, `%${q.q.replace(/[%_]/g, (m) => `\\${m}`)}%`), searchFts(q.q, products.searchVector, products.name, products.publisher)));
  const where = and(...conds.filter((c): c is SQL => !!c));
  const sortable = { name: licences.name, customer: customers.name, product: products.name, quantity: licences.quantity, endDate: licences.endDate, renewalDate: licences.renewalDate, createdAt: licences.createdAt, updatedAt: licences.updatedAt };
  const order = orderBy(sortable, q.sort, q.order ?? 'asc', licences.endDate);
  return { where, order, ...limitOffset(q) };
}

export async function listLicences(ctx: Ctx, q: LicenceListQuery) {
  ctx.require('software:read', q.customerId ?? null);
  const settings = await loadSoftwareSettings(ctx.tx);
  const today = todayStr();
  const { where, order, limit, offset } = buildLicenceWhere(ctx, q, today, Math.max(0, ...settings.noticeDays));
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(licences).innerJoin(products, eq(products.id, licences.productId)).leftJoin(customers, eq(customers.id, licences.customerId)).where(where);
  const rows = await ctx.tx
    .select({ ...licenceColumns(), productPublisher: products.publisher, productName: products.name, versionFamily: products.versionFamily, customerName: customers.name, contractNumber: contracts.number, ownerName: owner.name })
    .from(licences)
    .innerJoin(products, eq(products.id, licences.productId))
    .leftJoin(customers, eq(customers.id, licences.customerId))
    .leftJoin(contracts, eq(contracts.id, licences.contractId))
    .leftJoin(owner, eq(owner.id, licences.ownerUserId))
    .where(where)
    .orderBy(sql`${order} NULLS LAST`, asc(licences.name))
    .limit(limit)
    .offset(offset);
  const positions = rows.length ? await complianceFor(ctx, { customerId: q.customerId, productId: q.productId }) : [];
  const posOf = new Map(positions.map((p) => [`${p.customerId}:${p.productId}`, p]));
  const items = rows.map((l) => {
    const pos = posOf.get(`${l.customerId}:${l.productId}`);
    return { ...decorateLicence(l, settings.noticeDays, today), installed: pos?.installed ?? 0, entitled: pos?.entitled ?? null, utilisationPct: pos ? pos.utilisationPct : null, position: pos?.position ?? null };
  });
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

export async function getLicence(ctx: Ctx, id: string) {
  const l = await loadLicence(ctx, id);
  ctx.require('software:read', l.customerId);
  const settings = await loadSoftwareSettings(ctx.tx);
  const today = todayStr();
  const [meta] = await ctx.tx
    .select({ productPublisher: products.publisher, productName: products.name, versionFamily: products.versionFamily, licenceModel: products.licenceModel, customerName: customers.name, customerCode: customers.code, ownerName: owner.name })
    .from(licences)
    .innerJoin(products, eq(products.id, licences.productId))
    .leftJoin(customers, eq(customers.id, licences.customerId))
    .leftJoin(owner, eq(owner.id, licences.ownerUserId))
    .where(eq(licences.id, id))
    .limit(1);
  const [contract] = l.contractId ? await ctx.tx.select({ id: contracts.id, number: contracts.number, name: contracts.name, status: contracts.status, endDate: contracts.endDate }).from(contracts).where(eq(contracts.id, l.contractId)).limit(1) : [];
  const [successor] = l.successorId ? await ctx.tx.select({ id: licences.id, name: licences.name, startDate: licences.startDate, endDate: licences.endDate }).from(licences).where(eq(licences.id, l.successorId)).limit(1) : [];
  const [predecessor] = await ctx.tx.select({ id: licences.id, name: licences.name, startDate: licences.startDate, endDate: licences.endDate }).from(licences).where(eq(licences.successorId, id)).limit(1);
  const compliance = await positionFor(ctx, l.customerId, l.productId);
  const installations = (await listInstallations(ctx, { page: 1, pageSize: 100, customerId: l.customerId, productId: l.productId, sort: 'lastSeenAt', order: 'desc', stale: undefined } as InstallationListQuery)).items;
  return {
    ...decorateLicence(l, settings.noticeDays, today),
    ...meta,
    contractNumber: contract?.number ?? null,
    contract: contract ?? null,
    successor: successor ?? null,
    predecessor: predecessor ?? null,
    compliance,
    installed: compliance?.installed ?? 0,
    utilisationPct: compliance?.utilisationPct ?? null,
    installations,
  };
}

function toLicenceRow(input: Partial<LicenceBody>) {
  const { quantity, cost, ...rest } = input;
  return { ...rest, ...(quantity !== undefined ? { quantity: String(quantity) } : {}), ...(cost !== undefined ? { cost: cost === null ? null : String(cost) } : {}) };
}

function assertSeats(metric: string, quantity: number) {
  if (metric !== 'site' && !(quantity > 0)) throw new ValidationError('A licence needs at least one seat unless it is a site licence');
}

export async function createLicence(ctx: Ctx, input: LicenceBody) {
  ctx.requireCustomer(input.customerId);
  ctx.require('software:manage', input.customerId);
  const product = await loadProduct(ctx, input.productId);
  if (!product.isActive) throw new ValidationError(`${titleOf(product)} is inactive; reactivate the title first`);
  await assertContract(ctx, input.customerId, input.contractId);
  const metric = input.metric ?? defaultMetric(product.licenceModel);
  const term = input.term ?? defaultTerm(product.licenceModel);
  assertSeats(metric, input.quantity);
  const [row] = await ctx.tx.insert(licences).values({ ...toLicenceRow(input), metric, term, customerId: input.customerId, productId: input.productId, name: input.name } as typeof licences.$inferInsert).returning();
  await ctx.audit({ entityType: 'software_licence', entityId: row!.id, entityLabel: row!.name, action: 'create', customerId: input.customerId, metadata: { productId: product.id, title: titleOf(product), quantity: input.quantity, metric, term } });
  return getLicence(ctx, row!.id);
}

export async function updateLicence(ctx: Ctx, id: string, patch: LicencePatch) {
  const before = await loadLicence(ctx, id);
  ctx.require('software:manage', before.customerId);
  if (patch.productId !== undefined && patch.productId !== before.productId) await loadProduct(ctx, patch.productId);
  if (patch.contractId !== undefined) await assertContract(ctx, before.customerId, patch.contractId);
  const merged = { startDate: patch.startDate === undefined ? before.startDate : patch.startDate, endDate: patch.endDate === undefined ? before.endDate : patch.endDate, metric: patch.metric ?? before.metric, quantity: patch.quantity ?? Number(before.quantity) };
  if (!endAfterStart(merged)) throw new ValidationError(DATES_IN_ORDER);
  assertSeats(merged.metric, merged.quantity);
  const values = toLicenceRow(patch);
  // A changed term starts the notification milestones afresh, so the daily job notifies again for the new end date.
  if (merged.startDate !== before.startDate || merged.endDate !== before.endDate) await ctx.tx.delete(softwareNotifications).where(and(eq(softwareNotifications.scopeType, 'licence'), eq(softwareNotifications.scopeId, id)));
  const [after] = await ctx.tx.update(licences).set({ ...values, updatedAt: new Date() } as never).where(eq(licences.id, id)).returning();
  const changes = diffChanges(before as Record<string, unknown>, values as Record<string, unknown>);
  if (Object.keys(changes).length) await ctx.audit({ entityType: 'software_licence', entityId: id, entityLabel: after!.name, action: 'update', customerId: before.customerId, changes });
  return getLicence(ctx, id);
}

export async function deleteLicence(ctx: Ctx, id: string) {
  const l = await loadLicence(ctx, id);
  ctx.require('software:manage', l.customerId);
  await ctx.tx.delete(softwareNotifications).where(and(eq(softwareNotifications.scopeType, 'licence'), eq(softwareNotifications.scopeId, id)));
  await ctx.tx.update(licences).set({ successorId: null, renewedAt: null, updatedAt: new Date() }).where(eq(licences.successorId, id));
  // The proof of purchase goes with the licence: the attachment rows and their stored files (the same order deleteAttachment uses).
  const files = await ctx.tx.delete(schema.attachments).where(and(eq(schema.attachments.entityType, 'software_licence'), eq(schema.attachments.entityId, id))).returning({ storageKey: schema.attachments.storageKey });
  for (const f of files) await storage.delete(f.storageKey).catch(() => undefined);
  await ctx.tx.delete(licences).where(eq(licences.id, id));
  await ctx.audit({ entityType: 'software_licence', entityId: id, entityLabel: l.name, action: 'delete', customerId: l.customerId, metadata: { attachmentsRemoved: files.length } });
  return { deleted: true };
}

/**
 * Records the next term as a new licence linked from this one. The licence
 * being renewed stays active with `successorId` set: it keeps counting towards
 * the entitlement until its own end date, so there is no unlicensed gap
 * between recording the renewal and the new term starting.
 */
export async function renewLicence(ctx: Ctx, id: string, input: RenewBody) {
  const old = await loadLicence(ctx, id);
  ctx.require('software:manage', old.customerId);
  if (old.successorId) throw new ConflictError('This licence has already been renewed');
  const today = todayStr();
  const startDate = input.startDate ?? (old.endDate ? addDays(old.endDate, 1) : today);
  const endDate = input.endDate ?? addDays(startDate, 365);
  if (!endAfterStart({ startDate, endDate })) throw new ValidationError(DATES_IN_ORDER);
  // Both terms would count towards the entitlement while they overlap; an early renewal shortens the current term first.
  if (old.endDate && startDate <= old.endDate) throw new ValidationError('The next term must start after this licence ends; shorten its end date first for an early renewal');
  const quantity = input.quantity ?? Number(old.quantity);
  assertSeats(old.metric, quantity);
  const now = new Date();
  const [created] = await ctx.tx
    .insert(licences)
    .values({
      customerId: old.customerId, productId: old.productId, contractId: old.contractId, name: input.name?.trim() || old.name, metric: old.metric, term: old.term, quantity: String(quantity),
      startDate, endDate, renewalDate: input.renewalDate ?? null, autoRenew: old.autoRenew, cost: input.cost === undefined ? old.cost : input.cost === null ? null : String(input.cost), currency: old.currency, vendor: old.vendor,
      poNumber: null, invoiceNumber: null, licenceKey: null, ownerUserId: old.ownerUserId, notes: null, isActive: true,
    })
    .returning();
  await ctx.tx.update(licences).set({ successorId: created!.id, renewedAt: now, updatedAt: now }).where(eq(licences.id, id));
  await ctx.audit({ entityType: 'software_licence', entityId: id, entityLabel: old.name, action: 'renew', customerId: old.customerId, changes: { successorId: { old: null, new: created!.id } }, metadata: { successorId: created!.id, startDate, endDate } });
  await ctx.audit({ entityType: 'software_licence', entityId: created!.id, entityLabel: created!.name, action: 'create', customerId: old.customerId, metadata: { predecessorId: id, renewal: true, quantity, startDate, endDate } });
  return getLicence(ctx, created!.id);
}

// ---------------------------------------------------------------- compliance list and renewals

export async function listCompliance(ctx: Ctx, q: ComplianceQuery) {
  ctx.require('software:read', q.customerId ?? null);
  if (q.customerId) ctx.requireCustomer(q.customerId);
  const settings = await loadSoftwareSettings(ctx.tx);
  const horizon = addDays(todayStr(), Math.max(0, ...settings.noticeDays));
  let rows = await complianceFor(ctx, { customerId: q.customerId, productId: q.productId });
  if (q.position) rows = rows.filter((r) => r.position === q.position);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.expiringOnly) rows = rows.filter((r) => r.nextEndDate !== null && r.nextEndDate <= horizon);
  if (q.q) {
    const needle = q.q.trim().toLowerCase();
    rows = rows.filter((r) => `${r.publisher} ${r.name} ${r.versionFamily ?? ''} ${r.customerName}`.toLowerCase().includes(needle));
  }
  const totals = { compliant: 0, under_deployed: 0, over_deployed: 0, unlicensed: 0, unlimited: 0, expiring: 0 };
  for (const r of rows) {
    totals[r.position]++;
    if (r.nextEndDate && r.nextEndDate <= horizon) totals.expiring++;
  }
  const start = (q.page - 1) * q.pageSize;
  return { items: rows.slice(start, start + q.pageSize), total: rows.length, page: q.page, pageSize: q.pageSize, totals, horizonDays: Math.max(0, ...settings.noticeDays) };
}

/** Licences ending or renewing within `days` (expired first, then the sooner of end and renewal date); renewed licences never appear. */
export async function listRenewals(ctx: Ctx, q: RenewalsQuery) {
  ctx.require('software:read', q.customerId ?? null);
  const settings = await loadSoftwareSettings(ctx.tx);
  const today = todayStr();
  const until = addDays(today, q.days);
  const conds: SQL[] = [eq(licences.isActive, true), isNull(licences.successorId)];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(licences.customerId, q.customerId));
  }
  const expired = sql`${licences.endDate} < ${today}::date`;
  const soon = or(and(isNotNull(licences.endDate), lte(licences.endDate, until)), and(isNotNull(licences.renewalDate), lte(licences.renewalDate, until)))!;
  if (q.status === 'expired') conds.push(expired);
  else if (q.status === 'expiring') conds.push(and(soon, or(isNull(licences.endDate), gte(licences.endDate, today)))!);
  else conds.push(soon);
  const sooner = sql`least(coalesce(${licences.endDate}, ${licences.renewalDate}), coalesce(${licences.renewalDate}, ${licences.endDate}))`;
  const rows = await ctx.tx
    .select({ ...licenceColumns(), productPublisher: products.publisher, productName: products.name, versionFamily: products.versionFamily, customerName: customers.name, contractNumber: contracts.number })
    .from(licences)
    .innerJoin(products, eq(products.id, licences.productId))
    .leftJoin(customers, eq(customers.id, licences.customerId))
    .leftJoin(contracts, eq(contracts.id, licences.contractId))
    .where(and(...conds))
    .orderBy(sql`(${licences.endDate} < ${today}::date) DESC`, asc(sooner), asc(licences.name))
    .limit(q.limit);
  const positions = rows.length ? await complianceFor(ctx, { customerId: q.customerId }) : [];
  const posOf = new Map(positions.map((p) => [`${p.customerId}:${p.productId}`, p]));
  const items = rows.map((l) => ({ ...decorateLicence(l, settings.noticeDays, today), installed: posOf.get(`${l.customerId}:${l.productId}`)?.installed ?? 0 }));
  return { items, days: q.days, status: q.status, expired: items.filter((i) => i.status === 'expired').length };
}

// ---------------------------------------------------------------- export

export const EXPORT_COLUMNS = ['customer', 'publisher', 'product', 'versionFamily', 'version', 'edition', 'host', 'ci', 'assetTag', 'user', 'cores', 'source', 'installedAt', 'lastSeenAt', 'notes'] as const;

export async function exportInstallations(ctx: Ctx, q: InstallationListQuery) {
  const out: Record<string, unknown>[] = [];
  for (let p = 1; p <= 40; p++) {
    const res = await listInstallations(ctx, { ...q, page: p, pageSize: 500 });
    for (const i of res.items) {
      out.push({ customer: i.customerName, publisher: i.productPublisher, product: i.productName, versionFamily: i.versionFamily, version: i.version, edition: i.edition, host: i.ciName ?? i.assetTag ?? i.hostName, ci: i.ciName, assetTag: i.assetTag, user: i.assignedUser, cores: i.cores, source: i.source, installedAt: i.installedAt, lastSeenAt: i.lastSeenAt ? i.lastSeenAt.toISOString() : '', notes: i.notes });
    }
    if (res.items.length < 500) break;
  }
  return out;
}

// ---------------------------------------------------------------- notification milestones (used by the daily job)

export interface MilestoneRef { customerId: string; scopeType: 'licence' | 'product'; scopeId: string; milestone: string }

/** Records a milestone exactly once; true when this call created it (the caller sends the notification). */
export async function claimSoftwareMilestone(tx: Tx, ref: MilestoneRef): Promise<boolean> {
  const rows = await tx.insert(softwareNotifications).values(ref).onConflictDoNothing().returning({ id: softwareNotifications.id });
  return rows.length > 0;
}

/** Forgets a milestone so a relapse notifies again. */
export async function clearSoftwareMilestone(tx: Tx, ref: Omit<MilestoneRef, 'customerId'>) {
  await tx.delete(softwareNotifications).where(and(eq(softwareNotifications.scopeType, ref.scopeType), eq(softwareNotifications.scopeId, ref.scopeId), eq(softwareNotifications.milestone, ref.milestone)));
}
