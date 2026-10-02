import { eq, and, inArray, asc, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { loadContract, todayStr, optionLabels, sequential } from './common';
import { COVERING_STATUSES } from './schemas';
import type { ScopeItemInput } from './schemas';

export type ScopeItemRow = typeof schema.scopeItems.$inferSelect;

// ---------------------------------------------------------------- cross-module contract

export interface ScopeEvaluation {
  status: 'in_scope' | 'out_of_scope' | 'unknown';
  contractId: string | null;
  scopeItemId: string | null;
  reason: string;
}

interface Coverage {
  contract: typeof schema.contracts.$inferSelect;
  services: (typeof schema.contractServices.$inferSelect)[];
  siteIds: string[];
}

/** Covering contracts (active/expiring, in term at `at`) for a customer with their service and site coverage. */
async function coveringContracts(tx: Tx, customerId: string, at: Date): Promise<Coverage[]> {
  const day = todayStr(at);
  const contracts = await tx
    .select()
    .from(schema.contracts)
    .where(and(eq(schema.contracts.customerId, customerId), inArray(schema.contracts.status, COVERING_STATUSES), sql`${schema.contracts.startDate} <= ${day}::date`, sql`${schema.contracts.endDate} >= ${day}::date`))
    .orderBy(asc(schema.contracts.startDate));
  if (!contracts.length) return [];
  const ids = contracts.map((c) => c.id);
  const [services, sites] = await sequential([
    () => tx.select().from(schema.contractServices).where(inArray(schema.contractServices.contractId, ids)),
    () => tx.select().from(schema.contractSites).where(inArray(schema.contractSites.contractId, ids)),
  ]);
  return contracts.map((contract) => ({
    contract,
    services: services.filter((s) => s.contractId === contract.id),
    siteIds: sites.filter((s) => s.contractId === contract.id).map((s) => s.siteId),
  }));
}

const coversSite = (c: Coverage, siteId: string | null | undefined) => !siteId || c.siteIds.length === 0 || c.siteIds.includes(siteId);
const coversService = (c: Coverage, serviceId: string | null | undefined) => !serviceId || c.services.some((s) => s.serviceId === serviceId);

/** Coverage specificity: explicit site coverage beats "all sites"; later start dates win ties. */
function coverageScore(c: Coverage, siteId: string | null | undefined, serviceId: string | null | undefined) {
  let score = 0;
  if (siteId && c.siteIds.includes(siteId)) score += 2;
  if (serviceId && c.services.some((s) => s.serviceId === serviceId)) score += 1;
  return score;
}

const byCoverage = (siteId: string | null | undefined, serviceId: string | null | undefined) => (a: Coverage, b: Coverage) =>
  coverageScore(b, siteId, serviceId) - coverageScore(a, siteId, serviceId) || (b.contract.startDate > a.contract.startDate ? 1 : b.contract.startDate < a.contract.startDate ? -1 : 0);

/**
 * Matches a scope item against the ticket dimensions. Null dimensions on the
 * item are wildcards; a non-null dimension must equal the input. Returns the
 * number of non-null dimensions that matched (specificity) or -1 when the item
 * does not apply.
 */
function matchItem(item: ScopeItemRow, input: { serviceId?: string | null; siteId?: string | null; ticketCategoryId?: string | null; ciTypeKey?: string | null }) {
  let specificity = 0;
  const dims: [string | null, string | null | undefined][] = [
    [item.serviceId, input.serviceId],
    [item.siteId, input.siteId],
    [item.ticketCategoryId, input.ticketCategoryId],
    [item.ciTypeKey, input.ciTypeKey],
  ];
  for (const [itemValue, inputValue] of dims) {
    if (itemValue === null || itemValue === undefined) continue;
    if (itemValue !== inputValue) return -1;
    specificity++;
  }
  return specificity;
}

/**
 * Classifies a ticket (service, site, category, CI type) against the customer's
 * covering contracts and their scope items.
 *
 * 1. No covering contract (active/expiring, in term) → unknown.
 * 2. Candidate contracts cover the service (contract_services) and the site
 *    (no contract_sites rows = all sites). Without a serviceId, every contract
 *    covering the site is a candidate.
 * 3. Scope items of the candidates are matched with null dimensions as
 *    wildcards. The most specific match wins; at equal specificity an explicit
 *    out_of_scope item wins over in_scope.
 * 4. No matching item: with a serviceId the best candidate covers the service →
 *    in_scope ("Service covered by contract X"); without a serviceId → unknown.
 * 5. Service given but no candidate covers it (or the site) → out_of_scope.
 */
export async function evaluateScope(tx: Tx, input: { customerId: string; serviceId?: string | null; siteId?: string | null; ticketCategoryId?: string | null; ciTypeKey?: string | null; at?: Date }): Promise<ScopeEvaluation> {
  const at = input.at ?? new Date();
  const covering = await coveringContracts(tx, input.customerId, at);
  if (!covering.length) return { status: 'unknown', contractId: null, scopeItemId: null, reason: 'No active contract' };

  const candidates = covering.filter((c) => coversSite(c, input.siteId) && coversService(c, input.serviceId)).sort(byCoverage(input.siteId, input.serviceId));

  if (!candidates.length) {
    if (input.serviceId) {
      const serviceCovered = covering.some((c) => coversService(c, input.serviceId));
      return {
        status: 'out_of_scope',
        contractId: null,
        scopeItemId: null,
        reason: serviceCovered ? 'Site not covered by any active contract for this service' : 'Service not covered by any active contract',
      };
    }
    return { status: 'unknown', contractId: null, scopeItemId: null, reason: 'Site not covered by any active contract' };
  }

  const items = await tx.select().from(schema.scopeItems).where(inArray(schema.scopeItems.contractId, candidates.map((c) => c.contract.id)));
  let best: { item: ScopeItemRow; specificity: number; rank: number } | null = null;
  candidates.forEach((c, rank) => {
    for (const item of items) {
      if (item.contractId !== c.contract.id || item.classification === 'unknown') continue;
      const specificity = matchItem(item, input);
      if (specificity < 0) continue;
      const better =
        !best ||
        specificity > best.specificity ||
        (specificity === best.specificity && item.classification === 'out_of_scope' && best.item.classification !== 'out_of_scope') ||
        (specificity === best.specificity && item.classification === best.item.classification && rank < best.rank);
      if (better) best = { item, specificity, rank };
    }
  });

  if (best) {
    const { item } = best as { item: ScopeItemRow };
    const contract = candidates.find((c) => c.contract.id === item.contractId)!.contract;
    return {
      status: item.classification === 'out_of_scope' ? 'out_of_scope' : 'in_scope',
      contractId: contract.id,
      scopeItemId: item.id,
      reason: `${item.classification === 'out_of_scope' ? 'Excluded' : 'Covered'} by scope item "${item.name}" on contract ${contract.number}`,
    };
  }

  if (input.serviceId) {
    const c = candidates[0].contract;
    return { status: 'in_scope', contractId: c.id, scopeItemId: null, reason: `Service covered by contract ${c.number}` };
  }
  return { status: 'unknown', contractId: candidates[0].contract.id, scopeItemId: null, reason: 'No service specified; no scope rule matched' };
}

/**
 * Picks the contract (and its SLA / support hours / team defaults) a new ticket
 * should run under: the most specific covering contract for the service and
 * site (explicit site coverage over all-sites, later start date on ties).
 */
export async function selectContractForTicket(tx: Tx, input: { customerId: string; serviceId?: string | null; siteId?: string | null; at?: Date }): Promise<{ contractId: string; slaPolicyId: string | null; supportHoursCalendarId: string | null; teamId: string | null } | null> {
  const covering = await coveringContracts(tx, input.customerId, input.at ?? new Date());
  const candidates = covering.filter((c) => coversSite(c, input.siteId) && coversService(c, input.serviceId)).sort(byCoverage(input.siteId, input.serviceId));
  const best = candidates[0];
  if (!best) return null;
  const cs = input.serviceId ? best.services.find((s) => s.serviceId === input.serviceId) : undefined;
  return {
    contractId: best.contract.id,
    slaPolicyId: cs?.slaPolicyId ?? best.contract.slaPolicyId ?? null,
    supportHoursCalendarId: cs?.supportHoursCalendarId ?? best.contract.supportHoursCalendarId ?? null,
    teamId: cs?.teamId ?? null,
  };
}

// ---------------------------------------------------------------- CRUD

async function decorate(tx: Tx, items: ScopeItemRow[]) {
  const labels = await optionLabels(tx, items.flatMap((i) => [i.headerId, i.categoryId, i.typeId, i.statusId, i.ticketCategoryId, i.assetCategoryId]));
  const serviceIds = [...new Set(items.map((i) => i.serviceId).filter((x): x is string => !!x))];
  const siteIds = [...new Set(items.map((i) => i.siteId).filter((x): x is string => !!x))];
  const ciKeys = [...new Set(items.map((i) => i.ciTypeKey).filter((x): x is string => !!x))];
  const [services, sites, ciTypes] = await sequential([
    async () => (serviceIds.length ? await tx.select({ id: schema.services.id, name: schema.services.name }).from(schema.services).where(inArray(schema.services.id, serviceIds)) : []),
    async () => (siteIds.length ? await tx.select({ id: schema.sites.id, name: schema.sites.name }).from(schema.sites).where(inArray(schema.sites.id, siteIds)) : []),
    async () => (ciKeys.length ? await tx.select({ key: schema.ciTypes.key, name: schema.ciTypes.name }).from(schema.ciTypes).where(inArray(schema.ciTypes.key, ciKeys)) : []),
  ]);
  const svc = new Map(services.map((s) => [s.id, s.name]));
  const site = new Map(sites.map((s) => [s.id, s.name]));
  const ci = new Map(ciTypes.map((c) => [c.key, c.name]));
  const lbl = (id: string | null) => (id ? labels.get(id)?.label ?? null : null);
  return items.map((i) => ({
    ...i,
    headerLabel: lbl(i.headerId),
    categoryLabel: lbl(i.categoryId),
    typeLabel: lbl(i.typeId),
    statusLabel: lbl(i.statusId),
    ticketCategoryLabel: lbl(i.ticketCategoryId),
    assetCategoryLabel: lbl(i.assetCategoryId),
    serviceName: i.serviceId ? svc.get(i.serviceId) ?? null : null,
    siteName: i.siteId ? site.get(i.siteId) ?? null : null,
    ciTypeName: i.ciTypeKey ? ci.get(i.ciTypeKey) ?? i.ciTypeKey : null,
  }));
}

export type ScopeItemView = Awaited<ReturnType<typeof decorate>>[number];

export function groupByHeader(items: ScopeItemView[]) {
  const groups = new Map<string, { headerId: string | null; headerLabel: string; items: ScopeItemView[] }>();
  for (const item of items) {
    const key = item.headerId ?? '';
    const g = groups.get(key) ?? { headerId: item.headerId, headerLabel: item.headerLabel ?? 'General', items: [] };
    g.items.push(item);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.headerId === null ? 1 : b.headerId === null ? -1 : a.headerLabel.localeCompare(b.headerLabel)));
}

