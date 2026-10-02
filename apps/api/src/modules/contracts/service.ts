import { eq, and, or, inArray, desc, asc, sql, exists, type SQL } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError, ConflictError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { orderBy, searchLike } from '@/core/query';
import { getSetting } from '@/modules/config/service';
import { loadContract, todayStr, addDays, daysToExpiry, contractStatusOptions, statusDisplay, optionLabels, userNames, type ContractRow, sequential } from './common';
import { COVERING_STATUSES, CONTRACT_STATUSES, type ContractCreate, type ContractPatch, type ContractListQuery, type ContractSummaryQuery, type ContractServiceInput, type RenewInput, type EntitlementInput, type ScopeItemInput } from './schemas';
import { utilizationBatch, decorateEntitlements, entitlementSummary } from './entitlements';
import { listScopeItems } from './scope';

const c = schema.contracts;

// ---------------------------------------------------------------- numbering

/** Next `CTR-YYYY-NNNN` for the year (max existing numeric suffix + 1). */
export async function nextContractNumber(tx: Tx, year = new Date().getUTCFullYear()) {
  const prefix = `CTR-${year}-`;
  const res = await tx.execute(sql`SELECT coalesce(max((substring(number from ${`^${prefix}(\\d+)$`}))::int), 0)::int AS max FROM contracts WHERE number LIKE ${`${prefix}%`}`);
  const max = Number((res.rows[0] as { max: number }).max ?? 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

// ---------------------------------------------------------------- helpers

function validateDates(startDate: string, endDate: string, renewalDate?: string | null) {
  if (endDate < startDate) throw new ValidationError('End date must be on or after the start date');
  if (renewalDate && renewalDate < startDate) throw new ValidationError('Renewal date must be after the start date');
}

async function noticeWindowDays(tx: Tx, contract: Pick<ContractRow, 'noticePeriodDays'>) {
  const [row] = await tx.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'contracts.expiry_notice_days')).limit(1);
  const configured = Array.isArray(row?.value) ? (row!.value as unknown[]).map(Number).filter((n) => !isNaN(n)) : [];
  return Math.max(contract.noticePeriodDays ?? 0, ...configured, 0);
}

/** active vs expiring, given the end date and the notice window. */
export function liveStatus(endDate: string, windowDays: number, now = new Date()): 'active' | 'expiring' | 'expired' {
  const days = daysToExpiry(endDate, now);
  if (days < 0) return 'expired';
  return days <= windowDays ? 'expiring' : 'active';
}

async function assertSitesBelong(tx: Tx, customerId: string, siteIds: string[]) {
  if (!siteIds.length) return;
  const rows = await tx.select({ id: schema.sites.id }).from(schema.sites).where(and(inArray(schema.sites.id, siteIds), eq(schema.sites.customerId, customerId)));
  if (rows.length !== new Set(siteIds).size) throw new ValidationError('One or more sites do not belong to this customer');
}

async function assertServicesExist(tx: Tx, serviceIds: string[]) {
  if (!serviceIds.length) return;
  const rows = await tx.select({ id: schema.services.id }).from(schema.services).where(inArray(schema.services.id, serviceIds));
  if (rows.length !== new Set(serviceIds).size) throw new ValidationError('One or more services do not exist');
}

async function replaceServices(tx: Tx, contract: ContractRow, services: ContractServiceInput[]) {
  const seen = new Set<string>();
  const unique = services.filter((s) => (seen.has(s.serviceId) ? false : (seen.add(s.serviceId), true)));
  await assertServicesExist(tx, unique.map((s) => s.serviceId));
  await tx.delete(schema.contractServices).where(eq(schema.contractServices.contractId, contract.id));
  if (unique.length) {
    await tx.insert(schema.contractServices).values(unique.map((s) => ({ contractId: contract.id, customerId: contract.customerId, serviceId: s.serviceId, slaPolicyId: s.slaPolicyId ?? null, teamId: s.teamId ?? null, supportHoursCalendarId: s.supportHoursCalendarId ?? null, notes: s.notes ?? null })));
  }
}

async function replaceSites(tx: Tx, contract: ContractRow, siteIds: string[]) {
  const unique = [...new Set(siteIds)];
  await assertSitesBelong(tx, contract.customerId, unique);
  await tx.delete(schema.contractSites).where(eq(schema.contractSites.contractId, contract.id));
  if (unique.length) await tx.insert(schema.contractSites).values(unique.map((siteId) => ({ contractId: contract.id, customerId: contract.customerId, siteId })));
}

