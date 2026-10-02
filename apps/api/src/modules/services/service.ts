import { eq, and, or, ilike, inArray, asc, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DOMAINS } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ConflictError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { optionLabels, userNames, contractStatusOptions, statusDisplay, uuidList, sequential } from '@/modules/contracts/common';
import { COVERING_STATUSES } from '@/modules/contracts/schemas';

const s = schema.services;
const uuid = z.string().uuid();

export const serviceInput = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'Lowercase letters, digits, dash and underscore only').optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(8000).nullable().optional(),
  categoryId: uuid.nullable().optional(),
  /** A `service_subcategory` option; its parent category is applied to `categoryId` automatically. */
  subcategoryId: uuid.nullable().optional(),
  statusId: uuid.nullable().optional(),
  domain: z.enum(DOMAINS).optional(),
  defaultTeamId: uuid.nullable().optional(),
  defaultSlaPolicyId: uuid.nullable().optional(),
  defaultTicketCategoryId: uuid.nullable().optional(),
  ciTypeKeys: z.array(z.string().max(64)).max(100).optional(),
  ownerUserId: uuid.nullable().optional(),
  isActive: z.boolean().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});
export type ServiceInput = z.infer<typeof serviceInput>;

export const serviceListQuery = z.object({
  q: z.string().max(200).optional(),
  categoryId: uuid.optional(),
  subcategoryId: uuid.optional(),
  domain: z.enum(DOMAINS).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
  customerId: uuid.optional(),
});
export type ServiceListQuery = z.infer<typeof serviceListQuery>;

/** Filters for the grouped catalog view: the list filters minus category/subcategory, plus `includeEmpty`. */
export const serviceCatalogQuery = serviceListQuery.pick({ q: true, domain: true, includeInactive: true, customerId: true }).extend({
  /** Also return categories / subcategories that currently hold no service. */
  includeEmpty: z.enum(['true', 'false']).optional(),
});
export type ServiceCatalogQuery = z.infer<typeof serviceCatalogQuery>;

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'service';