export async function listScopeItems(ctx: Ctx, contractId: string) {
  await loadContract(ctx, contractId);
  const rows = await ctx.tx.select().from(schema.scopeItems).where(eq(schema.scopeItems.contractId, contractId)).orderBy(asc(schema.scopeItems.sortOrder), asc(schema.scopeItems.name));
  const items = await decorate(ctx.tx, rows);
  return { items, groups: groupByHeader(items) };
}

/** Scope of all covering contracts of a customer, grouped per contract and header. */
export async function customerScope(ctx: Ctx, customerId: string) {
  ctx.requireCustomer(customerId);
  const contracts = await ctx.tx
    .select({ id: schema.contracts.id, number: schema.contracts.number, name: schema.contracts.name, status: schema.contracts.status, startDate: schema.contracts.startDate, endDate: schema.contracts.endDate, slaPolicyId: schema.contracts.slaPolicyId, supportHoursCalendarId: schema.contracts.supportHoursCalendarId })
    .from(schema.contracts)
    .where(and(eq(schema.contracts.customerId, customerId), inArray(schema.contracts.status, COVERING_STATUSES)))
    .orderBy(asc(schema.contracts.endDate));
  if (!contracts.length) return [];
  const contractIds = contracts.map((c) => c.id);
  const rows = await ctx.tx.select().from(schema.scopeItems).where(inArray(schema.scopeItems.contractId, contractIds)).orderBy(asc(schema.scopeItems.sortOrder), asc(schema.scopeItems.name));
  const items = await decorate(ctx.tx, rows);
  const services = await ctx.tx
    .select({ cs: schema.contractServices, serviceName: schema.services.name, domain: schema.services.domain, serviceDefaultSlaPolicyId: schema.services.defaultSlaPolicyId })
    .from(schema.contractServices)
    .innerJoin(schema.services, eq(schema.services.id, schema.contractServices.serviceId))
    .where(inArray(schema.contractServices.contractId, contractIds))
    .orderBy(asc(schema.services.name));
  const sites = await ctx.tx
    .select({ contractId: schema.contractSites.contractId, id: schema.sites.id, name: schema.sites.name, code: schema.sites.code })
    .from(schema.contractSites)
    .innerJoin(schema.sites, eq(schema.sites.id, schema.contractSites.siteId))
    .where(inArray(schema.contractSites.contractId, contractIds));
  const policies = new Map((await ctx.tx.select({ id: schema.slaPolicies.id, name: schema.slaPolicies.name }).from(schema.slaPolicies)).map((p) => [p.id, p.name]));
  const teams = new Map((await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams)).map((t) => [t.id, t.name]));
  const calendars = new Map((await ctx.tx.select({ id: schema.businessCalendars.id, name: schema.businessCalendars.name }).from(schema.businessCalendars)).map((c) => [c.id, c.name]));
  return contracts.map((c) => ({
    contract: { ...c, slaPolicyName: c.slaPolicyId ? policies.get(c.slaPolicyId) ?? null : null },
    services: services
      .filter((s) => s.cs.contractId === c.id)
      .map((s) => {
        const effective = s.cs.slaPolicyId ?? c.slaPolicyId ?? s.serviceDefaultSlaPolicyId ?? null;
        return {
          serviceId: s.cs.serviceId,
          serviceName: s.serviceName,
          domain: s.domain,
          slaPolicyId: s.cs.slaPolicyId,
          slaPolicyName: s.cs.slaPolicyId ? policies.get(s.cs.slaPolicyId) ?? null : null,
          effectiveSlaPolicyId: effective,
          effectiveSlaPolicyName: effective ? policies.get(effective) ?? null : null,
          teamId: s.cs.teamId,
          teamName: s.cs.teamId ? teams.get(s.cs.teamId) ?? null : null,
          supportHoursCalendarId: s.cs.supportHoursCalendarId,
          supportHoursCalendarName: (s.cs.supportHoursCalendarId ?? c.supportHoursCalendarId) ? calendars.get(s.cs.supportHoursCalendarId ?? c.supportHoursCalendarId!) ?? null : null,
        };
      }),
    sites: sites.filter((s) => s.contractId === c.id).map(({ contractId: _x, ...s }) => s),
    groups: groupByHeader(items.filter((i) => i.contractId === c.id)),
  }));
}