async function insertEntitlements(tx: Tx, contract: ContractRow, items: EntitlementInput[]) {
  if (!items.length) return [];
  const labels = await optionLabels(tx, items.map((i) => i.typeId));
  return tx
    .insert(schema.contractEntitlements)
    .values(
      items.map((i) => ({
        contractId: contract.id,
        customerId: contract.customerId,
        typeId: i.typeId ?? null,
        name: i.name,
        serviceId: i.serviceId ?? null,
        quantity: String(i.quantity),
        unit: i.unit ?? (i.typeId && typeof labels.get(i.typeId)?.metadata?.unit === 'string' ? (labels.get(i.typeId)!.metadata.unit as string) : 'count'),
        period: i.period ?? 'contract',
        warnThresholdPct: i.warnThresholdPct ?? 80,
        overageAllowed: i.overageAllowed ?? true,
        notes: i.notes ?? null,
        isActive: i.isActive ?? true,
      })),
    )
    .returning();
}

async function insertScopeItems(tx: Tx, contract: ContractRow, items: ScopeItemInput[]) {
  if (!items.length) return [];
  await assertSitesBelong(tx, contract.customerId, items.map((i) => i.siteId).filter((x): x is string => !!x));
  return tx
    .insert(schema.scopeItems)
    .values(
      items.map((i, idx) => ({
        contractId: contract.id,
        customerId: contract.customerId,
        name: i.name,
        description: i.description ?? null,
        classification: i.classification ?? 'in_scope',
        headerId: i.headerId ?? null,
        categoryId: i.categoryId ?? null,
        typeId: i.typeId ?? null,
        statusId: i.statusId ?? null,
        serviceId: i.serviceId ?? null,
        siteId: i.siteId ?? null,
        ticketCategoryId: i.ticketCategoryId ?? null,
        ciTypeKey: i.ciTypeKey ?? null,
        assetCategoryId: i.assetCategoryId ?? null,
        attributes: i.attributes ?? {},
        sortOrder: i.sortOrder ?? (idx + 1) * 10,
      })),
    )
    .returning();
}

function contractValues(input: Partial<ContractCreate>): Partial<typeof c.$inferInsert> {
  const v: Partial<typeof c.$inferInsert> = {};
  const copy = <K extends keyof typeof v & keyof ContractCreate>(k: K) => {
    if (input[k] !== undefined) (v as Record<string, unknown>)[k] = input[k];
  };
  (['number', 'name', 'typeId', 'startDate', 'endDate', 'renewalDate', 'noticePeriodDays', 'autoRenew', 'supportHoursCalendarId', 'holidayCalendarId', 'slaPolicyId', 'responseCommitment', 'resolutionCommitment', 'exclusions', 'description', 'signedAt', 'ownerUserId', 'customFields'] as const).forEach(copy);
  if (input.escalationMatrix !== undefined) v.escalationMatrix = input.escalationMatrix as Record<string, unknown>[];
  return v;
}

// ---------------------------------------------------------------- list

