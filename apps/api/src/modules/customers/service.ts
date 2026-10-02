import { eq, and, inArray, desc, asc, sql, arrayContains, type SQL } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError, ConflictError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { orderBy, searchFts } from '@/core/query';
import { invalidatePrincipal } from '@/core/principal';
import { contractStatusOptions, statusDisplay, daysToExpiry, optionLabels, userNames, todayStr, addDays, sequential } from '@/modules/contracts/common';
import { COVERING_STATUSES } from '@/modules/contracts/schemas';
import { customerEntitlements } from '@/modules/contracts/entitlements';
import { slaStateFilterSql } from '@/modules/sla/engine';
import type { CustomerCreate, CustomerPatch, CustomerListQuery, CustomerSummaryQuery } from './schemas';

const cu = schema.customers;
export type CustomerRow = typeof cu.$inferSelect;

// ---------------------------------------------------------------- helpers

/** Next `CUST-NNNN` (max existing numeric suffix + 1). */
export async function nextCustomerCode(tx: Tx) {
  const res = await tx.execute(sql`SELECT coalesce(max((substring(code from '^CUST-(\\d+)$'))::int), 0)::int AS max FROM customers WHERE code ~ '^CUST-\\d+$'`);
  const max = Number((res.rows[0] as { max: number }).max ?? 0);
  return `CUST-${String(max + 1).padStart(4, '0')}`;
}

export async function loadCustomer(ctx: Ctx, id: string): Promise<CustomerRow> {
  const [row] = await ctx.tx.select().from(cu).where(eq(cu.id, id)).limit(1);
  if (!row) throw new NotFoundError('Customer');
  ctx.requireCustomer(row.id);
  return row;
}

const CU_ID = sql`"customers"."id"`;
const openTicketsSql = (customerId: SQL) =>
  sql<number>`(select count(*) from tickets t join config_options o on o.id = t.status_id where t.customer_id = ${customerId} and o.status_category in ('new','open','pending'))::int`;
const activeContractsSql = (customerId: SQL) => sql<number>`(select count(*) from contracts k where k.customer_id = ${customerId} and k.status in ('active','expiring'))::int`;
const sitesSql = (customerId: SQL) => sql<number>`(select count(*) from sites s where s.customer_id = ${customerId} and s.is_active)::int`;

async function defaultOption(tx: Tx, type: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.isDefault, true), eq(schema.configOptions.isActive, true))).limit(1);
  return row?.id ?? null;
}

function values(input: Partial<CustomerCreate>): Partial<typeof cu.$inferInsert> {
  const v: Partial<typeof cu.$inferInsert> = {};
  (['code', 'name', 'legalName', 'industryId', 'typeId', 'statusId', 'accountManagerId', 'website', 'phone', 'email', 'address', 'timezone', 'notes', 'tags', 'customFields', 'isActive'] as const).forEach((k) => {
    if (input[k] !== undefined) (v as Record<string, unknown>)[k] = input[k];
  });
  if (v.code) v.code = v.code.toUpperCase();
  if (v.email === '') v.email = null;
  return v;
}

// ---------------------------------------------------------------- list

/** Filter conditions shared by the list and its summary (tenant visibility comes from RLS on the transaction). */
function listWhere(q: CustomerSummaryQuery): SQL | undefined {
  const conds: SQL[] = [];
  const active = q.isActive ?? 'true';
  if (active !== 'all') conds.push(eq(cu.isActive, active === 'true'));
  if (q.statusId) conds.push(eq(cu.statusId, q.statusId));
  if (q.typeId) conds.push(eq(cu.typeId, q.typeId));
  if (q.industryId) conds.push(eq(cu.industryId, q.industryId));
  if (q.accountManagerId) conds.push(eq(cu.accountManagerId, q.accountManagerId));
  if (q.tag) conds.push(arrayContains(cu.tags, [q.tag]));
  const search = searchFts(q.q, cu.searchVector, cu.name, cu.code);
  if (search) conds.push(search);
  return conds.length ? and(...conds) : undefined;
}

