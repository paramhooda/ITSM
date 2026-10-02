import { and, asc, desc, eq, ilike, inArray, isNull, isNotNull, notInArray, or, sql, lte, gte, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { ASSET_LIFECYCLE } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema, withSystem } from '@/db/client';
import { ConflictError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { searchFts, orderBy, limitOffset } from '@/core/query';
import { parseCsv, headerIndex, rowValue, CSV_LIMITS } from './csv';
import type { AssetCreateInput, AssetListQuery, AssetPatchInput } from './schemas';
import { ASSET_IMPORT_COLUMNS } from './schemas';

const { assets, customers, sites, configOptions, cis, ciTypes, tickets, ticketAssets, fieldVisitParts, fieldVisits, contracts, contacts } = schema;

// ---------------------------------------------------------------- helpers

export type CoverageStatus = { status: 'none' | 'active' | 'expiring' | 'expired'; days: number | null; end: string | null };

/** Warranty / AMC coverage status relative to today (expiring = within `window` days). */
export function coverageStatus(end: string | null | undefined, window = 90, today = new Date()): CoverageStatus {
  if (!end) return { status: 'none', days: null, end: null };
  const endDate = new Date(end + 'T00:00:00Z');
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.round((endDate.getTime() - t) / 86_400_000);
  if (days < 0) return { status: 'expired', days, end };
  if (days <= window) return { status: 'expiring', days, end };
  return { status: 'active', days, end };
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function loadAsset(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (!row) throw new NotFoundError('Asset');
  ctx.requireCustomer(row.customerId);
  return row;
}

async function assertSite(ctx: Ctx, customerId: string, siteId?: string | null) {
  if (!siteId) return;
  const [s] = await ctx.tx.select({ id: sites.id }).from(sites).where(and(eq(sites.id, siteId), eq(sites.customerId, customerId))).limit(1);
  if (!s) throw new ValidationError('Site does not belong to this customer');
}

async function assertOption(ctx: Ctx, type: string, id?: string | null) {
  if (!id) return;
  const [o] = await ctx.tx.select({ id: configOptions.id }).from(configOptions).where(and(eq(configOptions.id, id), eq(configOptions.type, type))).limit(1);
  if (!o) throw new ValidationError(`Invalid ${type.replace('_', ' ')}`);
}

async function assertContract(ctx: Ctx, customerId: string, contractId?: string | null) {
  if (!contractId) return;
  const [c] = await ctx.tx.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.customerId, customerId))).limit(1);
  if (!c) throw new ValidationError('AMC contract does not belong to this customer');
}

/**
 * Next platform-wide tag `AST-000123`. Serialised with a transaction-scoped
 * advisory lock; the max is read with system scope so tenant-limited users
 * still get a globally unique number.
 */