export async function listContracts(ctx: Ctx, q: ContractListQuery) {
  ctx.require('contracts:read', q.customerId);
  const cu = schema.customers;
  const conds: SQL[] = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(c.customerId, q.customerId));
  }
  if (q.status?.length) conds.push(inArray(c.status, q.status));
  if (q.typeId) conds.push(eq(c.typeId, q.typeId));
  if (q.ownerUserId) conds.push(eq(c.ownerUserId, q.ownerUserId));
  const search = searchLike(q.q, c.number, c.name);
  if (search) conds.push(search);
  if (q.expiringWithinDays !== undefined) {
    const today = todayStr();
    conds.push(inArray(c.status, COVERING_STATUSES), sql`${c.endDate} >= ${today}::date`, sql`${c.endDate} <= ${addDays(today, q.expiringWithinDays)}::date`);
  }
  if (q.serviceId) conds.push(exists(ctx.tx.select({ one: sql`1` }).from(schema.contractServices).where(and(eq(schema.contractServices.contractId, c.id), eq(schema.contractServices.serviceId, q.serviceId)))));
  if (q.siteId) conds.push(exists(ctx.tx.select({ one: sql`1` }).from(schema.contractSites).where(and(eq(schema.contractSites.contractId, c.id), eq(schema.contractSites.siteId, q.siteId)))));
  const where = conds.length ? and(...conds) : undefined;
  const sortable = { endDate: c.endDate, startDate: c.startDate, number: c.number, name: c.name, customer: cu.name, status: c.status, createdAt: c.createdAt };
  const order = orderBy(sortable, q.sort, q.order ?? (q.sort === 'createdAt' ? 'desc' : 'asc'), c.endDate);

  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(c).innerJoin(cu, eq(cu.id, c.customerId)).where(where);
  const rows = await ctx.tx
    .select({ contract: c, customerName: cu.name, customerCode: cu.code, typeLabel: schema.configOptions.label })
    .from(c)
    .innerJoin(cu, eq(cu.id, c.customerId))
    .leftJoin(schema.configOptions, eq(schema.configOptions.id, c.typeId))
    .where(where)
    .orderBy(order, asc(c.number))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  const ids = rows.map((r) => r.contract.id);
  const [serviceRows, ents, statusMap] = await sequential([
    async () =>
      ids.length
        ? await ctx.tx.select({ contractId: schema.contractServices.contractId, id: schema.services.id, name: schema.services.name }).from(schema.contractServices).innerJoin(schema.services, eq(schema.services.id, schema.contractServices.serviceId)).where(inArray(schema.contractServices.contractId, ids)).orderBy(asc(schema.services.name))
        : [],
    async () => (ids.length ? await ctx.tx.select().from(schema.contractEntitlements).where(and(inArray(schema.contractEntitlements.contractId, ids), eq(schema.contractEntitlements.isActive, true))) : []),
    () => contractStatusOptions(ctx.tx),
  ]);
  const owners = await userNames(ctx.tx, rows.map((r) => r.contract.ownerUserId));
  const util = await utilizationBatch(ctx.tx, ents, new Map(rows.map((r) => [r.contract.id, r.contract])));

  const items = rows.map((r) => {
    const myEnts = ents.filter((e) => e.contractId === r.contract.id);
    const utils = myEnts.map((e) => util.get(e.id)!).filter(Boolean);
    return {
      ...r.contract,
      customerName: r.customerName,
      customerCode: r.customerCode,
      typeLabel: r.typeLabel,
      ownerName: r.contract.ownerUserId ? owners.get(r.contract.ownerUserId)?.name ?? null : null,
      ...statusDisplay(r.contract.status, statusMap),
      daysToExpiry: daysToExpiry(r.contract.endDate),
      services: serviceRows.filter((s) => s.contractId === r.contract.id).map((s) => ({ id: s.id, name: s.name })),
      serviceNames: serviceRows.filter((s) => s.contractId === r.contract.id).map((s) => s.name),
      entitlements: {
        count: myEnts.length,
        anyOverThreshold: utils.some((u) => u.overThreshold),
        anyExhausted: utils.some((u) => u.exhausted),
        maxPct: utils.reduce((m, u) => Math.max(m, u.pct), 0),
      },
    };
  });
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

export async function expiringContracts(ctx: Ctx, days = 90, customerId?: string) {
  const res = await listContracts(ctx, { page: 1, pageSize: 500, sort: 'endDate', order: 'asc', expiringWithinDays: days, customerId });
  return { items: res.items, total: res.total, days };
}

// ---------------------------------------------------------------- summary

/**
 * Headline numbers for the contracts page. `active` = covering (active/expiring)
 * contracts whose end date has not passed; `expiring30/90` = covering contracts
 * ending within 30/90 days; `expired` = status expired or end date in the past.
 * Entitlement counts come from the same calculation as /contracts/entitlements/summary.
 */