export async function listCustomers(ctx: Ctx, q: CustomerListQuery) {
  const where = listWhere(q);

  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(cu).where(where);
  if (q.fields === 'min') {
    const items = await ctx.tx.select({ id: cu.id, code: cu.code, name: cu.name }).from(cu).where(where).orderBy(orderBy({ name: cu.name, code: cu.code }, q.sort, q.order ?? 'asc', cu.name)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items, total: count, page: q.page, pageSize: q.pageSize };
  }
  ctx.require('customers:read');
  const openTickets = openTicketsSql(CU_ID);
  const activeContracts = activeContractsSql(CU_ID);
  const sortable = { name: cu.name, code: cu.code, createdAt: cu.createdAt, openTickets, activeContracts };
  const order = orderBy(sortable, q.sort, q.order ?? (q.sort === 'createdAt' || q.sort === 'openTickets' || q.sort === 'activeContracts' ? 'desc' : 'asc'), cu.name);
  const rows = await ctx.tx
    .select({
      id: cu.id,
      code: cu.code,
      name: cu.name,
      legalName: cu.legalName,
      industryId: cu.industryId,
      typeId: cu.typeId,
      statusId: cu.statusId,
      accountManagerId: cu.accountManagerId,
      website: cu.website,
      phone: cu.phone,
      email: cu.email,
      address: cu.address,
      timezone: cu.timezone,
      tags: cu.tags,
      isActive: cu.isActive,
      createdAt: cu.createdAt,
      updatedAt: cu.updatedAt,
      openTickets,
      activeContracts,
      sites: sitesSql(CU_ID),
    })
    .from(cu)
    .where(where)
    .orderBy(order, asc(cu.name))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const labels = await optionLabels(ctx.tx, rows.flatMap((r) => [r.industryId, r.typeId, r.statusId]));
  const managers = await userNames(ctx.tx, rows.map((r) => r.accountManagerId));
  const items = rows.map((r) => ({
    ...r,
    industryLabel: r.industryId ? labels.get(r.industryId)?.label ?? null : null,
    typeLabel: r.typeId ? labels.get(r.typeId)?.label ?? null : null,
    statusLabel: r.statusId ? labels.get(r.statusId)?.label ?? null : null,
    statusColor: r.statusId ? labels.get(r.statusId)?.color ?? null : null,
    accountManagerName: r.accountManagerId ? managers.get(r.accountManagerId)?.name ?? null : null,
  }));
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

// ---------------------------------------------------------------- summary

const OPEN_TICKET_STATUSES = sql`(select id from config_options where type = 'ticket_status' and status_category in ('new','open','pending'))`;

/** Headline numbers for the customers page: counts of the customers matching the list filters plus their open/breached tickets and contracts ending within 60 days. */
export async function customerSummary(ctx: Ctx, q: CustomerSummaryQuery) {
  ctx.require('customers:read');
  const where = listWhere(q);
  const count = sql<number>`count(*)::int`;
  const matching = ctx.tx.select({ id: cu.id }).from(cu).where(where);
  const t = schema.tickets;
  const k = schema.contracts;
  const today = todayStr();
  const [totals, byTypeRows, byStatusRows, tickets, contracts] = await sequential([
    () => ctx.tx.select({ total: count, active: sql<number>`count(*) filter (where ${cu.isActive})::int`, inactive: sql<number>`count(*) filter (where not ${cu.isActive})::int` }).from(cu).where(where),
    () => ctx.tx.select({ id: cu.typeId, count }).from(cu).where(where).groupBy(cu.typeId).orderBy(desc(count)),
    () => ctx.tx.select({ id: cu.statusId, count }).from(cu).where(where).groupBy(cu.statusId).orderBy(desc(count)),
    () => ctx.tx
      .select({
        openTickets: sql<number>`count(*) filter (where ${t.statusId} in ${OPEN_TICKET_STATUSES})::int`,
        breachedTickets: sql<number>`count(*) filter (where ${t.statusId} in ${OPEN_TICKET_STATUSES} and ${slaStateFilterSql.breached})::int`,
      })
      .from(t)
      .where(inArray(t.customerId, matching)),
    () => ctx.tx.select({ count }).from(k).where(and(inArray(k.customerId, matching), inArray(k.status, COVERING_STATUSES), sql`${k.endDate} >= ${today}::date`, sql`${k.endDate} <= ${addDays(today, 60)}::date`)),
  ]);
  const labels = await optionLabels(ctx.tx, [...byTypeRows.map((r) => r.id), ...byStatusRows.map((r) => r.id)]);
  const bucket = (rows: { id: string | null; count: number }[]) =>
    rows.map((r) => {
      const opt = r.id ? labels.get(r.id) : undefined;
      return { id: r.id, key: opt?.key ?? null, label: opt?.label ?? 'Unset', color: opt?.color ?? null, count: r.count };
    });
  return {
    total: totals[0]?.total ?? 0,
    active: totals[0]?.active ?? 0,
    inactive: totals[0]?.inactive ?? 0,
    byType: bucket(byTypeRows),
    byStatus: bucket(byStatusRows),
    openTickets: tickets[0]?.openTickets ?? 0,
    breachedTickets: tickets[0]?.breachedTickets ?? 0,
    contractsExpiring60: contracts[0]?.count ?? 0,
  };
}

// ---------------------------------------------------------------- get

export async function customerCounts(tx: Tx, id: string) {
  const idSql = sql`${id}::uuid`;
  const [row] = await tx
    .select({
      sites: sitesSql(idSql),
      contacts: sql<number>`(select count(*) from contacts x where x.customer_id = ${idSql} and x.is_active)::int`,
      openTickets: openTicketsSql(idSql),
      totalTickets: sql<number>`(select count(*) from tickets t where t.customer_id = ${idSql})::int`,
      activeContracts: activeContractsSql(idSql),
      contracts: sql<number>`(select count(*) from contracts k where k.customer_id = ${idSql})::int`,
      assets: sql<number>`(select count(*) from assets a where a.customer_id = ${idSql})::int`,
      cis: sql<number>`(select count(*) from cis c where c.customer_id = ${idSql})::int`,
      users: sql<number>`(select count(*) from users u where u.customer_id = ${idSql})::int`,
    })
    .from(sql`(select 1) as one`);
  return row;
}

export async function getCustomer(ctx: Ctx, id: string) {
  ctx.require('customers:read', id);
  const row = await loadCustomer(ctx, id);
  const [labels, managers, counts, teams] = await sequential([
    () => optionLabels(ctx.tx, [row.industryId, row.typeId, row.statusId]),
    () => userNames(ctx.tx, [row.accountManagerId]),
    () => customerCounts(ctx.tx, id),
    () => getCustomerTeams(ctx, id),
  ]);
  return {
    ...row,
    industryLabel: row.industryId ? labels.get(row.industryId)?.label ?? null : null,
    typeLabel: row.typeId ? labels.get(row.typeId)?.label ?? null : null,
    statusLabel: row.statusId ? labels.get(row.statusId)?.label ?? null : null,
    statusColor: row.statusId ? labels.get(row.statusId)?.color ?? null : null,
    accountManagerName: row.accountManagerId ? managers.get(row.accountManagerId)?.name ?? null : null,
    accountManagerEmail: row.accountManagerId ? managers.get(row.accountManagerId)?.email ?? null : null,
    counts,
    teams,
  };
}

// ---------------------------------------------------------------- create / update / delete

export async function createCustomer(ctx: Ctx, input: CustomerCreate) {
  ctx.require('customers:manage');
  const code = (input.code?.trim() || (await nextCustomerCode(ctx.tx))).toUpperCase();
  const [dup] = await ctx.tx.select({ id: cu.id }).from(cu).where(eq(cu.code, code)).limit(1);
  if (dup) throw new ConflictError(`Customer code ${code} already exists`);
  const v = values(input);
  const [row] = await ctx.tx
    .insert(cu)
    .values({
      ...v,
      code,
      name: input.name,
      typeId: input.typeId === undefined ? await defaultOption(ctx.tx, 'customer_type') : input.typeId,
      statusId: input.statusId === undefined ? await defaultOption(ctx.tx, 'customer_status') : input.statusId,
      timezone: input.timezone ?? 'Asia/Kolkata',
      isActive: input.isActive ?? true,
    })
    .returning();
  // Customer-scoped principals cannot see the new row yet; refresh their scope on next request.
  invalidatePrincipal(ctx.user.id);
  await ctx.audit({ entityType: 'customer', entityId: row.id, entityLabel: `${row.code} ${row.name}`, action: 'create', customerId: row.id, metadata: { code: row.code } });
  return getCustomer(ctx, row.id);
}

export async function updateCustomer(ctx: Ctx, id: string, patch: CustomerPatch) {
  const before = await loadCustomer(ctx, id);
  ctx.require('customers:manage', id);
  const v = { ...values(patch), updatedAt: new Date() };
  if (v.code && v.code !== before.code) {
    const [dup] = await ctx.tx.select({ id: cu.id }).from(cu).where(eq(cu.code, v.code)).limit(1);
    if (dup) throw new ConflictError(`Customer code ${v.code} already exists`);
  }
  const [after] = await ctx.tx.update(cu).set(v).where(eq(cu.id, id)).returning();
  await ctx.audit({ entityType: 'customer', entityId: id, entityLabel: `${after.code} ${after.name}`, action: 'update', customerId: id, changes: diffChanges(before as Record<string, unknown>, v as Record<string, unknown>) });
  return getCustomer(ctx, id);
}

export async function deactivateCustomer(ctx: Ctx, id: string, reason?: string | null) {
  const before = await loadCustomer(ctx, id);
  ctx.require('customers:manage', id);
  await ctx.tx.update(cu).set({ isActive: false, updatedAt: new Date() }).where(eq(cu.id, id));
  await ctx.audit({ entityType: 'customer', entityId: id, entityLabel: `${before.code} ${before.name}`, action: 'deactivate', customerId: id, changes: { isActive: { old: before.isActive, new: false } }, metadata: { reason: reason ?? null } });
  return getCustomer(ctx, id);
}

export async function reactivateCustomer(ctx: Ctx, id: string) {
  const before = await loadCustomer(ctx, id);
  ctx.require('customers:manage', id);
  await ctx.tx.update(cu).set({ isActive: true, updatedAt: new Date() }).where(eq(cu.id, id));
  await ctx.audit({ entityType: 'customer', entityId: id, entityLabel: `${before.code} ${before.name}`, action: 'reactivate', customerId: id, changes: { isActive: { old: before.isActive, new: true } } });
  return getCustomer(ctx, id);
}

/** Hard delete: only when nothing operational references the customer; otherwise deactivate. */
export async function deleteCustomer(ctx: Ctx, id: string) {
  const before = await loadCustomer(ctx, id);
  ctx.require('customers:manage', id);
  const counts = await customerCounts(ctx.tx, id);
  if (counts.totalTickets > 0 || counts.contracts > 0) {
    throw new ValidationError(`Customer has ${counts.totalTickets} tickets and ${counts.contracts} contracts; deactivate it instead of deleting`);
  }
  await ctx.tx.delete(cu).where(eq(cu.id, id));
  invalidatePrincipal();
  await ctx.audit({ entityType: 'customer', entityId: id, entityLabel: `${before.code} ${before.name}`, action: 'delete', customerId: null, metadata: { code: before.code, name: before.name } });
  return { deleted: true };
}

// ---------------------------------------------------------------- 360 overview

export async function customerOverview(ctx: Ctx, id: string) {
  ctx.require('customers:read', id);
  const customer = await loadCustomer(ctx, id);
  const t = schema.tickets;
  const o = schema.configOptions;
  const now = new Date();
  const today = todayStr(now);
  const in30 = addDays(today, 30);

  const [byCategory, byPriority, recentTickets, contracts, entitlements, sla, activity, visits, pm, counts, statusMap] = await sequential([
    () => ctx.tx
      .select({ category: o.statusCategory, count: sql<number>`count(*)::int` })
      .from(t)
      .innerJoin(o, eq(o.id, t.statusId))
      .where(eq(t.customerId, id))
      .groupBy(o.statusCategory),
    () => ctx.tx.execute(sql`
      select p.id, p.label, p.color, p.level, count(*)::int as count
      from tickets t join config_options s on s.id = t.status_id left join config_options p on p.id = t.priority_id
      where t.customer_id = ${id}::uuid and s.status_category in ('new','open','pending')
      group by p.id, p.label, p.color, p.level order by p.level nulls last, p.label`),
    () => ctx.tx.execute(sql`
      select t.id, t.number, t.type, t.title, t.created_at as "createdAt", t.updated_at as "updatedAt", s.label as "statusLabel", s.color as "statusColor", s.status_category as "statusCategory", p.label as "priorityLabel", p.color as "priorityColor"
      from tickets t join config_options s on s.id = t.status_id left join config_options p on p.id = t.priority_id
      where t.customer_id = ${id}::uuid order by t.created_at desc limit 10`),
    () => ctx.tx
      .select({ id: schema.contracts.id, number: schema.contracts.number, name: schema.contracts.name, status: schema.contracts.status, startDate: schema.contracts.startDate, endDate: schema.contracts.endDate, renewalDate: schema.contracts.renewalDate, typeId: schema.contracts.typeId })
      .from(schema.contracts)
      .where(eq(schema.contracts.customerId, id))
      .orderBy(asc(schema.contracts.endDate)),
    () => customerEntitlements(ctx, id),
    () => ctx.tx
      .select({
        met: sql<number>`count(*) filter (where ${schema.ticketSlas.state} = 'met')::int`,
        breached: sql<number>`count(*) filter (where ${schema.ticketSlas.state} = 'breached')::int`,
      })
      .from(schema.ticketSlas)
      .where(and(eq(schema.ticketSlas.customerId, id), sql`${schema.ticketSlas.completedAt} >= now() - interval '30 days'`)),
    () => ctx.tx
      .select({ id: schema.auditLog.id, occurredAt: schema.auditLog.occurredAt, userName: schema.auditLog.userName, entityType: schema.auditLog.entityType, entityId: schema.auditLog.entityId, entityLabel: schema.auditLog.entityLabel, action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.customerId, id))
      .orderBy(desc(schema.auditLog.occurredAt))
      .limit(10),
    () => ctx.tx
      .select({ id: schema.fieldVisits.id, number: schema.fieldVisits.number, title: schema.fieldVisits.title, status: schema.fieldVisits.status, scheduledStart: schema.fieldVisits.scheduledStart, scheduledEnd: schema.fieldVisits.scheduledEnd, engineerName: schema.users.name, siteName: schema.sites.name })
      .from(schema.fieldVisits)
      .leftJoin(schema.users, eq(schema.users.id, schema.fieldVisits.engineerId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.fieldVisits.siteId))
      .where(and(eq(schema.fieldVisits.customerId, id), inArray(schema.fieldVisits.status, ['requested', 'scheduled', 'in_progress']), sql`${schema.fieldVisits.scheduledStart} >= now() - interval '1 day'`, sql`${schema.fieldVisits.scheduledStart} <= now() + interval '30 days'`))
      .orderBy(asc(schema.fieldVisits.scheduledStart))
      .limit(10),
    () => ctx.tx
      .select({ id: schema.pmOccurrences.id, programId: schema.pmOccurrences.programId, programName: schema.pmPrograms.name, plannedDate: schema.pmOccurrences.plannedDate, scheduledDate: schema.pmOccurrences.scheduledDate, status: schema.pmOccurrences.status, siteName: schema.sites.name })
      .from(schema.pmOccurrences)
      .innerJoin(schema.pmPrograms, eq(schema.pmPrograms.id, schema.pmOccurrences.programId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.pmPrograms.siteId))
      .where(and(eq(schema.pmOccurrences.customerId, id), inArray(schema.pmOccurrences.status, ['planned', 'scheduled']), sql`${schema.pmOccurrences.plannedDate} >= ${today}::date`, sql`${schema.pmOccurrences.plannedDate} <= ${in30}::date`))
      .orderBy(asc(schema.pmOccurrences.plannedDate))
      .limit(10),
    () => customerCounts(ctx.tx, id),
    () => contractStatusOptions(ctx.tx),
  ]);
  const typeLabels = await optionLabels(ctx.tx, contracts.map((k) => k.typeId));
  const met = sla[0]?.met ?? 0;
  const breached = sla[0]?.breached ?? 0;
  const nextVisit = visits[0] ?? null;
  const nextPm = pm[0] ?? null;
  return {
    customer: { id: customer.id, code: customer.code, name: customer.name },
    counts,
    ticketsByStatusCategory: Object.fromEntries(byCategory.map((r) => [r.category ?? 'unknown', r.count])),
    ticketsByPriority: (byPriority.rows as { id: string | null; label: string | null; color: string | null; level: number | null; count: number }[]).map((r) => ({ priorityId: r.id, label: r.label ?? 'Unset', color: r.color, level: r.level, count: Number(r.count) })),
    recentTickets: recentTickets.rows,
    contracts: contracts.map((k) => ({ ...k, ...statusDisplay(k.status, statusMap), typeLabel: k.typeId ? typeLabels.get(k.typeId)?.label ?? null : null, daysToExpiry: daysToExpiry(k.endDate, now), covering: (COVERING_STATUSES as string[]).includes(k.status) })),
    entitlements,
    sla30d: { met, breached, compliancePct: met + breached > 0 ? Math.round((met / (met + breached)) * 1000) / 10 : null },
    recentActivity: activity,
    upcomingVisits: visits,
    upcomingPm: pm,
    next: { visit: nextVisit, pm: nextPm },
  };
}

// ---------------------------------------------------------------- teams / users / documents

export async function getCustomerTeams(ctx: Ctx, id: string) {
  ctx.requireCustomer(id);
  return ctx.tx
    .select({ id: schema.teams.id, key: schema.teams.key, name: schema.teams.name, teamType: schema.teams.teamType, isActive: schema.teams.isActive, email: schema.teams.email })
    .from(schema.customerTeams)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.customerTeams.teamId))
    .where(eq(schema.customerTeams.customerId, id))
    .orderBy(asc(schema.teams.name));
}