async function validateRefs(ctx: Ctx, customerId: string, input: Partial<ScopeItemInput>) {
  if (input.siteId) {
    const [site] = await ctx.tx.select({ customerId: schema.sites.customerId }).from(schema.sites).where(eq(schema.sites.id, input.siteId)).limit(1);
    if (!site || site.customerId !== customerId) throw new ValidationError('Site does not belong to this customer');
  }
}

function toValues(input: Partial<ScopeItemInput>) {
  const v: Partial<typeof schema.scopeItems.$inferInsert> = {};
  if (input.name !== undefined) v.name = input.name;
  if (input.description !== undefined) v.description = input.description;
  if (input.classification !== undefined) v.classification = input.classification;
  if (input.headerId !== undefined) v.headerId = input.headerId;
  if (input.categoryId !== undefined) v.categoryId = input.categoryId;
  if (input.typeId !== undefined) v.typeId = input.typeId;
  if (input.statusId !== undefined) v.statusId = input.statusId;
  if (input.serviceId !== undefined) v.serviceId = input.serviceId;
  if (input.siteId !== undefined) v.siteId = input.siteId;
  if (input.ticketCategoryId !== undefined) v.ticketCategoryId = input.ticketCategoryId;
  if (input.ciTypeKey !== undefined) v.ciTypeKey = input.ciTypeKey;
  if (input.assetCategoryId !== undefined) v.assetCategoryId = input.assetCategoryId;
  if (input.attributes !== undefined) v.attributes = input.attributes;
  if (input.sortOrder !== undefined) v.sortOrder = input.sortOrder;
  return v;
}