export async function contractSummary(ctx: Ctx, q: ContractSummaryQuery) {
  ctx.require('contracts:read', q.customerId);
  const conds: SQL[] = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(c.customerId, q.customerId));
  }
  const where = conds.length ? and(...conds) : undefined;
  const today = todayStr();
  const count = sql<number>`count(*)::int`;
  const covering = inArray(c.status, COVERING_STATUSES);
  const endsWithin = (days: number) => sql`${c.endDate} >= ${today}::date AND ${c.endDate} <= ${addDays(today, days)}::date`;
  const [agg, byStatusRows, byTypeRows, statusMap, ents] = await sequential([
    () => ctx.tx
      .select({
        total: count,
        active: sql<number>`count(*) FILTER (WHERE ${covering} AND ${c.endDate} >= ${today}::date)::int`,
        expiring30: sql<number>`count(*) FILTER (WHERE ${covering} AND ${endsWithin(30)})::int`,
        expiring90: sql<number>`count(*) FILTER (WHERE ${covering} AND ${endsWithin(90)})::int`,
        expired: sql<number>`count(*) FILTER (WHERE ${c.status} = 'expired' OR ${c.endDate} < ${today}::date)::int`,
      })
      .from(c)
      .where(where),
    () => ctx.tx.select({ key: c.status, count }).from(c).where(where).groupBy(c.status),
    () => ctx.tx
      .select({ id: c.typeId, key: schema.configOptions.key, label: schema.configOptions.label, count })
      .from(c)
      .leftJoin(schema.configOptions, eq(schema.configOptions.id, c.typeId))
      .where(where)
      .groupBy(c.typeId, schema.configOptions.key, schema.configOptions.label)
      .orderBy(desc(count)),
    () => contractStatusOptions(ctx.tx),
    () => entitlementSummary(ctx, q.customerId, 1),
  ]);
  const statusOrder = new Map<string, number>(CONTRACT_STATUSES.map((s, i) => [s, i]));
  const byStatus = byStatusRows
    .sort((a, b) => (statusOrder.get(a.key) ?? 99) - (statusOrder.get(b.key) ?? 99))
    .map((r) => {
      const d = statusDisplay(r.key, statusMap);
      return { key: r.key, label: d.statusLabel, color: d.statusColor, count: r.count };
    });
  return {
    total: agg[0]?.total ?? 0,
    active: agg[0]?.active ?? 0,
    expiring30: agg[0]?.expiring30 ?? 0,
    expiring90: agg[0]?.expiring90 ?? 0,
    expired: agg[0]?.expired ?? 0,
    byStatus,
    byType: byTypeRows.map((r) => ({ id: r.id, key: r.key ?? null, label: r.label ?? 'Unset', count: r.count })),
    entitlementsOverThreshold: ents.overThreshold,
    entitlementsExhausted: ents.exhausted,
  };
}

// ---------------------------------------------------------------- get