async function uniqueKey(tx: Tx, base: string, excludeId?: string) {
  const rows = await tx.select({ id: s.id, key: s.key }).from(s).where(or(eq(s.key, base), ilike(s.key, `${base}_%`)));
  const taken = new Set(rows.filter((r) => r.id !== excludeId).map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now()}`;
}

async function counts(tx: Tx, ids: string[]) {
  const out = new Map<string, { subscribedCustomers: number; activeContracts: number; openTickets: number; incidents30d: number; cis: number }>();
  if (!ids.length) return out;
  const res = await tx.execute(sql`
    select x.id,
      (select count(distinct cs.customer_id) from contract_services cs join contracts c on c.id = cs.contract_id where cs.service_id = x.id and c.status in ('active','expiring'))::int as "subscribedCustomers",
      (select count(*) from contract_services cs join contracts c on c.id = cs.contract_id where cs.service_id = x.id and c.status in ('active','expiring'))::int as "activeContracts",
      (select count(*) from tickets t join config_options o on o.id = t.status_id where t.service_id = x.id and o.status_category in ('new','open','pending'))::int as "openTickets",
      (select count(*) from tickets t where t.service_id = x.id and t.type = 'incident' and t.created_at >= now() - interval '30 days')::int as "incidents30d",
      (select count(*) from ci_services c where c.service_id = x.id)::int as cis
    from services x where x.id in (${uuidList(ids)})`);
  for (const r of res.rows as { id: string; subscribedCustomers: number; activeContracts: number; openTickets: number; incidents30d: number; cis: number }[]) {
    out.set(r.id, { subscribedCustomers: Number(r.subscribedCustomers), activeContracts: Number(r.activeContracts), openTickets: Number(r.openTickets), incidents30d: Number(r.incidents30d), cis: Number(r.cis) });
  }
  return out;
}

async function decorate(tx: Tx, rows: (typeof s.$inferSelect)[]) {
  if (!rows.length) return [];
  const [labels, owners, teams, policies, cnt, ciTypes] = await sequential([
    () => optionLabels(tx, rows.flatMap((r) => [r.categoryId, r.subcategoryId, r.statusId, r.defaultTicketCategoryId])),
    () => userNames(tx, rows.map((r) => r.ownerUserId)),
    () => tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams),
    () => tx.select({ id: schema.slaPolicies.id, name: schema.slaPolicies.name }).from(schema.slaPolicies),
    () => counts(tx, rows.map((r) => r.id)),
    () => tx.select({ key: schema.ciTypes.key, name: schema.ciTypes.name }).from(schema.ciTypes),
  ]);
  const team = new Map(teams.map((t) => [t.id, t.name]));
  const policy = new Map(policies.map((p) => [p.id, p.name]));
  const ciType = new Map(ciTypes.map((c) => [c.key, c.name]));
  return rows.map((r) => ({
    ...r,
    categoryLabel: r.categoryId ? labels.get(r.categoryId)?.label ?? null : null,
    subcategoryLabel: r.subcategoryId ? labels.get(r.subcategoryId)?.label ?? null : null,
    statusLabel: r.statusId ? labels.get(r.statusId)?.label ?? null : null,
    statusColor: r.statusId ? labels.get(r.statusId)?.color ?? null : null,
    defaultTicketCategoryLabel: r.defaultTicketCategoryId ? labels.get(r.defaultTicketCategoryId)?.label ?? null : null,
    defaultTeamName: r.defaultTeamId ? team.get(r.defaultTeamId) ?? null : null,
    defaultSlaPolicyName: r.defaultSlaPolicyId ? policy.get(r.defaultSlaPolicyId) ?? null : null,
    ownerName: r.ownerUserId ? owners.get(r.ownerUserId)?.name ?? null : null,
    ciTypes: (r.ciTypeKeys ?? []).map((key) => ({ key, name: ciType.get(key) ?? key })),
    counts: cnt.get(r.id) ?? { subscribedCustomers: 0, activeContracts: 0, openTickets: 0, incidents30d: 0, cis: 0 },
  }));
}

export type ServiceView = Awaited<ReturnType<typeof decorate>>[number];

/** WHERE clauses shared by the flat list and the grouped catalog. */
function listConditions(ctx: Ctx, q: Pick<ServiceListQuery, 'q' | 'domain' | 'includeInactive' | 'customerId'>) {
  const conds: SQL[] = [];
  if (q.includeInactive !== 'true') conds.push(eq(s.isActive, true));
  if (q.domain) conds.push(eq(s.domain, q.domain));
  if (q.q) conds.push(or(ilike(s.name, `%${q.q}%`), ilike(s.key, `%${q.q}%`), ilike(s.description, `%${q.q}%`))!);
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(inArray(s.id, ctx.tx.select({ id: schema.contractServices.serviceId }).from(schema.contractServices).innerJoin(schema.contracts, eq(schema.contracts.id, schema.contractServices.contractId)).where(and(eq(schema.contractServices.customerId, q.customerId), inArray(schema.contracts.status, COVERING_STATUSES)))));
  }
  return conds;
}

export async function listServices(ctx: Ctx, q: ServiceListQuery) {
  const conds = listConditions(ctx, q);
  if (q.categoryId) conds.push(eq(s.categoryId, q.categoryId));
  if (q.subcategoryId) conds.push(eq(s.subcategoryId, q.subcategoryId));
  const rows = await ctx.tx.select().from(s).where(conds.length ? and(...conds) : undefined).orderBy(asc(s.name));
  const items = await decorate(ctx.tx, rows);
  return { items, total: items.length };
}

// ---------------------------------------------------------------- grouped catalog

type OptionRow = typeof schema.configOptions.$inferSelect;

const optionNode = (o: OptionRow) => ({ id: o.id, key: o.key, label: o.label, description: o.description, sortOrder: o.sortOrder, isActive: o.isActive });
const bySortOrder = <T extends { sortOrder: number; label: string }>(a: T, b: T) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label);

export interface CatalogSubcategory {
  id: string;
  key: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  services: ServiceView[];
}

export interface CatalogCategory extends Omit<CatalogSubcategory, 'services'> {
  icon: string | null;
  color: string | null;
  subcategories: CatalogSubcategory[];
  /** Services in this category that carry no subcategory. */
  services: ServiceView[];
}

/**
 * The catalog page: services grouped by category -> subcategory. Categories
 * and subcategories without services are omitted unless `includeEmpty=true`
 * (inactive option rows are only shown when they still hold a service).
 */
export async function serviceCatalog(ctx: Ctx, q: ServiceCatalogQuery) {
  const conds = listConditions(ctx, q);
  const includeEmpty = q.includeEmpty === 'true';
  const [rows, options] = await sequential([
    () => ctx.tx.select().from(s).where(conds.length ? and(...conds) : undefined).orderBy(asc(s.name)),
    () => ctx.tx.select().from(schema.configOptions).where(inArray(schema.configOptions.type, ['service_category', 'service_subcategory'])),
  ]);
  const items = await decorate(ctx.tx, rows);

  const categoryRows = options.filter((o) => o.type === 'service_category');
  const subcategoryRows = options.filter((o) => o.type === 'service_subcategory');
  const subcategoryById = new Map(subcategoryRows.map((o) => [o.id, o]));
  const categories = new Map<string, CatalogCategory>();
  for (const c of categoryRows) categories.set(c.id, { ...optionNode(c), icon: c.icon, color: c.color, subcategories: [], services: [] });
  const subcategories = new Map<string, CatalogSubcategory>();
  for (const sc of subcategoryRows) {
    const parent = sc.parentId ? categories.get(sc.parentId) : undefined;
    if (!parent) continue; // orphaned subcategory: its services fall back to the category level / uncategorised
    const node: CatalogSubcategory = { ...optionNode(sc), services: [] };
    subcategories.set(sc.id, node);
    parent.subcategories.push(node);
  }

  const uncategorised: ServiceView[] = [];
  for (const item of items) {
    const sub = item.subcategoryId ? subcategories.get(item.subcategoryId) : undefined;
    // A service always sits under its subcategory's parent, even if category_id drifted (e.g. edited directly in the database).
    const categoryId = (sub ? subcategoryById.get(sub.id)?.parentId : null) ?? item.categoryId;
    const category = categoryId ? categories.get(categoryId) : undefined;
    if (sub && category) sub.services.push(item);
    else if (category) category.services.push(item);
    else uncategorised.push(item);
  }

  const tree = [...categories.values()]
    .map((c) => ({ ...c, subcategories: c.subcategories.filter((sc) => sc.services.length > 0 || (includeEmpty && sc.isActive)).sort(bySortOrder) }))
    .filter((c) => c.services.length > 0 || c.subcategories.length > 0 || (includeEmpty && c.isActive))
    .sort(bySortOrder);

  const ids = items.map((i) => i.id);
  const subscribedCustomers = ids.length
    ? Number(((await ctx.tx.execute(sql`select count(distinct cs.customer_id)::int as n from contract_services cs join contracts c on c.id = cs.contract_id where c.status in ('active','expiring') and cs.service_id in (${uuidList(ids)})`)).rows[0] as { n: number }).n)
    : 0;
  const totals = {
    services: items.length,
    subscribedCustomers,
    openTickets: items.reduce((acc, i) => acc + i.counts.openTickets, 0),
    incidents30d: items.reduce((acc, i) => acc + i.counts.incidents30d, 0),
  };
  return { categories: tree, uncategorised, totals };
}

export async function serviceCustomers(ctx: Ctx, id: string) {
  const rows = await ctx.tx
    .select({ customerId: schema.customers.id, customerName: schema.customers.name, customerCode: schema.customers.code, contractId: schema.contracts.id, contractNumber: schema.contracts.number, contractName: schema.contracts.name, status: schema.contracts.status, endDate: schema.contracts.endDate, slaPolicyId: schema.contractServices.slaPolicyId, teamId: schema.contractServices.teamId })
    .from(schema.contractServices)
    .innerJoin(schema.contracts, eq(schema.contracts.id, schema.contractServices.contractId))
    .innerJoin(schema.customers, eq(schema.customers.id, schema.contracts.customerId))
    .where(and(eq(schema.contractServices.serviceId, id), inArray(schema.contracts.status, COVERING_STATUSES)))
    .orderBy(asc(schema.customers.name), asc(schema.contracts.endDate));
  const statusMap = await contractStatusOptions(ctx.tx);
  return rows.map((r) => ({ ...r, ...statusDisplay(r.status, statusMap) }));
}

export async function getService(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(s).where(eq(s.id, id)).limit(1);
  if (!row) throw new NotFoundError('Service');
  const [view] = await decorate(ctx.tx, [row]);
  const subscribedCustomers = await serviceCustomers(ctx, id);
  return { ...view, subscribedCustomers, incidentCount30d: view.counts.incidents30d, openTickets: view.counts.openTickets };
}

function values(input: Partial<ServiceInput>): Partial<typeof s.$inferInsert> {
  const v: Partial<typeof s.$inferInsert> = {};
  (['key', 'name', 'description', 'categoryId', 'subcategoryId', 'statusId', 'domain', 'defaultTeamId', 'defaultSlaPolicyId', 'defaultTicketCategoryId', 'ciTypeKeys', 'ownerUserId', 'isActive', 'customFields'] as const).forEach((k) => {
    if (input[k] !== undefined) (v as Record<string, unknown>)[k] = input[k];
  });
  return v;
}

async function option(tx: Tx, id: string) {
  const [row] = await tx.select({ id: schema.configOptions.id, type: schema.configOptions.type, parentId: schema.configOptions.parentId }).from(schema.configOptions).where(eq(schema.configOptions.id, id)).limit(1);
  return row;
}

/**
 * Keeps category and subcategory consistent: a subcategory must be a
 * `service_subcategory` option and its parent category always wins over the
 * supplied/stored category. Changing only the category drops a subcategory
 * that no longer belongs to it.
 */
async function resolveCategories(tx: Tx, v: Partial<typeof s.$inferInsert>, existing?: Pick<typeof s.$inferSelect, 'categoryId' | 'subcategoryId'>) {
  if (v.categoryId) {
    const row = await option(tx, v.categoryId);
    if (!row || row.type !== 'service_category') throw new ValidationError('Category must reference a service category option');
  }
  if (v.subcategoryId) {
    const row = await option(tx, v.subcategoryId);
    if (!row || row.type !== 'service_subcategory') throw new ValidationError('Subcategory must reference a service subcategory option');
    const categoryId = v.categoryId !== undefined ? v.categoryId : existing?.categoryId ?? null;
    if (row.parentId && row.parentId !== categoryId) v.categoryId = row.parentId;
  } else if (v.subcategoryId === undefined && v.categoryId !== undefined && existing?.subcategoryId) {
    const current = await option(tx, existing.subcategoryId);
    if (!current || current.parentId !== v.categoryId) v.subcategoryId = null;
  }
  return v;
}

async function defaultStatus(tx: Tx) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'service_status'), eq(schema.configOptions.isDefault, true))).limit(1);
  return row?.id ?? null;
}

export async function createService(ctx: Ctx, input: ServiceInput) {
  ctx.require('services:manage');
  const key = await uniqueKey(ctx.tx, input.key?.trim() || slugify(input.name));
  if (input.key && key !== input.key) throw new ConflictError(`Service key ${input.key} already exists`);
  const v = await resolveCategories(ctx.tx, values(input));
  const [row] = await ctx.tx
    .insert(s)
    .values({ ...v, key, name: input.name, statusId: input.statusId === undefined ? await defaultStatus(ctx.tx) : input.statusId, domain: input.domain ?? 'general', isActive: input.isActive ?? true })
    .returning();
  await ctx.audit({ entityType: 'service', entityId: row.id, entityLabel: row.name, action: 'create', metadata: { key: row.key, domain: row.domain } });
  return getService(ctx, row.id);
}

export async function updateService(ctx: Ctx, id: string, patch: Partial<ServiceInput>) {
  ctx.require('services:manage');
  const [before] = await ctx.tx.select().from(s).where(eq(s.id, id)).limit(1);
  if (!before) throw new NotFoundError('Service');
  const v = { ...(await resolveCategories(ctx.tx, values(patch), before)), updatedAt: new Date() };
  if (v.key && v.key !== before.key) {
    const unique = await uniqueKey(ctx.tx, v.key, id);
    if (unique !== v.key) throw new ConflictError(`Service key ${v.key} already exists`);
  }
  const [after] = await ctx.tx.update(s).set(v).where(eq(s.id, id)).returning();
  await ctx.audit({ entityType: 'service', entityId: id, entityLabel: after.name, action: 'update', changes: diffChanges(before as Record<string, unknown>, v as Record<string, unknown>) });
  return getService(ctx, id);
}

export async function deleteService(ctx: Ctx, id: string) {
  ctx.require('services:manage');
  const [row] = await ctx.tx.select().from(s).where(eq(s.id, id)).limit(1);
  if (!row) throw new NotFoundError('Service');
  const [refs] = (await ctx.tx.execute(sql`
    select (select count(*) from contract_services where service_id = ${id}::uuid)::int as contracts,
           (select count(*) from tickets where service_id = ${id}::uuid)::int as tickets,
           (select count(*) from catalog_items where service_id = ${id}::uuid)::int as "catalogItems"`)).rows as { contracts: number; tickets: number; catalogItems: number }[];
  if (refs.contracts > 0 || refs.tickets > 0 || refs.catalogItems > 0) {
    await ctx.tx.update(s).set({ isActive: false, updatedAt: new Date() }).where(eq(s.id, id));
    await ctx.audit({ entityType: 'service', entityId: id, entityLabel: row.name, action: 'deactivate', metadata: { references: refs } });
    return { deactivated: true, references: refs };
  }
  await ctx.tx.delete(s).where(eq(s.id, id));
  await ctx.audit({ entityType: 'service', entityId: id, entityLabel: row.name, action: 'delete', metadata: { key: row.key } });
  return { deleted: true };
}