export async function nextAssetTag(ctx: Ctx): Promise<string> {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext('asset_tag_seq'))`);
  const max = await withSystem(async (tx) => {
    const res = await tx.execute(sql`select coalesce(max((substring(tag from '^AST-(\\d+)$'))::int), 0)::int as n from assets where tag ~ '^AST-\\d+$'`);
    return (res.rows[0] as { n: number }).n;
  });
  return `AST-${String(max + 1).padStart(6, '0')}`;
}

// ---------------------------------------------------------------- list

const category = alias(configOptions, 'asset_category');
const status = alias(configOptions, 'asset_status');

export async function listAssets(ctx: Ctx, q: AssetListQuery) {
  return q.fields === 'min' ? listAssetsMin(ctx, q) : listAssetsFull(ctx, q);
}

function buildAssetWhere(ctx: Ctx, q: AssetListQuery) {
  const conds: (SQL | undefined)[] = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(assets.customerId, q.customerId));
  }
  if (q.siteId) conds.push(eq(assets.siteId, q.siteId));
  if (q.categoryId) conds.push(eq(assets.categoryId, q.categoryId));
  if (q.statusId) conds.push(eq(assets.statusId, q.statusId));
  if (q.lifecycleStage) conds.push(eq(assets.lifecycleStage, q.lifecycleStage));
  if (q.manufacturer) conds.push(ilike(assets.manufacturer, `%${q.manufacturer}%`));
  if (q.tag) conds.push(ilike(assets.tag, `%${q.tag}%`));
  if (q.amcContractId) conds.push(eq(assets.amcContractId, q.amcContractId));
  if (q.hasCi === true) conds.push(isNotNull(assets.ciId));
  if (q.hasCi === false) conds.push(isNull(assets.ciId));
  if (q.warrantyExpiringDays !== undefined) conds.push(and(isNotNull(assets.warrantyEnd), gte(assets.warrantyEnd, todayStr()), lte(assets.warrantyEnd, addDays(q.warrantyExpiringDays))));
  if (q.amcExpiringDays !== undefined) conds.push(and(isNotNull(assets.amcEnd), gte(assets.amcEnd, todayStr()), lte(assets.amcEnd, addDays(q.amcExpiringDays))));
  if (q.expired === 'warranty') conds.push(sql`${assets.warrantyEnd} < ${todayStr()}::date`);
  if (q.expired === 'amc') conds.push(sql`${assets.amcEnd} < ${todayStr()}::date`);
  if (q.expired === 'any') conds.push(or(sql`${assets.warrantyEnd} < ${todayStr()}::date`, sql`${assets.amcEnd} < ${todayStr()}::date`));
  if (q.q) conds.push(searchFts(q.q, assets.searchVector, assets.tag, assets.serialNumber, assets.name));
  const where = and(...conds.filter((c): c is SQL => !!c));
  const sortable = { tag: assets.tag, name: assets.name, warrantyEnd: assets.warrantyEnd, amcEnd: assets.amcEnd, createdAt: assets.createdAt, updatedAt: assets.updatedAt, customer: customers.name };
  const order = orderBy(sortable, q.sort, q.order ?? (q.sort ? 'asc' : 'desc'), assets.createdAt);
  return { where, order, ...limitOffset(q) };
}

async function countAssets(ctx: Ctx, where: SQL | undefined) {
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(assets).leftJoin(customers, eq(customers.id, assets.customerId)).where(where);
  return count;
}

/** Compact rows for pickers. */
export async function listAssetsMin(ctx: Ctx, q: AssetListQuery) {
  const { where, order, limit, offset } = buildAssetWhere(ctx, q);
  const count = await countAssets(ctx, where);
  const items = await ctx.tx
    .select({ id: assets.id, tag: assets.tag, name: assets.name, serialNumber: assets.serialNumber, customerId: assets.customerId })
    .from(assets)
    .leftJoin(customers, eq(customers.id, assets.customerId))
    .where(where)
    .orderBy(order)
    .limit(limit)
    .offset(offset);
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

export async function listAssetsFull(ctx: Ctx, q: AssetListQuery) {
  const { where, order, limit, offset } = buildAssetWhere(ctx, q);
  const count = await countAssets(ctx, where);
  const items = await ctx.tx
    .select({
      id: assets.id,
      customerId: assets.customerId,
      customerName: customers.name,
      siteId: assets.siteId,
      siteName: sites.name,
      tag: assets.tag,
      name: assets.name,
      categoryId: assets.categoryId,
      categoryLabel: category.label,
      statusId: assets.statusId,
      statusLabel: status.label,
      statusColor: status.color,
      lifecycleStage: assets.lifecycleStage,
      manufacturer: assets.manufacturer,
      model: assets.model,
      serialNumber: assets.serialNumber,
      location: assets.location,
      warrantyEnd: assets.warrantyEnd,
      amcEnd: assets.amcEnd,
      amcContractId: assets.amcContractId,
      ciId: assets.ciId,
      ciName: cis.name,
      tags: assets.tags,
      createdAt: assets.createdAt,
      updatedAt: assets.updatedAt,
    })
    .from(assets)
    .leftJoin(customers, eq(customers.id, assets.customerId))
    .leftJoin(sites, eq(sites.id, assets.siteId))
    .leftJoin(category, eq(category.id, assets.categoryId))
    .leftJoin(status, eq(status.id, assets.statusId))
    .leftJoin(cis, eq(cis.id, assets.ciId))
    .where(where)
    .orderBy(order)
    .limit(limit)
    .offset(offset);
  return {
    items: items.map((a) => ({ ...a, warranty: coverageStatus(a.warrantyEnd), amc: coverageStatus(a.amcEnd) })),
    total: count,
    page: q.page,
    pageSize: q.pageSize,
  };
}

// ---------------------------------------------------------------- get

const OPEN_CATEGORIES = ['new', 'open', 'pending'] as const;

export async function getAsset(ctx: Ctx, id: string) {
  const a = await loadAsset(ctx, id);
  const ownerContact = alias(contacts, 'owner_contact');
  const assignedContact = alias(contacts, 'assigned_contact');
  const [meta] = await ctx.tx
    .select({
      customerName: customers.name,
      customerCode: customers.code,
      siteName: sites.name,
      categoryLabel: category.label,
      categoryKey: category.key,
      statusLabel: status.label,
      statusColor: status.color,
      statusKey: status.key,
      ownerContactName: ownerContact.name,
      assignedContactName: assignedContact.name,
    })
    .from(assets)
    .leftJoin(customers, eq(customers.id, assets.customerId))
    .leftJoin(sites, eq(sites.id, assets.siteId))
    .leftJoin(category, eq(category.id, assets.categoryId))
    .leftJoin(status, eq(status.id, assets.statusId))
    .leftJoin(ownerContact, eq(ownerContact.id, assets.ownerContactId))
    .leftJoin(assignedContact, eq(assignedContact.id, assets.assignedContactId))
    .where(eq(assets.id, id))
    .limit(1);

  const [ci] = a.ciId
    ? await ctx.tx
        .select({ id: cis.id, name: cis.name, hostname: cis.hostname, ipAddress: cis.ipAddress, status: cis.status, typeKey: ciTypes.key, typeName: ciTypes.name, typeColor: ciTypes.color, lastSeenAt: cis.lastSeenAt })
        .from(cis)
        .innerJoin(ciTypes, eq(ciTypes.id, cis.typeId))
        .where(eq(cis.id, a.ciId))
        .limit(1)
    : [];

  const [amcContract] = a.amcContractId
    ? await ctx.tx.select({ id: contracts.id, number: contracts.number, name: contracts.name, status: contracts.status, startDate: contracts.startDate, endDate: contracts.endDate }).from(contracts).where(eq(contracts.id, a.amcContractId)).limit(1)
    : [];

  const ticketStatus = alias(configOptions, 'ticket_status');
  const linkedIds = ctx.tx.select({ id: ticketAssets.ticketId }).from(ticketAssets).where(eq(ticketAssets.assetId, id));
  const openTickets = await ctx.tx
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, type: tickets.type, status: ticketStatus.label, statusColor: ticketStatus.color, statusCategory: ticketStatus.statusCategory, createdAt: tickets.createdAt })
    .from(tickets)
    .innerJoin(ticketStatus, eq(ticketStatus.id, tickets.statusId))
    .where(and(or(eq(tickets.primaryAssetId, id), inArray(tickets.id, linkedIds)), inArray(ticketStatus.statusCategory, [...OPEN_CATEGORIES])))
    .orderBy(desc(tickets.createdAt))
    .limit(50);

  const visitParts = await ctx.tx
    .select({ id: fieldVisitParts.id, visitId: fieldVisitParts.visitId, visitNumber: fieldVisits.number, visitTitle: fieldVisits.title, visitStatus: fieldVisits.status, name: fieldVisitParts.name, partNumber: fieldVisitParts.partNumber, serialNumber: fieldVisitParts.serialNumber, quantity: fieldVisitParts.quantity, createdAt: fieldVisitParts.createdAt })
    .from(fieldVisitParts)
    .innerJoin(fieldVisits, eq(fieldVisits.id, fieldVisitParts.visitId))
    .where(eq(fieldVisitParts.assetId, id))
    .orderBy(desc(fieldVisitParts.createdAt))
    .limit(50);

  return {
    ...a,
    ...meta,
    warranty: coverageStatus(a.warrantyEnd),
    amc: coverageStatus(a.amcEnd ?? amcContract?.endDate ?? null),
    eol: coverageStatus(a.eolDate, 180),
    ci: ci ?? null,
    amcContract: amcContract ?? null,
    openTickets,
    visitParts,
  };
}

// ---------------------------------------------------------------- create / update / delete

function toRow(input: Partial<AssetCreateInput>) {
  const { purchaseCost, ...rest } = input;
  return { ...rest, ...(purchaseCost !== undefined ? { purchaseCost: purchaseCost === null ? null : String(purchaseCost) } : {}) };
}

async function validateRefs(ctx: Ctx, customerId: string, input: Partial<AssetCreateInput>) {
  if (input.siteId !== undefined) await assertSite(ctx, customerId, input.siteId);
  if (input.categoryId !== undefined) await assertOption(ctx, 'asset_category', input.categoryId);
  if (input.statusId !== undefined) await assertOption(ctx, 'asset_status', input.statusId);
  if (input.amcContractId !== undefined) await assertContract(ctx, customerId, input.amcContractId);
  if (input.ciId) {
    const [c] = await ctx.tx.select({ id: cis.id }).from(cis).where(and(eq(cis.id, input.ciId), eq(cis.customerId, customerId))).limit(1);
    if (!c) throw new ValidationError('CI does not belong to this customer');
  }
}

export async function createAsset(ctx: Ctx, input: AssetCreateInput) {
  ctx.requireCustomer(input.customerId);
  ctx.require('assets:manage', input.customerId);
  await validateRefs(ctx, input.customerId, input);
  const tag = input.tag?.trim() || (await nextAssetTag(ctx));
  const [dup] = await ctx.tx.select({ id: assets.id }).from(assets).where(and(eq(assets.customerId, input.customerId), eq(assets.tag, tag))).limit(1);
  if (dup) throw new ConflictError(`Asset tag ${tag} already exists for this customer`);
  if (!input.statusId) {
    const [def] = await ctx.tx.select({ id: configOptions.id }).from(configOptions).where(and(eq(configOptions.type, 'asset_status'), eq(configOptions.isDefault, true), eq(configOptions.isActive, true))).limit(1);
    if (def) input.statusId = def.id;
  }
  const [row] = await ctx.tx.insert(assets).values({ ...toRow(input), customerId: input.customerId, tag, name: input.name } as typeof assets.$inferInsert).returning();
  if (input.ciId) await ctx.tx.update(cis).set({ assetId: row.id, updatedAt: new Date() }).where(eq(cis.id, input.ciId));
  await ctx.audit({ entityType: 'asset', entityId: row.id, entityLabel: row.tag, action: 'create', customerId: row.customerId, metadata: { name: row.name } });
  return getAsset(ctx, row.id);
}

export async function updateAsset(ctx: Ctx, id: string, patch: AssetPatchInput) {
  const before = await loadAsset(ctx, id);
  ctx.require('assets:manage', before.customerId);
  await validateRefs(ctx, before.customerId, patch);
  if (patch.tag && patch.tag !== before.tag) {
    const [dup] = await ctx.tx.select({ id: assets.id }).from(assets).where(and(eq(assets.customerId, before.customerId), eq(assets.tag, patch.tag), sql`${assets.id} <> ${id}`)).limit(1);
    if (dup) throw new ConflictError(`Asset tag ${patch.tag} already exists for this customer`);
  }
  const row = toRow(patch);
  const [after] = await ctx.tx.update(assets).set({ ...(row as object), updatedAt: new Date() } as never).where(eq(assets.id, id)).returning();
  if (patch.ciId !== undefined && patch.ciId !== before.ciId) {
    if (before.ciId) await ctx.tx.update(cis).set({ assetId: null }).where(and(eq(cis.id, before.ciId), eq(cis.assetId, id)));
    if (patch.ciId) await ctx.tx.update(cis).set({ assetId: id, updatedAt: new Date() }).where(eq(cis.id, patch.ciId));
  }
  const changes = diffChanges(before as Record<string, unknown>, row as Record<string, unknown>);
  if (Object.keys(changes).length) await ctx.audit({ entityType: 'asset', entityId: id, entityLabel: after.tag, action: 'update', customerId: after.customerId, changes });
  return getAsset(ctx, id);
}

export async function deleteAsset(ctx: Ctx, id: string) {
  const a = await loadAsset(ctx, id);
  ctx.require('assets:manage', a.customerId);
  const [{ count }] = await ctx.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(tickets)
    .where(or(eq(tickets.primaryAssetId, id), inArray(tickets.id, ctx.tx.select({ id: ticketAssets.ticketId }).from(ticketAssets).where(eq(ticketAssets.assetId, id)))));
  if (count > 0) throw new ConflictError(`Asset is referenced by ${count} ticket(s). Retire it via the lifecycle instead of deleting.`);
  if (a.ciId) await ctx.tx.update(cis).set({ assetId: null }).where(and(eq(cis.id, a.ciId), eq(cis.assetId, id)));
  await ctx.tx.delete(assets).where(eq(assets.id, id));
  await ctx.audit({ entityType: 'asset', entityId: id, entityLabel: a.tag, action: 'delete', customerId: a.customerId });
  return { deleted: true };
}

// ---------------------------------------------------------------- CI linking

export async function linkCi(ctx: Ctx, id: string, ciId: string) {
  const a = await loadAsset(ctx, id);
  ctx.require('assets:manage', a.customerId);
  const [ci] = await ctx.tx.select({ id: cis.id, name: cis.name, assetId: cis.assetId, customerId: cis.customerId }).from(cis).where(eq(cis.id, ciId)).limit(1);
  if (!ci || ci.customerId !== a.customerId) throw new ValidationError('CI not found for this customer');
  if (ci.assetId && ci.assetId !== id) throw new ConflictError('That CI is already linked to another asset');
  if (a.ciId && a.ciId !== ciId) await ctx.tx.update(cis).set({ assetId: null }).where(and(eq(cis.id, a.ciId), eq(cis.assetId, id)));
  await ctx.tx.update(assets).set({ ciId, updatedAt: new Date() }).where(eq(assets.id, id));
  await ctx.tx.update(cis).set({ assetId: id, updatedAt: new Date() }).where(eq(cis.id, ciId));
  await ctx.audit({ entityType: 'asset', entityId: id, entityLabel: a.tag, action: 'link_ci', customerId: a.customerId, changes: { ciId: { old: a.ciId, new: ciId } }, metadata: { ciName: ci.name } });
  await ctx.audit({ entityType: 'ci', entityId: ciId, entityLabel: ci.name, action: 'link_asset', customerId: a.customerId, changes: { assetId: { old: ci.assetId, new: id } }, metadata: { assetTag: a.tag } });
  return getAsset(ctx, id);
}

export async function unlinkCi(ctx: Ctx, id: string) {
  const a = await loadAsset(ctx, id);
  ctx.require('assets:manage', a.customerId);
  if (!a.ciId) return getAsset(ctx, id);
  await ctx.tx.update(cis).set({ assetId: null, updatedAt: new Date() }).where(and(eq(cis.id, a.ciId), eq(cis.assetId, id)));
  await ctx.tx.update(assets).set({ ciId: null, updatedAt: new Date() }).where(eq(assets.id, id));
  await ctx.audit({ entityType: 'asset', entityId: id, entityLabel: a.tag, action: 'unlink_ci', customerId: a.customerId, changes: { ciId: { old: a.ciId, new: null } } });
  await ctx.audit({ entityType: 'ci', entityId: a.ciId, action: 'unlink_asset', customerId: a.customerId, changes: { assetId: { old: id, new: null } } });
  return getAsset(ctx, id);
}

export async function createCiFromAsset(ctx: Ctx, id: string, typeId: string) {
  const a = await loadAsset(ctx, id);
  ctx.require('assets:manage', a.customerId);
  ctx.require('cmdb:manage', a.customerId);
  if (a.ciId) throw new ConflictError('Asset is already linked to a CI');
  const { createCi } = await import('@/modules/cmdb/service');
  const ci = await createCi(ctx, {
    customerId: a.customerId,
    siteId: a.siteId,
    typeId,
    name: a.name,
    serialNumber: a.serialNumber,
    manufacturer: a.manufacturer,
    model: a.model,
    status: a.lifecycleStage === 'deployed' ? 'active' : a.lifecycleStage === 'retired' || a.lifecycleStage === 'disposed' ? 'retired' : 'planned',
    assetId: id,
    description: a.description,
    tags: a.tags,
    attributes: {},
  });
  await ctx.tx.update(assets).set({ ciId: ci.id, updatedAt: new Date() }).where(eq(assets.id, id));
  await ctx.audit({ entityType: 'asset', entityId: id, entityLabel: a.tag, action: 'link_ci', customerId: a.customerId, changes: { ciId: { old: null, new: ci.id } }, metadata: { createdFromAsset: true } });
  return getAsset(ctx, id);
}

// ---------------------------------------------------------------- lifecycle

/** Allowed transitions; anything can go to retired, retired -> disposed only. */
const TRANSITIONS: Record<string, string[]> = {
  ordered: ['in_stock', 'deployed', 'retired'],
  in_stock: ['deployed', 'in_repair', 'retired'],
  deployed: ['in_repair', 'in_stock', 'retired'],
  in_repair: ['deployed', 'in_stock', 'retired'],
  retired: ['disposed', 'in_stock'],
  disposed: [],
};

export function allowedLifecycleTransitions(stage: string) {
  return TRANSITIONS[stage] ?? [...ASSET_LIFECYCLE];
}

export async function changeLifecycle(ctx: Ctx, id: string, stage: (typeof ASSET_LIFECYCLE)[number], notes?: string) {
  const a = await loadAsset(ctx, id);
  ctx.require('assets:manage', a.customerId);
  if (a.lifecycleStage === stage) return getAsset(ctx, id);
  if (!allowedLifecycleTransitions(a.lifecycleStage).includes(stage)) throw new ValidationError(`Cannot move an asset from ${a.lifecycleStage} to ${stage}`);
  // Keep the configurable status in step where a matching key exists.
  const statusKey = { deployed: 'in_use', in_stock: 'in_stock', in_repair: 'under_repair', retired: 'retired', disposed: 'disposed', ordered: 'in_stock' }[stage];
  const [opt] = statusKey ? await ctx.tx.select({ id: configOptions.id }).from(configOptions).where(and(eq(configOptions.type, 'asset_status'), eq(configOptions.key, statusKey))).limit(1) : [];
  await ctx.tx
    .update(assets)
    .set({ lifecycleStage: stage, ...(opt ? { statusId: opt.id } : {}), updatedAt: new Date() })
    .where(eq(assets.id, id));
  await ctx.audit({ entityType: 'asset', entityId: id, entityLabel: a.tag, action: 'lifecycle', customerId: a.customerId, changes: { lifecycleStage: { old: a.lifecycleStage, new: stage } }, metadata: { notes: notes ?? null } });
  return getAsset(ctx, id);
}

// ---------------------------------------------------------------- expiring / summary / export

export async function expiringAssets(ctx: Ctx, q: { days: number; kind: 'warranty' | 'amc'; customerId?: string; limit: number }) {
  const col = q.kind === 'warranty' ? assets.warrantyEnd : assets.amcEnd;
  const conds = [isNotNull(col), lte(col, addDays(q.days)), notInArray(assets.lifecycleStage, ['retired', 'disposed'])];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(assets.customerId, q.customerId));
  }
  const rows = await ctx.tx
    .select({ id: assets.id, tag: assets.tag, name: assets.name, customerId: assets.customerId, customerName: customers.name, siteName: sites.name, model: assets.model, serialNumber: assets.serialNumber, warrantyEnd: assets.warrantyEnd, amcEnd: assets.amcEnd, lifecycleStage: assets.lifecycleStage })
    .from(assets)
    .leftJoin(customers, eq(customers.id, assets.customerId))
    .leftJoin(sites, eq(sites.id, assets.siteId))
    .where(and(...conds))
    .orderBy(asc(col))
    .limit(q.limit);
  return { items: rows.map((r) => ({ ...r, coverage: coverageStatus(q.kind === 'warranty' ? r.warrantyEnd : r.amcEnd, q.days) })), kind: q.kind, days: q.days };
}

export async function assetSummary(ctx: Ctx, customerId?: string) {
  const conds: SQL[] = [];
  if (customerId) {
    ctx.requireCustomer(customerId);
    conds.push(eq(assets.customerId, customerId));
  }
  const where = conds.length ? and(...conds) : undefined;
  const active = notInArray(assets.lifecycleStage, ['retired', 'disposed']);
  const [byCategory, byStatus, byLifecycle, [totals]] = await Promise.all([
    ctx.tx.select({ id: assets.categoryId, label: category.label, count: sql<number>`count(*)::int` }).from(assets).leftJoin(category, eq(category.id, assets.categoryId)).where(where).groupBy(assets.categoryId, category.label).orderBy(desc(sql`count(*)`)),
    ctx.tx.select({ id: assets.statusId, label: status.label, color: status.color, count: sql<number>`count(*)::int` }).from(assets).leftJoin(status, eq(status.id, assets.statusId)).where(where).groupBy(assets.statusId, status.label, status.color).orderBy(desc(sql`count(*)`)),
    ctx.tx.select({ stage: assets.lifecycleStage, count: sql<number>`count(*)::int` }).from(assets).where(where).groupBy(assets.lifecycleStage),
    ctx.tx
      .select({
        total: sql<number>`count(*)::int`,
        warrantyExpiring90: sql<number>`count(*) filter (where ${assets.warrantyEnd} between ${todayStr()} and ${addDays(90)} and ${active})::int`,
        warrantyExpired: sql<number>`count(*) filter (where ${assets.warrantyEnd} < ${todayStr()} and ${active})::int`,
        amcExpiring90: sql<number>`count(*) filter (where ${assets.amcEnd} between ${todayStr()} and ${addDays(90)} and ${active})::int`,
        amcExpired: sql<number>`count(*) filter (where ${assets.amcEnd} < ${todayStr()} and ${active})::int`,
        inRepair: sql<number>`count(*) filter (where ${assets.lifecycleStage} = 'in_repair')::int`,
        withCi: sql<number>`count(*) filter (where ${assets.ciId} is not null)::int`,
      })
      .from(assets)
      .where(where),
  ]);
  return { ...totals, byCategory, byStatus, byLifecycle };
}

export const EXPORT_COLUMNS = ['tag', 'name', 'customer', 'site', 'category', 'status', 'lifecycleStage', 'manufacturer', 'model', 'serialNumber', 'partNumber', 'location', 'rackPosition', 'vendor', 'purchaseDate', 'purchaseCost', 'currency', 'poNumber', 'invoiceNumber', 'warrantyStart', 'warrantyEnd', 'warrantyProvider', 'amcContract', 'amcStart', 'amcEnd', 'eolDate', 'eosDate', 'ci', 'notes', 'tags'] as const;

export async function exportAssets(ctx: Ctx, q: AssetListQuery) {
  const page = { ...q, page: 1, pageSize: 500, fields: 'full' as const };
  const out: Record<string, unknown>[] = [];
  for (let p = 1; p <= 40; p++) {
    const res = await listAssetsFull(ctx, { ...page, page: p });
    const ids = res.items.map((i) => i.id);
    if (!ids.length) break;
    const full = await ctx.tx.select().from(assets).where(inArray(assets.id, ids));
    const contractRows = await ctx.tx.select({ id: contracts.id, number: contracts.number }).from(contracts).where(inArray(contracts.id, full.map((f) => f.amcContractId).filter((x): x is string => !!x)));
    const byId = new Map(full.map((f) => [f.id, f]));
    const cById = new Map(contractRows.map((c) => [c.id, c.number]));
    for (const i of res.items) {
      const f = byId.get(i.id)!;
      out.push({
        tag: i.tag, name: i.name, customer: i.customerName, site: i.siteName, category: i.categoryLabel, status: i.statusLabel, lifecycleStage: i.lifecycleStage,
        manufacturer: f.manufacturer, model: f.model, serialNumber: f.serialNumber, partNumber: f.partNumber, location: f.location, rackPosition: f.rackPosition, vendor: f.vendor,
        purchaseDate: f.purchaseDate, purchaseCost: f.purchaseCost, currency: f.currency, poNumber: f.poNumber, invoiceNumber: f.invoiceNumber,
        warrantyStart: f.warrantyStart, warrantyEnd: f.warrantyEnd, warrantyProvider: f.warrantyProvider, amcContract: f.amcContractId ? cById.get(f.amcContractId) ?? '' : '', amcStart: f.amcStart, amcEnd: f.amcEnd,
        eolDate: f.eolDate, eosDate: f.eosDate, ci: i.ciName, notes: f.notes, tags: (f.tags ?? []).join('|'),
      });
    }
    if (res.items.length < page.pageSize) break;
  }
  return out;
}

// ---------------------------------------------------------------- import

export interface ImportResult { created: number; updated: number; skipped: number; errors: { row: number; message: string }[] }

function parseDate(v?: string): string | null | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  throw new Error(`Unrecognised date "${s}"`);
}

export async function importAssets(ctx: Ctx, customerId: string, csv: Buffer): Promise<ImportResult> {
  ctx.requireCustomer(customerId);
  ctx.require('assets:manage', customerId);
  if (csv.length > CSV_LIMITS.maxBytes) throw new ValidationError('CSV file is too large (max 10 MB)');
  const table = parseCsv(csv, { maxRows: CSV_LIMITS.maxRows });
  if (!table.headers.length) throw new ValidationError('CSV file is empty');
  const idx = headerIndex(table.headers);
  if (!idx('name') && !idx('tag')) throw new ValidationError(`CSV must contain at least a "name" or "tag" column. Expected columns: ${ASSET_IMPORT_COLUMNS.join(', ')}`);

  const [cats, stats, siteRows] = await Promise.all([
    ctx.tx.select({ id: configOptions.id, key: configOptions.key, label: configOptions.label }).from(configOptions).where(eq(configOptions.type, 'asset_category')),
    ctx.tx.select({ id: configOptions.id, key: configOptions.key, label: configOptions.label, isDefault: configOptions.isDefault }).from(configOptions).where(eq(configOptions.type, 'asset_status')),
    ctx.tx.select({ id: sites.id, code: sites.code, name: sites.name }).from(sites).where(eq(sites.customerId, customerId)),
  ]);
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]/g, '');
  const resolve = (list: { id: string; key?: string; code?: string; label?: string; name?: string }[], v?: string) => {
    if (!v) return undefined;
    const n = norm(v);
    return list.find((x) => [x.key, x.code, x.label, x.name].some((c) => c && norm(c) === n))?.id;
  };
  const defaultStatus = stats.find((s) => s.isDefault)?.id;

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    const v = (n: string) => rowValue(row, idx, n);
    const lineNo = i + 2;
    await ctx.tx.execute(sql`savepoint import_row`);
    try {
      const name = v('name');
      let tag = v('tag');
      if (!name && !tag) {
        result.skipped++;
        continue;
      }
      const categoryId = resolve(cats, v('category'));
      if (v('category') && !categoryId) throw new Error(`Unknown category "${v('category')}"`);
      const statusId = resolve(stats, v('status'));
      if (v('status') && !statusId) throw new Error(`Unknown status "${v('status')}"`);
      const siteId = resolve(siteRows, v('site'));
      if (v('site') && !siteId) throw new Error(`Unknown site "${v('site')}"`);
      const cost = v('purchaseCost');
      const purchaseCost = cost ? Number(cost.replace(/[^0-9.\-]/g, '')) : undefined;
      if (purchaseCost !== undefined && isNaN(purchaseCost)) throw new Error(`Invalid purchase cost "${cost}"`);
      const data = {
        name,
        categoryId,
        statusId,
        siteId,
        manufacturer: v('manufacturer'),
        model: v('model'),
        serialNumber: v('serialNumber'),
        purchaseDate: parseDate(v('purchaseDate')),
        purchaseCost: purchaseCost === undefined ? undefined : String(purchaseCost),
        vendor: v('vendor'),
        warrantyStart: parseDate(v('warrantyStart')),
        warrantyEnd: parseDate(v('warrantyEnd')),
        amcStart: parseDate(v('amcStart')),
        amcEnd: parseDate(v('amcEnd')),
        location: v('location'),
        notes: v('notes'),
        lifecycleStage: v('lifecycleStage') && (ASSET_LIFECYCLE as readonly string[]).includes(v('lifecycleStage')!) ? v('lifecycleStage') : undefined,
      };
      const clean = Object.fromEntries(Object.entries(data).filter(([, val]) => val !== undefined));
      const [existing] = tag ? await ctx.tx.select().from(assets).where(and(eq(assets.customerId, customerId), eq(assets.tag, tag))).limit(1) : [];
      if (existing) {
        await ctx.tx.update(assets).set({ ...clean, updatedAt: new Date() } as never).where(eq(assets.id, existing.id));
        const changes = diffChanges(existing as Record<string, unknown>, clean);
        if (Object.keys(changes).length) await ctx.audit({ entityType: 'asset', entityId: existing.id, entityLabel: existing.tag, action: 'import_update', customerId, changes });
        result.updated++;
      } else {
        if (!name) throw new Error('Name is required for new assets');
        tag = tag || (await nextAssetTag(ctx));
        const [created] = await ctx.tx.insert(assets).values({ ...clean, customerId, tag, name, statusId: statusId ?? defaultStatus } as typeof assets.$inferInsert).returning({ id: assets.id });
        await ctx.audit({ entityType: 'asset', entityId: created.id, entityLabel: tag, action: 'import_create', customerId, metadata: { name } });
        result.created++;
      }
      await ctx.tx.execute(sql`release savepoint import_row`);
    } catch (err) {
      await ctx.tx.execute(sql`rollback to savepoint import_row`);
      result.errors.push({ row: lineNo, message: (err as Error).message });
      if (result.errors.length > 200) {
        result.errors.push({ row: lineNo, message: 'Too many errors; import aborted' });
        break;
      }
    }
  }
  await ctx.audit({ entityType: 'asset', action: 'import', customerId, metadata: { created: result.created, updated: result.updated, errors: result.errors.length } });
  return result;
}