export async function createScopeItem(ctx: Ctx, contractId: string, input: ScopeItemInput) {
  const contract = await loadContract(ctx, contractId);
  ctx.require('contracts:manage', contract.customerId);
  await validateRefs(ctx, contract.customerId, input);
  const [row] = await ctx.tx.insert(schema.scopeItems).values({ ...toValues(input), name: input.name, contractId, customerId: contract.customerId }).returning();
  await ctx.audit({ entityType: 'scope_item', entityId: row.id, entityLabel: row.name, action: 'create', customerId: contract.customerId, metadata: { contractId, contractNumber: contract.number, classification: row.classification } });
  const [view] = await decorate(ctx.tx, [row]);
  return view;
}

export async function bulkCreateScopeItems(ctx: Ctx, contractId: string, inputs: ScopeItemInput[]) {
  const contract = await loadContract(ctx, contractId);
  ctx.require('contracts:manage', contract.customerId);
  if (!inputs.length) return [];
  for (const i of inputs) await validateRefs(ctx, contract.customerId, i);
  const [{ max }] = await ctx.tx.select({ max: sql<number>`coalesce(max(${schema.scopeItems.sortOrder}), 0)::int` }).from(schema.scopeItems).where(eq(schema.scopeItems.contractId, contractId));
  const rows = await ctx.tx
    .insert(schema.scopeItems)
    .values(inputs.map((input, i) => ({ ...toValues(input), name: input.name, contractId, customerId: contract.customerId, sortOrder: input.sortOrder ?? max + (i + 1) * 10 })))
    .returning();
  await ctx.audit({ entityType: 'scope_item', entityId: null, entityLabel: `${rows.length} scope items`, action: 'bulk_create', customerId: contract.customerId, metadata: { contractId, contractNumber: contract.number, ids: rows.map((r) => r.id), names: rows.map((r) => r.name) } });
  return decorate(ctx.tx, rows);
}