export async function getContract(ctx: Ctx, id: string) {
  const contract = await loadContract(ctx, id);
  const [customer] = await ctx.tx.select({ id: schema.customers.id, code: schema.customers.code, name: schema.customers.name, accountManagerId: schema.customers.accountManagerId }).from(schema.customers).where(eq(schema.customers.id, contract.customerId)).limit(1);

  const [serviceRows, siteRows, entRows, scope, children, parent, docs, statusMap, labels, policies, calendars, holidayCals, ticketCounts] = await sequential([
    () => ctx.tx
      .select({ cs: schema.contractServices, serviceName: schema.services.name, serviceKey: schema.services.key, serviceDomain: schema.services.domain, serviceDefaultSlaPolicyId: schema.services.defaultSlaPolicyId, serviceDefaultTeamId: schema.services.defaultTeamId })
      .from(schema.contractServices)
      .innerJoin(schema.services, eq(schema.services.id, schema.contractServices.serviceId))
      .where(eq(schema.contractServices.contractId, id))
      .orderBy(asc(schema.services.name)),
    () => ctx.tx
      .select({ id: schema.sites.id, code: schema.sites.code, name: schema.sites.name, isPrimary: schema.sites.isPrimary, isActive: schema.sites.isActive, address: schema.sites.address })
      .from(schema.contractSites)
      .innerJoin(schema.sites, eq(schema.sites.id, schema.contractSites.siteId))
      .where(eq(schema.contractSites.contractId, id))
      .orderBy(asc(schema.sites.name)),
    () => ctx.tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.contractId, id)).orderBy(asc(schema.contractEntitlements.createdAt)),
    () => listScopeItems(ctx, id),
    () => ctx.tx.select({ id: c.id, number: c.number, name: c.name, status: c.status, startDate: c.startDate, endDate: c.endDate }).from(c).where(eq(c.parentContractId, id)).orderBy(asc(c.startDate)),
    async () => (contract.parentContractId ? await ctx.tx.select({ id: c.id, number: c.number, name: c.name, status: c.status, startDate: c.startDate, endDate: c.endDate }).from(c).where(eq(c.id, contract.parentContractId)).limit(1) : []),
    () => ctx.tx.select({ id: schema.attachments.id, docType: schema.attachments.docType, filename: schema.attachments.filename, title: schema.attachments.title, createdAt: schema.attachments.createdAt }).from(schema.attachments).where(and(eq(schema.attachments.entityType, 'contract'), eq(schema.attachments.entityId, id))),
    () => contractStatusOptions(ctx.tx),
    () => optionLabels(ctx.tx, [contract.typeId]),
    () => ctx.tx.select({ id: schema.slaPolicies.id, name: schema.slaPolicies.name }).from(schema.slaPolicies),
    () => ctx.tx.select({ id: schema.businessCalendars.id, name: schema.businessCalendars.name, timezone: schema.businessCalendars.timezone, is24x7: schema.businessCalendars.is24x7 }).from(schema.businessCalendars),
    () => ctx.tx.select({ id: schema.holidayCalendars.id, name: schema.holidayCalendars.name }).from(schema.holidayCalendars),
    () => ctx.tx
      .select({ open: sql<number>`count(*) filter (where ${schema.configOptions.statusCategory} in ('new','open','pending'))::int`, total: sql<number>`count(*)::int` })
      .from(schema.tickets)
      .innerJoin(schema.configOptions, eq(schema.configOptions.id, schema.tickets.statusId))
      .where(eq(schema.tickets.contractId, id)),
  ]);

  const teamIds = serviceRows.map((s) => s.cs.teamId).filter((x): x is string => !!x);
  const teams = teamIds.length ? await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(inArray(schema.teams.id, teamIds)) : [];
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const policyName = new Map(policies.map((p) => [p.id, p.name]));
  const calendarName = new Map(calendars.map((p) => [p.id, p.name]));
  const holidayName = new Map(holidayCals.map((p) => [p.id, p.name]));

  const matrix = (contract.escalationMatrix ?? []) as { level?: number; name?: string; contactId?: string | null; userId?: string | null; afterMinutes?: number | null }[];
  const contactIds = matrix.map((m) => m.contactId).filter((x): x is string => !!x);
  const contacts = contactIds.length ? await ctx.tx.select({ id: schema.contacts.id, name: schema.contacts.name, email: schema.contacts.email, phone: schema.contacts.phone, mobile: schema.contacts.mobile }).from(schema.contacts).where(inArray(schema.contacts.id, contactIds)) : [];
  const contactById = new Map(contacts.map((x) => [x.id, x]));
  const users = await userNames(ctx.tx, [contract.ownerUserId, customer?.accountManagerId, ...matrix.map((m) => m.userId)]);

  const entitlements = await decorateEntitlements(ctx.tx, entRows, new Map([[contract.id, contract]]));
  const docTypes = new Set(docs.map((d) => d.docType));

  return {
    ...contract,
    ...statusDisplay(contract.status, statusMap),
    daysToExpiry: daysToExpiry(contract.endDate),
    typeLabel: contract.typeId ? labels.get(contract.typeId)?.label ?? null : null,
    customer: customer ? { id: customer.id, code: customer.code, name: customer.name, accountManagerId: customer.accountManagerId, accountManagerName: customer.accountManagerId ? users.get(customer.accountManagerId)?.name ?? null : null } : null,
    customerName: customer?.name ?? null,
    ownerName: contract.ownerUserId ? users.get(contract.ownerUserId)?.name ?? null : null,
    slaPolicyName: contract.slaPolicyId ? policyName.get(contract.slaPolicyId) ?? null : null,
    supportHoursCalendarName: contract.supportHoursCalendarId ? calendarName.get(contract.supportHoursCalendarId) ?? null : null,
    holidayCalendarName: contract.holidayCalendarId ? holidayName.get(contract.holidayCalendarId) ?? null : null,
    services: serviceRows.map((s) => ({
      serviceId: s.cs.serviceId,
      serviceName: s.serviceName,
      serviceKey: s.serviceKey,
      domain: s.serviceDomain,
      slaPolicyId: s.cs.slaPolicyId,
      slaPolicyName: s.cs.slaPolicyId ? policyName.get(s.cs.slaPolicyId) ?? null : null,
      effectiveSlaPolicyId: s.cs.slaPolicyId ?? contract.slaPolicyId ?? s.serviceDefaultSlaPolicyId ?? null,
      effectiveSlaPolicyName: policyName.get(s.cs.slaPolicyId ?? contract.slaPolicyId ?? s.serviceDefaultSlaPolicyId ?? '') ?? null,
      teamId: s.cs.teamId,
      teamName: s.cs.teamId ? teamName.get(s.cs.teamId) ?? null : null,
      supportHoursCalendarId: s.cs.supportHoursCalendarId,
      supportHoursCalendarName: s.cs.supportHoursCalendarId ? calendarName.get(s.cs.supportHoursCalendarId) ?? null : null,
      notes: s.cs.notes,
    })),
    sites: siteRows,
    allSites: siteRows.length === 0,
    entitlements,
    scopeItems: scope.items,
    scopeGroups: scope.groups,
    escalationMatrix: matrix.map((m) => ({
      ...m,
      contactName: m.contactId ? contactById.get(m.contactId)?.name ?? null : null,
      contactEmail: m.contactId ? contactById.get(m.contactId)?.email ?? null : null,
      contactPhone: m.contactId ? contactById.get(m.contactId)?.mobile ?? contactById.get(m.contactId)?.phone ?? null : null,
      userName: m.userId ? users.get(m.userId)?.name ?? null : null,
      userEmail: m.userId ? users.get(m.userId)?.email ?? null : null,
    })),
    documents: { signedAgreement: docTypes.has('agreement'), sow: docTypes.has('sow'), count: docs.length, items: docs },
    parent: parent[0] ?? null,
    children,
    tickets: { open: ticketCounts[0]?.open ?? 0, total: ticketCounts[0]?.total ?? 0 },
  };
}