export async function setCustomerTeams(ctx: Ctx, id: string, teamIds: string[]) {
  const customer = await loadCustomer(ctx, id);
  ctx.require('customers:manage', id);
  const unique = [...new Set(teamIds)];
  if (unique.length) {
    const found = await ctx.tx.select({ id: schema.teams.id }).from(schema.teams).where(inArray(schema.teams.id, unique));
    if (found.length !== unique.length) throw new ValidationError('One or more teams do not exist');
  }
  const before = await ctx.tx.select({ teamId: schema.customerTeams.teamId }).from(schema.customerTeams).where(eq(schema.customerTeams.customerId, id));
  await ctx.tx.delete(schema.customerTeams).where(eq(schema.customerTeams.customerId, id));
  if (unique.length) await ctx.tx.insert(schema.customerTeams).values(unique.map((teamId) => ({ customerId: id, teamId })));
  // Team assignments drive customer visibility for team members.
  invalidatePrincipal();
  await ctx.audit({ entityType: 'customer', entityId: id, entityLabel: `${customer.code} ${customer.name}`, action: 'teams.update', customerId: id, changes: { teams: { old: before.map((b) => b.teamId), new: unique } } });
  return getCustomerTeams(ctx, id);
}

export async function customerUsers(ctx: Ctx, id: string) {
  ctx.require('customers:read', id);
  await loadCustomer(ctx, id);
  const rows = await ctx.tx
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, phone: schema.users.phone, title: schema.users.title, status: schema.users.status, lastLoginAt: schema.users.lastLoginAt, createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(and(eq(schema.users.customerId, id), eq(schema.users.userType, 'customer')))
    .orderBy(asc(schema.users.name));
  const ids = rows.map((r) => r.id);
  const roles = ids.length
    ? await ctx.tx.select({ userId: schema.userRoles.userId, key: schema.roles.key, name: schema.roles.name }).from(schema.userRoles).innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId)).where(inArray(schema.userRoles.userId, ids))
    : [];
  return rows.map((u) => ({ ...u, roles: roles.filter((r) => r.userId === u.id).map((r) => ({ key: r.key, name: r.name })) }));
}