export async function updateScopeItem(ctx: Ctx, id: string, patch: Partial<ScopeItemInput>) {
  const [before] = await ctx.tx.select().from(schema.scopeItems).where(eq(schema.scopeItems.id, id)).limit(1);
  if (!before) throw new NotFoundError('Scope item');
  const contract = await loadContract(ctx, before.contractId);
  ctx.require('contracts:manage', contract.customerId);
  await validateRefs(ctx, contract.customerId, patch);
  const values = { ...toValues(patch), updatedAt: new Date() };
  const [after] = await ctx.tx.update(schema.scopeItems).set(values).where(eq(schema.scopeItems.id, id)).returning();
  await ctx.audit({ entityType: 'scope_item', entityId: id, entityLabel: after.name, action: 'update', customerId: contract.customerId, changes: diffChanges(before as Record<string, unknown>, values as Record<string, unknown>), metadata: { contractId: contract.id, contractNumber: contract.number } });
  const [view] = await decorate(ctx.tx, [after]);
  return view;
}

export async function deleteScopeItem(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.scopeItems).where(eq(schema.scopeItems.id, id)).limit(1);
  if (!row) throw new NotFoundError('Scope item');
  const contract = await loadContract(ctx, row.contractId);
  ctx.require('contracts:manage', contract.customerId);
  await ctx.tx.delete(schema.scopeItems).where(eq(schema.scopeItems.id, id));
  await ctx.audit({ entityType: 'scope_item', entityId: id, entityLabel: row.name, action: 'delete', customerId: contract.customerId, metadata: { contractId: contract.id, contractNumber: contract.number } });
  return { deleted: true };
}

/** Evaluate scope through the API (tickets UI preview, AI tools). */
export async function evaluateScopeForCustomer(ctx: Ctx, input: { customerId: string; serviceId?: string | null; siteId?: string | null; ticketCategoryId?: string | null; ciTypeKey?: string | null }) {
  ctx.requireCustomer(input.customerId);
  return evaluateScope(ctx.tx, input);
}