export type ContractView = Awaited<ReturnType<typeof getContract>>;

// ---------------------------------------------------------------- create / update

export async function createContract(ctx: Ctx, input: ContractCreate) {
  ctx.requireCustomer(input.customerId);
  ctx.require('contracts:manage', input.customerId);
  validateDates(input.startDate, input.endDate, input.renewalDate);
  const [customer] = await ctx.tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, input.customerId)).limit(1);
  if (!customer) throw new NotFoundError('Customer');

  const number = input.number?.trim() || (await nextContractNumber(ctx.tx, Number(input.startDate.slice(0, 4))));
  const [dup] = await ctx.tx.select({ id: c.id }).from(c).where(eq(c.number, number)).limit(1);
  if (dup) throw new ConflictError(`Contract number ${number} already exists`);
  let contract: ContractRow;
  try {
    [contract] = await ctx.tx
      .insert(c)
      .values({ ...contractValues(input), customerId: input.customerId, number, name: input.name, startDate: input.startDate, endDate: input.endDate, status: input.status ?? 'draft', autoRenew: input.autoRenew ?? false })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`Contract number ${number} was taken concurrently; please retry`);
    throw err;
  }
  if (input.services?.length) await replaceServices(ctx.tx, contract, input.services);
  if (input.siteIds?.length) await replaceSites(ctx.tx, contract, input.siteIds);
  const ents = await insertEntitlements(ctx.tx, contract, input.entitlements ?? []);
  const scope = await insertScopeItems(ctx.tx, contract, input.scopeItems ?? []);
  await ctx.audit({
    entityType: 'contract',
    entityId: contract.id,
    entityLabel: `${contract.number} ${contract.name}`,
    action: 'create',
    customerId: contract.customerId,
    metadata: { contractId: contract.id, number: contract.number, customerName: customer.name, status: contract.status, services: input.services?.length ?? 0, sites: input.siteIds?.length ?? 0, entitlements: ents.length, scopeItems: scope.length },
  });
  return getContract(ctx, contract.id);
}

export async function updateContract(ctx: Ctx, id: string, patch: ContractPatch) {
  const before = await loadContract(ctx, id);
  ctx.require('contracts:manage', before.customerId);
  const startDate = patch.startDate ?? before.startDate;
  const endDate = patch.endDate ?? before.endDate;
  validateDates(startDate, endDate, patch.renewalDate === undefined ? before.renewalDate : patch.renewalDate);
  const values = { ...contractValues(patch), updatedAt: new Date() };
  if (values.number !== undefined && values.number !== before.number) {
    const [dup] = await ctx.tx.select({ id: c.id }).from(c).where(eq(c.number, values.number)).limit(1);
    if (dup) throw new ConflictError(`Contract number ${values.number} already exists`);
  }
  const [after] = await ctx.tx.update(c).set(values).where(eq(c.id, id)).returning();
  const comparable = { ...before } as Record<string, unknown>;
  await ctx.audit({ entityType: 'contract', entityId: id, entityLabel: `${after.number} ${after.name}`, action: 'update', customerId: after.customerId, changes: diffChanges(comparable, values as Record<string, unknown>), metadata: { contractId: id } });
  return getContract(ctx, id);
}

export async function deleteContract(ctx: Ctx, id: string) {
  const row = await loadContract(ctx, id);
  ctx.require('contracts:manage', row.customerId);
  if (row.status !== 'draft') throw new ValidationError('Only draft contracts can be deleted; terminate it instead');
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(schema.tickets).where(eq(schema.tickets.contractId, id));
  if (count > 0) throw new ValidationError('Contract is referenced by tickets and cannot be deleted');
  await ctx.tx.delete(c).where(eq(c.id, id));
  await ctx.audit({ entityType: 'contract', entityId: id, entityLabel: `${row.number} ${row.name}`, action: 'delete', customerId: row.customerId, metadata: { contractId: id } });
  return { deleted: true };
}