export async function customerDocuments(ctx: Ctx, id: string) {
  ctx.require('customers:read', id);
  await loadCustomer(ctx, id);
  const rows = await ctx.tx
    .select({ id: schema.attachments.id, filename: schema.attachments.filename, title: schema.attachments.title, docType: schema.attachments.docType, contentType: schema.attachments.contentType, size: schema.attachments.size, customerVisible: schema.attachments.customerVisible, expiresAt: schema.attachments.expiresAt, uploadedBy: schema.attachments.uploadedBy, createdAt: schema.attachments.createdAt })
    .from(schema.attachments)
    .where(and(eq(schema.attachments.entityType, 'customer'), eq(schema.attachments.entityId, id)))
    .orderBy(desc(schema.attachments.createdAt));
  const names = await userNames(ctx.tx, rows.map((r) => r.uploadedBy));
  return { items: rows.map((r) => ({ ...r, uploadedByName: r.uploadedBy ? names.get(r.uploadedBy)?.name ?? null : null })), total: rows.length };
}

/** Latest tickets of a customer (used by the customer page until the tickets module exposes richer views). */
export async function customerTickets(ctx: Ctx, id: string, limit = 20) {
  ctx.require('customers:read', id);
  await loadCustomer(ctx, id);
  const res = await ctx.tx.execute(sql`
    select t.id, t.number, t.type, t.title, t.created_at as "createdAt", t.updated_at as "updatedAt", t.last_activity_at as "lastActivityAt", s.label as "statusLabel", s.color as "statusColor", s.status_category as "statusCategory", p.label as "priorityLabel", p.color as "priorityColor", u.name as "assigneeName", sv.name as "serviceName"
    from tickets t join config_options s on s.id = t.status_id left join config_options p on p.id = t.priority_id left join users u on u.id = t.assignee_id left join services sv on sv.id = t.service_id
    where t.customer_id = ${id}::uuid order by t.last_activity_at desc limit ${limit}`);
  return { items: res.rows, total: res.rows.length };
}