export async function setContractServices(ctx: Ctx, id: string, services: ContractServiceInput[]) {
  const contract = await loadContract(ctx, id);
  ctx.require('contracts:manage', contract.customerId);
  const before = await ctx.tx.select().from(schema.contractServices).where(eq(schema.contractServices.contractId, id));
  await replaceServices(ctx.tx, contract, services);
  await ctx.audit({
    entityType: 'contract',
    entityId: id,
    entityLabel: `${contract.number} ${contract.name}`,
    action: 'services.update',
    customerId: contract.customerId,
    changes: { services: { old: before.map((s) => `${s.serviceId}${s.slaPolicyId ? `:sla=${s.slaPolicyId}` : ''}${s.teamId ? `:team=${s.teamId}` : ''}`), new: services.map((s) => `${s.serviceId}${s.slaPolicyId ? `:sla=${s.slaPolicyId}` : ''}${s.teamId ? `:team=${s.teamId}` : ''}`) } },
    metadata: { contractId: id },
  });
  return (await getContract(ctx, id)).services;
}

export async function setContractSites(ctx: Ctx, id: string, siteIds: string[]) {
  const contract = await loadContract(ctx, id);
  ctx.require('contracts:manage', contract.customerId);
  const before = await ctx.tx.select().from(schema.contractSites).where(eq(schema.contractSites.contractId, id));
  await replaceSites(ctx.tx, contract, siteIds);
  await ctx.audit({ entityType: 'contract', entityId: id, entityLabel: `${contract.number} ${contract.name}`, action: 'sites.update', customerId: contract.customerId, changes: { sites: { old: before.map((s) => s.siteId), new: [...new Set(siteIds)] } }, metadata: { contractId: id } });
  return (await getContract(ctx, id)).sites;
}

// ---------------------------------------------------------------- lifecycle

export async function activateContract(ctx: Ctx, id: string) {
  const contract = await loadContract(ctx, id);
  ctx.require('contracts:manage', contract.customerId);
  if (!['draft', 'expired', 'terminated'].includes(contract.status)) throw new ValidationError(`Contract is already ${contract.status}`);
  if (contract.endDate < todayStr()) throw new ValidationError('The end date has passed; extend the contract before activating it');
  const status = liveStatus(contract.endDate, await noticeWindowDays(ctx.tx, contract));
  await ctx.tx.update(c).set({ status, updatedAt: new Date() }).where(eq(c.id, id));
  await ctx.audit({ entityType: 'contract', entityId: id, entityLabel: `${contract.number} ${contract.name}`, action: 'activate', customerId: contract.customerId, changes: { status: { old: contract.status, new: status } }, metadata: { contractId: id } });
  return getContract(ctx, id);
}

export async function terminateContract(ctx: Ctx, id: string, body: { reason?: string | null; effectiveDate?: string | null }) {
  const contract = await loadContract(ctx, id);
  ctx.require('contracts:manage', contract.customerId);
  if (['terminated', 'renewed'].includes(contract.status)) throw new ValidationError(`Contract is already ${contract.status}`);
  const customFields = { ...(contract.customFields ?? {}), terminationReason: body.reason ?? null, terminatedAt: body.effectiveDate ?? todayStr(), terminatedBy: ctx.user.id };
  await ctx.tx.update(c).set({ status: 'terminated', customFields, updatedAt: new Date() }).where(eq(c.id, id));
  await ctx.audit({ entityType: 'contract', entityId: id, entityLabel: `${contract.number} ${contract.name}`, action: 'terminate', customerId: contract.customerId, changes: { status: { old: contract.status, new: 'terminated' } }, metadata: { contractId: id, reason: body.reason ?? null, effectiveDate: body.effectiveDate ?? null } });
  return getContract(ctx, id);
}

/** Creates the successor contract (copying coverage, scope and optionally entitlements) and marks this one renewed. */
export async function renewContract(ctx: Ctx, id: string, input: RenewInput) {
  const old = await loadContract(ctx, id);
  ctx.require('contracts:manage', old.customerId);
  if (['terminated', 'renewed', 'draft'].includes(old.status)) throw new ValidationError(`A ${old.status} contract cannot be renewed`);
  validateDates(input.startDate, input.endDate);
  if (input.startDate < old.startDate) throw new ValidationError('The renewal must start after the original contract started');
  const number = input.number?.trim() ?? (await nextContractNumber(ctx.tx, Number(input.startDate.slice(0, 4))));
  const [dup] = await ctx.tx.select({ id: c.id }).from(c).where(eq(c.number, number)).limit(1);
  if (dup) throw new ConflictError(`Contract number ${number} already exists`);
  const { id: _id, createdAt: _c, updatedAt: _u, status: _s, number: _n, startDate: _sd, endDate: _ed, renewalDate: _rd, signedAt: _sa, ...copy } = old;
  const [next] = await ctx.tx
    .insert(c)
    .values({ ...copy, number, name: input.name ?? old.name, startDate: input.startDate, endDate: input.endDate, status: 'draft', parentContractId: old.id, customFields: { ...(old.customFields ?? {}), renewedFrom: old.number } })
    .returning();

  const [services, sites, scope, ents] = await sequential([
    () => ctx.tx.select().from(schema.contractServices).where(eq(schema.contractServices.contractId, old.id)),
    () => ctx.tx.select().from(schema.contractSites).where(eq(schema.contractSites.contractId, old.id)),
    () => ctx.tx.select().from(schema.scopeItems).where(eq(schema.scopeItems.contractId, old.id)),
    () => ctx.tx.select().from(schema.contractEntitlements).where(and(eq(schema.contractEntitlements.contractId, old.id), eq(schema.contractEntitlements.isActive, true))),
  ]);
  if (services.length) await ctx.tx.insert(schema.contractServices).values(services.map(({ contractId: _x, ...s }) => ({ ...s, contractId: next.id })));
  if (sites.length) await ctx.tx.insert(schema.contractSites).values(sites.map(({ contractId: _x, ...s }) => ({ ...s, contractId: next.id })));
  if (scope.length) await ctx.tx.insert(schema.scopeItems).values(scope.map(({ id: _x, contractId: _y, createdAt: _z, updatedAt: _w, ...s }) => ({ ...s, contractId: next.id })));
  let carried = 0;
  if (input.carryEntitlements !== false && ents.length) {
    await ctx.tx.insert(schema.contractEntitlements).values(ents.map(({ id: _x, contractId: _y, createdAt: _z, updatedAt: _w, ...e }) => ({ ...e, quantity: String(e.quantity), contractId: next.id })));
    carried = ents.length;
  }
  await ctx.tx.update(c).set({ status: 'renewed', updatedAt: new Date() }).where(eq(c.id, old.id));

  await ctx.audit({ entityType: 'contract', entityId: old.id, entityLabel: `${old.number} ${old.name}`, action: 'renew', customerId: old.customerId, changes: { status: { old: old.status, new: 'renewed' } }, metadata: { contractId: old.id, renewedTo: next.id, renewedToNumber: next.number } });
  await ctx.audit({ entityType: 'contract', entityId: next.id, entityLabel: `${next.number} ${next.name}`, action: 'create', customerId: next.customerId, metadata: { contractId: next.id, renewedFrom: old.id, renewedFromNumber: old.number, services: services.length, sites: sites.length, scopeItems: scope.length, entitlements: carried } });
  return getContract(ctx, next.id);
}

// ---------------------------------------------------------------- history

const CHILD_ENTITY_TYPES = ['contract_entitlement', 'scope_item', 'entitlement_consumption', 'contract_service', 'contract_site', 'attachment'];

export async function contractHistory(ctx: Ctx, id: string, limit = 200) {
  await loadContract(ctx, id);
  const a = schema.auditLog;
  const rows = await ctx.tx
    .select({ id: a.id, occurredAt: a.occurredAt, userId: a.userId, userName: a.userName, entityType: a.entityType, entityId: a.entityId, entityLabel: a.entityLabel, action: a.action, changes: a.changes, source: a.source, metadata: a.metadata })
    .from(a)
    .where(or(and(eq(a.entityType, 'contract'), eq(a.entityId, id)), and(inArray(a.entityType, CHILD_ENTITY_TYPES), sql`${a.metadata}->>'contractId' = ${id}`)))
    .orderBy(desc(a.occurredAt))
    .limit(limit);
  return { items: rows, total: rows.length };
}

/** Used by the daily job and tests: the configured notice thresholds. */
export async function expiryNoticeDays(ctx: Ctx): Promise<number[]> {
  const v = await getSetting<unknown>(ctx, 'contracts.expiry_notice_days', [90, 60, 30, 7]);
  return Array.isArray(v) ? v.map(Number).filter((n) => !isNaN(n)) : [90, 60, 30, 7];
}
