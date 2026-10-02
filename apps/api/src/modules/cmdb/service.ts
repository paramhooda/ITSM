import { and, asc, desc, eq, ilike, inArray, isNull, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { CI_STATUSES } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema, type Tx } from '@/db/client';
import { ConflictError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { searchFts, orderBy, limitOffset } from '@/core/query';
import { parseCsv, headerIndex, rowValue, CSV_LIMITS } from '@/modules/assets/csv';
import { q as rawRows, one as rawOne, num, pct, asDate } from '@/modules/dashboards/common';
import { validateAttributes } from './attributes';
import { buildGraph, buildImpact, buildDependencyMap, openTicketSummary } from './graph';
import { normaliseMac } from './match';
import { CI_CRITICALITIES, CI_ENVIRONMENTS, CI_IMPORT_COLUMNS, type CiBulkInput, type CiCreateInput, type CiListQuery, type CiPatchInput, type InterfaceInput } from './schemas';

const { cis, ciTypes, ciRelationships, ciRelationshipTypes, ciInterfaces, ciServices, customers, sites, teams, assets, services, tickets, ticketCis, configOptions, auditLog } = schema;

// ---------------------------------------------------------------- types

export async function listTypes(ctx: Ctx) {
  const [types, relTypes] = await Promise.all([
    ctx.tx.select().from(ciTypes).where(eq(ciTypes.isActive, true)).orderBy(asc(ciTypes.sortOrder), asc(ciTypes.name)),
    ctx.tx.select().from(ciRelationshipTypes).where(eq(ciRelationshipTypes.isActive, true)).orderBy(asc(ciRelationshipTypes.name)),
  ]);
  return { types, relationshipTypes: relTypes };
}

async function typeById(tx: Tx, id: string) {
  const [t] = await tx.select().from(ciTypes).where(eq(ciTypes.id, id)).limit(1);
  if (!t) throw new ValidationError('Unknown CI type');
  return t;
}

export async function typeByKey(tx: Tx, key: string) {
  const [t] = await tx.select().from(ciTypes).where(eq(ciTypes.key, key)).limit(1);
  return t ?? null;
}

async function loadCi(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(cis).where(eq(cis.id, id)).limit(1);
  if (!row) throw new NotFoundError('Configuration item');
  ctx.requireCustomer(row.customerId);
  return row;
}

// ---------------------------------------------------------------- list

const relCount = sql<number>`(select count(*)::int from ${ciRelationships} r where r.source_ci_id = ${cis.id} or r.target_ci_id = ${cis.id})`;
const relExists = sql`exists (select 1 from ${ciRelationships} r where r.source_ci_id = ${cis.id} or r.target_ci_id = ${cis.id})`;
export const STALE_DAYS = 30;
/** A discovered CI not seen for STALE_DAYS (or never): the single definition used by list filters, summary and overview. */
const staleCond = () => sql`(${cis.discoverySource} is not null and (${cis.lastSeenAt} is null or ${cis.lastSeenAt} < now() - make_interval(days => ${STALE_DAYS})))`;

export async function listCis(ctx: Ctx, q: CiListQuery) {
  return q.fields === 'min' ? listCisMin(ctx, q) : listCisFull(ctx, q);
}

function buildCiWhere(ctx: Ctx, q: CiListQuery) {
  const conds: (SQL | undefined)[] = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(cis.customerId, q.customerId));
  }
  if (q.siteId) conds.push(eq(cis.siteId, q.siteId));
  if (q.typeId) conds.push(eq(cis.typeId, q.typeId));
  if (q.typeKey) conds.push(inArray(cis.typeId, ctx.tx.select({ id: ciTypes.id }).from(ciTypes).where(inArray(ciTypes.key, q.typeKey.split(',')))));
  if (q.status) conds.push(eq(cis.status, q.status));
  if (q.environment) conds.push(eq(cis.environment, q.environment));
  if (q.criticality) conds.push(eq(cis.criticality, q.criticality));
  if (q.ownerTeamId) conds.push(eq(cis.ownerTeamId, q.ownerTeamId));
  if (q.hasAsset === true) conds.push(isNotNull(cis.assetId));
  if (q.hasAsset === false) conds.push(isNull(cis.assetId));
  if (q.serviceId) conds.push(inArray(cis.id, ctx.tx.select({ id: ciServices.ciId }).from(ciServices).where(eq(ciServices.serviceId, q.serviceId))));
  if (q.tag) conds.push(sql`${q.tag} = any(${cis.tags})`);
  if (q.stale === true) conds.push(staleCond());
  if (q.stale === false) conds.push(sql`not (${staleCond()})`);
  if (q.discovered === true) conds.push(isNotNull(cis.discoverySource));
  if (q.discovered === false) conds.push(isNull(cis.discoverySource));
  if (q.withoutRelationships === true) conds.push(sql`not ${relExists}`);
  if (q.withoutRelationships === false) conds.push(relExists);
  if (q.unowned === true) conds.push(isNull(cis.ownerTeamId));
  if (q.unowned === false) conds.push(isNotNull(cis.ownerTeamId));
  if (q.q) conds.push(searchFts(q.q, cis.searchVector, cis.hostname, cis.ipAddress, cis.name, cis.serialNumber));
  const where = and(...conds.filter((c): c is SQL => !!c));
  const critOrder = sql`case ${cis.criticality} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;
  const sortable = { name: cis.name, hostname: cis.hostname, ipAddress: cis.ipAddress, typeName: ciTypes.name, updatedAt: cis.updatedAt, lastSeenAt: cis.lastSeenAt, createdAt: cis.createdAt, customer: customers.name, criticality: critOrder };
  const order = orderBy(sortable, q.sort, q.order ?? (q.sort ? 'asc' : 'desc'), cis.updatedAt);
  return { where, order, ...limitOffset(q) };
}

async function countCis(ctx: Ctx, where: SQL | undefined) {
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(cis).leftJoin(customers, eq(customers.id, cis.customerId)).innerJoin(ciTypes, eq(ciTypes.id, cis.typeId)).where(where);
  return count;
}

/** Compact rows for pickers. */
export async function listCisMin(ctx: Ctx, q: CiListQuery) {
  const { where, order, limit, offset } = buildCiWhere(ctx, q);
  const count = await countCis(ctx, where);
  const items = await ctx.tx
    .select({ id: cis.id, name: cis.name, hostname: cis.hostname, ipAddress: cis.ipAddress, typeKey: ciTypes.key, typeName: ciTypes.name, typeColor: ciTypes.color, status: cis.status, customerId: cis.customerId })
    .from(cis)
    .innerJoin(ciTypes, eq(ciTypes.id, cis.typeId))
    .leftJoin(customers, eq(customers.id, cis.customerId))
    .where(where)
    .orderBy(order)
    .limit(limit)
    .offset(offset);
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

export async function listCisFull(ctx: Ctx, q: CiListQuery) {
  const { where, order, limit, offset } = buildCiWhere(ctx, q);
  const count = await countCis(ctx, where);
  const items = await ctx.tx
    .select({
      id: cis.id,
      customerId: cis.customerId,
      customerName: customers.name,
      siteId: cis.siteId,
      siteName: sites.name,
      typeId: cis.typeId,
      typeKey: ciTypes.key,
      typeName: ciTypes.name,
      typeIcon: ciTypes.icon,
      typeColor: ciTypes.color,
      name: cis.name,
      hostname: cis.hostname,
      ipAddress: cis.ipAddress,
      serialNumber: cis.serialNumber,
      manufacturer: cis.manufacturer,
      model: cis.model,
      environment: cis.environment,
      criticality: cis.criticality,
      status: cis.status,
      ownerTeamId: cis.ownerTeamId,
      ownerTeamName: teams.name,
      assetId: cis.assetId,
      assetTag: assets.tag,
      lastSeenAt: cis.lastSeenAt,
      discoverySource: cis.discoverySource,
      tags: cis.tags,
      relationshipCount: relCount,
      updatedAt: cis.updatedAt,
      createdAt: cis.createdAt,
    })
    .from(cis)
    .innerJoin(ciTypes, eq(ciTypes.id, cis.typeId))
    .leftJoin(customers, eq(customers.id, cis.customerId))
    .leftJoin(sites, eq(sites.id, cis.siteId))
    .leftJoin(teams, eq(teams.id, cis.ownerTeamId))
    .leftJoin(assets, eq(assets.id, cis.assetId))
    .where(where)
    .orderBy(order)
    .limit(limit)
    .offset(offset);
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

// ---------------------------------------------------------------- get

const OPEN = ['new', 'open', 'pending'] as const;

export async function listRelationships(tx: Tx, ciId: string) {
  const other = alias(cis, 'other_ci');
  const otherType = alias(ciTypes, 'other_type');
  const base = {
    id: ciRelationships.id,
    typeId: ciRelationships.typeId,
    typeKey: ciRelationshipTypes.key,
    typeName: ciRelationshipTypes.name,
    inverseName: ciRelationshipTypes.inverseName,
    impactDirection: ciRelationshipTypes.impactDirection,
    description: ciRelationships.description,
    source: ciRelationships.source,
    createdAt: ciRelationships.createdAt,
    ci: { id: other.id, name: other.name, typeKey: otherType.key, typeName: otherType.name, typeColor: otherType.color, status: other.status, criticality: other.criticality },
  };
  const outbound = await tx
    .select(base)
    .from(ciRelationships)
    .innerJoin(ciRelationshipTypes, eq(ciRelationshipTypes.id, ciRelationships.typeId))
    .innerJoin(other, eq(other.id, ciRelationships.targetCiId))
    .innerJoin(otherType, eq(otherType.id, other.typeId))
    .where(eq(ciRelationships.sourceCiId, ciId))
    .orderBy(asc(ciRelationshipTypes.name), asc(other.name));
  const inbound = await tx
    .select(base)
    .from(ciRelationships)
    .innerJoin(ciRelationshipTypes, eq(ciRelationshipTypes.id, ciRelationships.typeId))
    .innerJoin(other, eq(other.id, ciRelationships.sourceCiId))
    .innerJoin(otherType, eq(otherType.id, other.typeId))
    .where(eq(ciRelationships.targetCiId, ciId))
    .orderBy(asc(ciRelationshipTypes.inverseName), asc(other.name));
  return { outbound, inbound };
}

export async function getCi(ctx: Ctx, id: string) {
  const ci = await loadCi(ctx, id);
  const [meta] = await ctx.tx
    .select({ customerName: customers.name, customerCode: customers.code, siteName: sites.name, ownerTeamName: teams.name })
    .from(cis)
    .leftJoin(customers, eq(customers.id, cis.customerId))
    .leftJoin(sites, eq(sites.id, cis.siteId))
    .leftJoin(teams, eq(teams.id, cis.ownerTeamId))
    .where(eq(cis.id, id))
    .limit(1);
  const type = await typeById(ctx.tx, ci.typeId);
  const [asset] = ci.assetId ? await ctx.tx.select({ id: assets.id, tag: assets.tag, name: assets.name, serialNumber: assets.serialNumber, warrantyEnd: assets.warrantyEnd, amcEnd: assets.amcEnd, lifecycleStage: assets.lifecycleStage }).from(assets).where(eq(assets.id, ci.assetId)).limit(1) : [];
  const svcRows = await ctx.tx.select({ id: services.id, key: services.key, name: services.name, domain: services.domain }).from(ciServices).innerJoin(services, eq(services.id, ciServices.serviceId)).where(eq(ciServices.ciId, id)).orderBy(asc(services.name));
  const interfaces = await ctx.tx.select().from(ciInterfaces).where(eq(ciInterfaces.ciId, id)).orderBy(asc(ciInterfaces.ifIndex), asc(ciInterfaces.name));
  const rels = await listRelationships(ctx.tx, id);

  const ticketStatus = alias(configOptions, 'ticket_status');
  const linked = ctx.tx.select({ id: ticketCis.ticketId }).from(ticketCis).where(eq(ticketCis.ciId, id));
  const ticketRows = await ctx.tx
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, type: tickets.type, status: ticketStatus.label, statusColor: ticketStatus.color, statusCategory: ticketStatus.statusCategory, createdAt: tickets.createdAt })
    .from(tickets)
    .innerJoin(ticketStatus, eq(ticketStatus.id, tickets.statusId))
    .where(and(or(eq(tickets.primaryCiId, id), inArray(tickets.id, linked)), or(inArray(ticketStatus.statusCategory, [...OPEN]), eq(tickets.type, 'change'))))
    .orderBy(desc(tickets.createdAt))
    .limit(100);
  const openTickets = ticketRows.filter((t) => t.statusCategory && (OPEN as readonly string[]).includes(t.statusCategory));
  const recentChanges = ticketRows.filter((t) => t.type === 'change').slice(0, 20);

  return {
    ...ci,
    ...meta,
    type: { id: type.id, key: type.key, name: type.name, icon: type.icon, color: type.color },
    attributeSchema: type.attributeSchema,
    asset: asset ?? null,
    services: svcRows,
    interfaces,
    relationships: rels,
    relationshipCount: rels.inbound.length + rels.outbound.length,
    openTickets,
    recentChanges,
  };
}

// ---------------------------------------------------------------- create / update / delete

async function validateRefs(ctx: Ctx, customerId: string, input: Partial<CiCreateInput>) {
  if (input.siteId) {
    const [s] = await ctx.tx.select({ id: sites.id }).from(sites).where(and(eq(sites.id, input.siteId), eq(sites.customerId, customerId))).limit(1);
    if (!s) throw new ValidationError('Site does not belong to this customer');
  }
  if (input.ownerTeamId) {
    const [t] = await ctx.tx.select({ id: teams.id }).from(teams).where(eq(teams.id, input.ownerTeamId)).limit(1);
    if (!t) throw new ValidationError('Unknown owner team');
  }
  if (input.assetId) {
    const [a] = await ctx.tx.select({ id: assets.id, ciId: assets.ciId }).from(assets).where(and(eq(assets.id, input.assetId), eq(assets.customerId, customerId))).limit(1);
    if (!a) throw new ValidationError('Asset does not belong to this customer');
  }
  if (input.serviceIds?.length) {
    const rows = await ctx.tx.select({ id: services.id }).from(services).where(inArray(services.id, input.serviceIds));
    if (rows.length !== new Set(input.serviceIds).size) throw new ValidationError('One or more services do not exist');
  }
}

const normaliseInput = <T extends Partial<CiCreateInput>>(input: T): T => ({
  ...input,
  ...(input.hostname !== undefined ? { hostname: input.hostname?.trim().toLowerCase() || null } : {}),
  ...(input.fqdn !== undefined ? { fqdn: input.fqdn?.trim().toLowerCase() || null } : {}),
  ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress?.trim() || null } : {}),
  ...(input.macAddress !== undefined ? { macAddress: normaliseMac(input.macAddress) } : {}),
  ...(input.serialNumber !== undefined ? { serialNumber: input.serialNumber?.trim() || null } : {}),
});

export async function createCi(ctx: Ctx, raw: CiCreateInput) {
  ctx.requireCustomer(raw.customerId);
  ctx.require('cmdb:manage', raw.customerId);
  const input = normaliseInput(raw);
  await validateRefs(ctx, input.customerId, input);
  const type = await typeById(ctx.tx, input.typeId);
  const attributes = validateAttributes(type.attributeSchema, input.attributes);
  const { serviceIds, ...rest } = input;
  const [row] = await ctx.tx.insert(cis).values({ ...rest, attributes } as typeof cis.$inferInsert).returning();
  if (serviceIds?.length) await ctx.tx.insert(ciServices).values(serviceIds.map((serviceId) => ({ ciId: row.id, serviceId, customerId: row.customerId })));
  if (input.assetId) await ctx.tx.update(assets).set({ ciId: row.id, updatedAt: new Date() }).where(eq(assets.id, input.assetId));
  await ctx.audit({ entityType: 'ci', entityId: row.id, entityLabel: row.name, action: 'create', customerId: row.customerId, metadata: { typeKey: type.key } });
  return getCi(ctx, row.id);
}

export async function updateCi(ctx: Ctx, id: string, raw: CiPatchInput) {
  const before = await loadCi(ctx, id);
  ctx.require('cmdb:manage', before.customerId);
  const patch = normaliseInput(raw);
  await validateRefs(ctx, before.customerId, patch);
  const type = await typeById(ctx.tx, patch.typeId ?? before.typeId);
  const { serviceIds, attributes, ...rest } = patch;
  const set: Record<string, unknown> = { ...rest };
  if (attributes !== undefined || patch.typeId) {
    const merged = { ...before.attributes, ...(attributes ?? {}) };
    set.attributes = validateAttributes(type.attributeSchema, merged, { partial: true });
  }
  const [after] = await ctx.tx.update(cis).set({ ...set, updatedAt: new Date() } as never).where(eq(cis.id, id)).returning();
  if (serviceIds) {
    await ctx.tx.delete(ciServices).where(eq(ciServices.ciId, id));
    if (serviceIds.length) await ctx.tx.insert(ciServices).values(serviceIds.map((serviceId) => ({ ciId: id, serviceId, customerId: before.customerId })));
  }
  if (patch.assetId !== undefined && patch.assetId !== before.assetId) {
    if (before.assetId) await ctx.tx.update(assets).set({ ciId: null }).where(and(eq(assets.id, before.assetId), eq(assets.ciId, id)));
    if (patch.assetId) await ctx.tx.update(assets).set({ ciId: id, updatedAt: new Date() }).where(eq(assets.id, patch.assetId));
  }
  const changes = diffChanges(before as Record<string, unknown>, set);
  if (serviceIds) changes.services = { old: null, new: serviceIds };
  if (Object.keys(changes).length) await ctx.audit({ entityType: 'ci', entityId: id, entityLabel: after.name, action: 'update', customerId: after.customerId, changes });
  return getCi(ctx, id);
}

export async function deleteCi(ctx: Ctx, id: string) {
  const ci = await loadCi(ctx, id);
  ctx.require('cmdb:manage', ci.customerId);
  const [{ count }] = await ctx.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(tickets)
    .where(or(eq(tickets.primaryCiId, id), inArray(tickets.id, ctx.tx.select({ id: ticketCis.ticketId }).from(ticketCis).where(eq(ticketCis.ciId, id)))));
  if (count > 0) throw new ConflictError(`CI is referenced by ${count} ticket(s). Set its status to retired instead of deleting.`);
  if (ci.assetId) await ctx.tx.update(assets).set({ ciId: null }).where(and(eq(assets.id, ci.assetId), eq(assets.ciId, id)));
  await ctx.tx.delete(cis).where(eq(cis.id, id));
  await ctx.audit({ entityType: 'ci', entityId: id, entityLabel: ci.name, action: 'delete', customerId: ci.customerId });
  return { deleted: true };
}

// ---------------------------------------------------------------- relationships

/** Creates a relationship if it does not already exist (either direction for symmetric types). Returns the row or null when it existed. */
export async function ensureRelationship(tx: Tx, input: { customerId: string; sourceCiId: string; targetCiId: string; typeId: string; description?: string | null; source?: string }) {
  if (input.sourceCiId === input.targetCiId) throw new ValidationError('A CI cannot be related to itself');
  const [existing] = await tx
    .select({ id: ciRelationships.id })
    .from(ciRelationships)
    .where(and(eq(ciRelationships.typeId, input.typeId), or(and(eq(ciRelationships.sourceCiId, input.sourceCiId), eq(ciRelationships.targetCiId, input.targetCiId)), and(eq(ciRelationships.sourceCiId, input.targetCiId), eq(ciRelationships.targetCiId, input.sourceCiId)))))
    .limit(1);
  if (existing) return null;
  const [row] = await tx.insert(ciRelationships).values({ customerId: input.customerId, sourceCiId: input.sourceCiId, targetCiId: input.targetCiId, typeId: input.typeId, description: input.description ?? null, source: input.source ?? 'manual' }).returning();
  return row;
}

export async function addRelationship(ctx: Ctx, id: string, body: { targetCiId: string; typeId: string; description?: string | null }) {
  const source = await loadCi(ctx, id);
  ctx.require('cmdb:manage', source.customerId);
  const [target] = await ctx.tx.select({ id: cis.id, name: cis.name, customerId: cis.customerId }).from(cis).where(eq(cis.id, body.targetCiId)).limit(1);
  if (!target) throw new NotFoundError('Target CI');
  if (target.customerId !== source.customerId) throw new ValidationError('Both CIs must belong to the same customer');
  const [relType] = await ctx.tx.select().from(ciRelationshipTypes).where(eq(ciRelationshipTypes.id, body.typeId)).limit(1);
  if (!relType) throw new ValidationError('Unknown relationship type');
  const row = await ensureRelationship(ctx.tx, { customerId: source.customerId, sourceCiId: id, targetCiId: body.targetCiId, typeId: body.typeId, description: body.description });
  if (!row) throw new ConflictError('This relationship already exists');
  await ctx.audit({ entityType: 'ci_relationship', entityId: row.id, entityLabel: `${source.name} ${relType.name} ${target.name}`, action: 'create', customerId: source.customerId, metadata: { sourceCiId: id, targetCiId: target.id, typeKey: relType.key } });
  return listRelationships(ctx.tx, id);
}

export async function deleteRelationship(ctx: Ctx, relId: string) {
  const [rel] = await ctx.tx.select().from(ciRelationships).where(eq(ciRelationships.id, relId)).limit(1);
  if (!rel) throw new NotFoundError('Relationship');
  ctx.requireCustomer(rel.customerId);
  ctx.require('cmdb:manage', rel.customerId);
  await ctx.tx.delete(ciRelationships).where(eq(ciRelationships.id, relId));
  await ctx.audit({ entityType: 'ci_relationship', entityId: relId, action: 'delete', customerId: rel.customerId, metadata: { sourceCiId: rel.sourceCiId, targetCiId: rel.targetCiId, typeId: rel.typeId } });
  return { deleted: true };
}

// ---------------------------------------------------------------- services / interfaces

export async function setServices(ctx: Ctx, id: string, serviceIds: string[]) {
  const ci = await loadCi(ctx, id);
  ctx.require('cmdb:manage', ci.customerId);
  await validateRefs(ctx, ci.customerId, { serviceIds });
  const beforeRows = await ctx.tx.select({ id: ciServices.serviceId }).from(ciServices).where(eq(ciServices.ciId, id));
  await ctx.tx.delete(ciServices).where(eq(ciServices.ciId, id));
  const unique = [...new Set(serviceIds)];
  if (unique.length) await ctx.tx.insert(ciServices).values(unique.map((serviceId) => ({ ciId: id, serviceId, customerId: ci.customerId })));
  await ctx.audit({ entityType: 'ci', entityId: id, entityLabel: ci.name, action: 'services.update', customerId: ci.customerId, changes: { services: { old: beforeRows.map((r) => r.id), new: unique } } });
  return (await getCi(ctx, id)).services;
}

/** Replaces the interface table of a CI (used by the API and by discovery apply). */
export async function replaceInterfaces(tx: Tx, ci: { id: string; customerId: string }, items: InterfaceInput[]) {
  await tx.delete(ciInterfaces).where(eq(ciInterfaces.ciId, ci.id));
  if (!items.length) return [];
  const seen = new Set<string>();
  const rows = items
    .filter((i) => {
      const k = `${i.ifIndex ?? ''}:${i.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 1024)
    .map((i) => ({
      ciId: ci.id,
      customerId: ci.customerId,
      name: i.name.slice(0, 120),
      ifIndex: i.ifIndex ?? null,
      description: i.description?.slice(0, 500) ?? null,
      macAddress: normaliseMac(i.macAddress),
      ipAddress: i.ipAddress ?? null,
      speedMbps: i.speedMbps ?? null,
      adminStatus: i.adminStatus ?? null,
      operStatus: i.operStatus ?? null,
      vlan: i.vlan ?? null,
      updatedAt: new Date(),
    }));
  return tx.insert(ciInterfaces).values(rows).returning();
}

export async function setInterfaces(ctx: Ctx, id: string, items: InterfaceInput[]) {
  const ci = await loadCi(ctx, id);
  ctx.require('cmdb:manage', ci.customerId);
  const rows = await replaceInterfaces(ctx.tx, ci, items);
  await ctx.audit({ entityType: 'ci', entityId: id, entityLabel: ci.name, action: 'interfaces.update', customerId: ci.customerId, metadata: { count: rows.length } });
  return rows;
}

// ---------------------------------------------------------------- graph / impact / history

export async function graph(ctx: Ctx, id: string, depth: number, limit: number) {
  await loadCi(ctx, id);
  return buildGraph(ctx.tx, id, depth, limit);
}

export async function impact(ctx: Ctx, id: string) {
  await loadCi(ctx, id);
  const res = await buildImpact(ctx.tx, id);
  if (!res) throw new NotFoundError('Configuration item');
  return res;
}

export async function history(ctx: Ctx, id: string, limit = 100) {
  const ci = await loadCi(ctx, id);
  const rows = await ctx.tx
    .select({ id: auditLog.id, occurredAt: auditLog.occurredAt, userId: auditLog.userId, userName: auditLog.userName, entityType: auditLog.entityType, entityId: auditLog.entityId, entityLabel: auditLog.entityLabel, action: auditLog.action, changes: auditLog.changes, source: auditLog.source, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.customerId, ci.customerId),
        or(
          and(eq(auditLog.entityType, 'ci'), eq(auditLog.entityId, id)),
          and(eq(auditLog.entityType, 'ci_relationship'), or(sql`${auditLog.metadata}->>'sourceCiId' = ${id}`, sql`${auditLog.metadata}->>'targetCiId' = ${id}`)),
          and(eq(auditLog.entityType, 'discovery_finding'), sql`${auditLog.metadata}->>'ciId' = ${id}`),
        ),
      ),
    )
    .orderBy(desc(auditLog.occurredAt))
    .limit(limit);
  return { items: rows };
}

// ---------------------------------------------------------------- summary / export / import

export async function ciSummary(ctx: Ctx, customerId?: string) {
  const conds: SQL[] = [];
  if (customerId) {
    ctx.requireCustomer(customerId);
    conds.push(eq(cis.customerId, customerId));
  }
  const where = conds.length ? and(...conds) : undefined;
  const [byType, byStatus, byEnvironment, byCriticality, [totals]] = await Promise.all([
    ctx.tx.select({ typeId: cis.typeId, key: ciTypes.key, name: ciTypes.name, color: ciTypes.color, icon: ciTypes.icon, count: sql<number>`count(*)::int` }).from(cis).innerJoin(ciTypes, eq(ciTypes.id, cis.typeId)).where(where).groupBy(cis.typeId, ciTypes.key, ciTypes.name, ciTypes.color, ciTypes.icon).orderBy(desc(sql`count(*)`)),
    ctx.tx.select({ status: cis.status, count: sql<number>`count(*)::int` }).from(cis).where(where).groupBy(cis.status),
    ctx.tx.select({ environment: cis.environment, count: sql<number>`count(*)::int` }).from(cis).where(where).groupBy(cis.environment),
    ctx.tx.select({ criticality: cis.criticality, count: sql<number>`count(*)::int` }).from(cis).where(where).groupBy(cis.criticality),
    ctx.tx
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${cis.status} = 'active')::int`,
        stale: sql<number>`count(*) filter (where ${staleCond()})::int`,
        discovered: sql<number>`count(*) filter (where ${cis.discoverySource} is not null)::int`,
        withAsset: sql<number>`count(*) filter (where ${cis.assetId} is not null)::int`,
        critical: sql<number>`count(*) filter (where ${cis.criticality} = 'critical')::int`,
      })
      .from(cis)
      .where(where),
  ]);
  return { ...totals, byType, byStatus, byEnvironment, byCriticality };
}

export const EXPORT_COLUMNS = ['name', 'type', 'customer', 'site', 'hostname', 'fqdn', 'ipAddress', 'macAddress', 'serialNumber', 'manufacturer', 'model', 'osName', 'osVersion', 'environment', 'criticality', 'status', 'ownerTeam', 'assetTag', 'lastSeenAt', 'discoverySource', 'description', 'tags'] as const;

export async function exportCis(ctx: Ctx, q: CiListQuery) {
  const out: Record<string, unknown>[] = [];
  for (let p = 1; p <= 40; p++) {
    const res = await listCisFull(ctx, { ...q, page: p, pageSize: 500, fields: 'full' });
    const ids = res.items.map((i) => i.id);
    if (!ids.length) break;
    const full = await ctx.tx.select({ id: cis.id, fqdn: cis.fqdn, macAddress: cis.macAddress, osName: cis.osName, osVersion: cis.osVersion, description: cis.description }).from(cis).where(inArray(cis.id, ids));
    const byId = new Map(full.map((f) => [f.id, f]));
    for (const i of res.items) {
      const f = byId.get(i.id)!;
      out.push({
        name: i.name, type: i.typeKey, customer: i.customerName, site: i.siteName, hostname: i.hostname, fqdn: f.fqdn, ipAddress: i.ipAddress, macAddress: f.macAddress, serialNumber: i.serialNumber, manufacturer: i.manufacturer, model: i.model,
        osName: f.osName, osVersion: f.osVersion, environment: i.environment, criticality: i.criticality, status: i.status, ownerTeam: i.ownerTeamName, assetTag: i.assetTag, lastSeenAt: i.lastSeenAt?.toISOString() ?? '', discoverySource: i.discoverySource, description: f.description, tags: (i.tags ?? []).join('|'),
      });
    }
    if (res.items.length < 500) break;
  }
  return out;
}

export interface ImportResult { created: number; updated: number; skipped: number; errors: { row: number; message: string }[] }

export async function importCis(ctx: Ctx, customerId: string, csv: Buffer): Promise<ImportResult> {
  ctx.requireCustomer(customerId);
  ctx.require('cmdb:manage', customerId);
  if (csv.length > CSV_LIMITS.maxBytes) throw new ValidationError('CSV file is too large (max 10 MB)');
  const table = parseCsv(csv, { maxRows: CSV_LIMITS.maxRows });
  if (!table.headers.length) throw new ValidationError('CSV file is empty');
  const idx = headerIndex(table.headers);
  if (!idx('name') && !idx('hostname')) throw new ValidationError(`CSV must contain a "name" or "hostname" column. Expected columns: ${CI_IMPORT_COLUMNS.join(', ')}`);
  const [types, siteRows] = await Promise.all([ctx.tx.select().from(ciTypes), ctx.tx.select({ id: sites.id, code: sites.code, name: sites.name }).from(sites).where(eq(sites.customerId, customerId))]);
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]/g, '');
  const other = types.find((t) => t.key === 'other');
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };

  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    const v = (n: string) => rowValue(row, idx, n);
    const lineNo = i + 2;
    await ctx.tx.execute(sql`savepoint import_row`);
    try {
      const hostname = v('hostname')?.toLowerCase();
      const name = v('name') ?? hostname;
      if (!name) {
        result.skipped++;
        continue;
      }
      const typeRaw = v('type');
      const type = typeRaw ? types.find((t) => norm(t.key) === norm(typeRaw) || norm(t.name) === norm(typeRaw)) : undefined;
      if (typeRaw && !type) throw new Error(`Unknown CI type "${typeRaw}"`);
      const siteRaw = v('site');
      const site = siteRaw ? siteRows.find((s) => norm(s.code) === norm(siteRaw) || norm(s.name) === norm(siteRaw)) : undefined;
      if (siteRaw && !site) throw new Error(`Unknown site "${siteRaw}"`);
      const env = v('environment')?.toLowerCase();
      if (env && !(CI_ENVIRONMENTS as readonly string[]).includes(env)) throw new Error(`Invalid environment "${env}"`);
      const crit = v('criticality')?.toLowerCase();
      if (crit && !(CI_CRITICALITIES as readonly string[]).includes(crit)) throw new Error(`Invalid criticality "${crit}"`);
      const status = v('status')?.toLowerCase();
      if (status && !(CI_STATUSES as readonly string[]).includes(status)) throw new Error(`Invalid status "${status}"`);
      const data = {
        name, hostname, ipAddress: v('ipAddress'), macAddress: normaliseMac(v('macAddress')) ?? undefined, serialNumber: v('serialNumber'), manufacturer: v('manufacturer'), model: v('model'), osName: v('osName'), fqdn: v('fqdn')?.toLowerCase(),
        siteId: site?.id, environment: env, criticality: crit, status, description: v('description'), typeId: type?.id,
      };
      const clean = Object.fromEntries(Object.entries(data).filter(([, val]) => val !== undefined));
      const [existing] = await ctx.tx
        .select()
        .from(cis)
        .where(and(eq(cis.customerId, customerId), hostname ? sql`lower(${cis.hostname}) = ${hostname}` : ilike(cis.name, name)))
        .limit(1);
      if (existing) {
        await ctx.tx.update(cis).set({ ...clean, updatedAt: new Date() } as never).where(eq(cis.id, existing.id));
        const changes = diffChanges(existing as Record<string, unknown>, clean);
        if (Object.keys(changes).length) await ctx.audit({ entityType: 'ci', entityId: existing.id, entityLabel: existing.name, action: 'import_update', customerId, changes });
        result.updated++;
      } else {
        const typeId = type?.id ?? other?.id;
        if (!typeId) throw new Error('CI type is required');
        const [created] = await ctx.tx.insert(cis).values({ ...clean, customerId, name, typeId } as typeof cis.$inferInsert).returning({ id: cis.id });
        await ctx.audit({ entityType: 'ci', entityId: created.id, entityLabel: name, action: 'import_create', customerId });
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
  await ctx.audit({ entityType: 'ci', action: 'import', customerId, metadata: { created: result.created, updated: result.updated, errors: result.errors.length } });
  return result;
}

// ---------------------------------------------------------------- overview

const OPEN_STATUS_IDS = sql`(select id from config_options where type = 'ticket_status' and status_category in ('new', 'open', 'pending'))`;

type OverviewTotals = { total: number; active: number; retired: number; stale: number; discovered: number; withAsset: number; critical: number; unowned: number; noSite: number; withoutRelationships: number; nonRetired: number; complete: number; fresh: number; withRelationships: number };

/** One-call payload for the CMDB landing page: totals, breakdowns, data-health ratios, discovery state, recent changes and the most ticketed CIs. */
export async function cmdbOverview(ctx: Ctx, customerId?: string) {
  if (customerId) ctx.requireCustomer(customerId);
  const cc = (col: SQL) => (customerId ? sql`and ${col} = ${customerId}::uuid` : sql``);
  const stale = sql`c.discovery_source is not null and (c.last_seen_at is null or c.last_seen_at < now() - make_interval(days => ${STALE_DAYS}))`;
  const rel = sql`exists (select 1 from ci_relationships r where r.source_ci_id = c.id or r.target_ci_id = c.id)`;
  const [t, inc, byType, byStatus, byEnvironment, byCriticality, disc, findings, lastRun, recentChanges, topImpacted] = await Promise.all([
    rawOne<OverviewTotals>(ctx, sql`
      select count(*)::int as total,
        count(*) filter (where c.status = 'active')::int as active,
        count(*) filter (where c.status = 'retired')::int as retired,
        count(*) filter (where ${stale})::int as stale,
        count(*) filter (where c.discovery_source is not null)::int as discovered,
        count(*) filter (where c.asset_id is not null)::int as "withAsset",
        count(*) filter (where c.criticality = 'critical')::int as critical,
        count(*) filter (where c.owner_team_id is null and c.status <> 'retired')::int as unowned,
        count(*) filter (where c.site_id is null and c.status <> 'retired')::int as "noSite",
        count(*) filter (where c.status = 'active' and not ${rel})::int as "withoutRelationships",
        count(*) filter (where c.status <> 'retired')::int as "nonRetired",
        count(*) filter (where c.status <> 'retired' and c.site_id is not null and c.owner_team_id is not null and (c.serial_number is not null or c.hostname is not null))::int as complete,
        count(*) filter (where c.discovery_source is not null and c.last_seen_at >= now() - make_interval(days => ${STALE_DAYS}))::int as fresh,
        count(*) filter (where c.status = 'active' and ${rel})::int as "withRelationships"
      from cis c where true ${cc(sql`c.customer_id`)}`),
    rawOne<{ count: number }>(ctx, sql`
      select count(distinct t.id)::int as count from tickets t
      where t.status_id in ${OPEN_STATUS_IDS}
        and (exists (select 1 from cis c where c.id = t.primary_ci_id ${cc(sql`c.customer_id`)})
          or exists (select 1 from ticket_cis tc join cis c on c.id = tc.ci_id where tc.ticket_id = t.id ${cc(sql`c.customer_id`)}))`),
    rawRows<{ key: string; name: string; color: string | null; icon: string | null; parentKey: string | null; count: number }>(ctx, sql`
      select ty.key, ty.name, ty.color, ty.icon, ty.parent_key as "parentKey", count(*)::int as count
      from cis c join ci_types ty on ty.id = c.type_id where true ${cc(sql`c.customer_id`)}
      group by ty.id, ty.key, ty.name, ty.color, ty.icon, ty.parent_key order by count(*) desc, ty.name`),
    rawRows<{ status: string; count: number }>(ctx, sql`select c.status, count(*)::int as count from cis c where true ${cc(sql`c.customer_id`)} group by c.status order by count(*) desc`),
    rawRows<{ environment: string; count: number }>(ctx, sql`select c.environment, count(*)::int as count from cis c where true ${cc(sql`c.customer_id`)} group by c.environment order by count(*) desc`),
    rawRows<{ criticality: string; count: number }>(ctx, sql`select c.criticality, count(*)::int as count from cis c where true ${cc(sql`c.customer_id`)} group by c.criticality order by count(*) desc`),
    rawOne<{ sources: number; activeSources: number }>(ctx, sql`select count(*)::int as sources, count(*) filter (where s.is_active)::int as "activeSources" from discovery_sources s where true ${cc(sql`s.customer_id`)}`),
    rawOne<{ pendingFindings: number; newFindings: number }>(ctx, sql`select count(*) filter (where f.status = 'pending')::int as "pendingFindings", count(*) filter (where f.status = 'pending' and f.diff_status = 'new')::int as "newFindings" from discovery_findings f where true ${cc(sql`f.customer_id`)}`),
    rawRows<{ id: string; sourceId: string; sourceName: string | null; status: string; finishedAt: Date | null; startedAt: Date | null }>(ctx, sql`
      select r.id, r.source_id as "sourceId", s.name as "sourceName", r.status, r.finished_at as "finishedAt", r.started_at as "startedAt"
      from discovery_runs r left join discovery_sources s on s.id = r.source_id where true ${cc(sql`r.customer_id`)} order by r.created_at desc limit 1`),
    rawRows<{ id: string; entityId: string; ciName: string | null; action: string; at: Date; actorName: string | null }>(ctx, sql`
      select a.id, a.entity_id as "entityId", coalesce(c.name, a.entity_label) as "ciName", a.action, a.occurred_at as "at", a.user_name as "actorName"
      from audit_log a left join cis c on c.id = a.entity_id
      where a.entity_type = 'ci' and a.entity_id is not null ${cc(sql`a.customer_id`)} order by a.occurred_at desc limit 10`),
    rawRows<{ id: string; name: string; typeName: string; openTickets: number }>(ctx, sql`
      with linked as (
        select t.primary_ci_id as ci_id, t.id as ticket_id from tickets t where t.status_id in ${OPEN_STATUS_IDS} and t.primary_ci_id is not null
        union
        select tc.ci_id, tc.ticket_id from ticket_cis tc join tickets t on t.id = tc.ticket_id where t.status_id in ${OPEN_STATUS_IDS})
      select c.id, c.name, ty.name as "typeName", count(distinct l.ticket_id)::int as "openTickets"
      from linked l join cis c on c.id = l.ci_id join ci_types ty on ty.id = c.type_id where true ${cc(sql`c.customer_id`)}
      group by c.id, c.name, ty.name order by count(distinct l.ticket_id) desc, c.name limit 5`),
  ]);
  return {
    totals: {
      total: num(t.total), active: num(t.active), retired: num(t.retired), stale: num(t.stale), discovered: num(t.discovered), withAsset: num(t.withAsset), critical: num(t.critical),
      unowned: num(t.unowned), noSite: num(t.noSite), withoutRelationships: num(t.withoutRelationships), openIncidents: num(inc.count),
    },
    byType: byType.map((r) => ({ ...r, count: num(r.count) })),
    byStatus: byStatus.map((r) => ({ ...r, count: num(r.count) })),
    byEnvironment: byEnvironment.map((r) => ({ ...r, count: num(r.count) })),
    byCriticality: byCriticality.map((r) => ({ ...r, count: num(r.count) })),
    health: {
      completenessPct: pct(num(t.complete), num(t.nonRetired)),
      freshnessPct: pct(num(t.fresh), num(t.discovered)),
      relationshipCoveragePct: pct(num(t.withRelationships), num(t.active)),
    },
    discovery: {
      sources: num(disc.sources), activeSources: num(disc.activeSources), pendingFindings: num(findings.pendingFindings), newFindings: num(findings.newFindings),
      lastRun: lastRun[0] ? { ...lastRun[0], startedAt: asDate(lastRun[0].startedAt), finishedAt: asDate(lastRun[0].finishedAt) } : null,
    },
    recentChanges: recentChanges.map((r) => ({ ...r, at: asDate(r.at) as Date })),
    topImpacted: topImpacted.map((r) => ({ ...r, openTickets: num(r.openTickets) })),
  };
}

// ---------------------------------------------------------------- business services

export type ServiceHealth = 'good' | 'warning' | 'critical';

/** Business services (CIs of type `business_service`) with their dependency footprint and open-ticket health. */
export async function listBusinessServices(ctx: Ctx, customerId?: string) {
  if (customerId) ctx.requireCustomer(customerId);
  const rows = await ctx.tx
    .select({ id: cis.id, name: cis.name, customerId: cis.customerId, customerName: customers.name, status: cis.status, criticality: cis.criticality, attributes: cis.attributes })
    .from(cis)
    .innerJoin(ciTypes, eq(ciTypes.id, cis.typeId))
    .leftJoin(customers, eq(customers.id, cis.customerId))
    .where(and(eq(ciTypes.key, 'business_service'), customerId ? eq(cis.customerId, customerId) : undefined))
    .orderBy(asc(customers.name), asc(cis.name));
  const items = [];
  for (const r of rows) {
    const map = await buildDependencyMap(ctx.tx, r.id, 6, 200);
    const ids = map ? map.nodes.map((n) => n.id) : [r.id];
    const open = await openTicketSummary(ctx.tx, ids);
    const attrs = (r.attributes ?? {}) as Record<string, unknown>;
    const health: ServiceHealth = open.critical > 0 ? 'critical' : open.count > 0 ? 'warning' : 'good';
    items.push({
      id: r.id, name: r.name, customerId: r.customerId, customerName: r.customerName, status: r.status, criticality: r.criticality,
      tier: typeof attrs.tier === 'string' ? attrs.tier : null, owner: typeof attrs.owner === 'string' ? attrs.owner : null,
      dependencies: ids.length - 1, openIncidents: open.count, health,
    });
  }
  return { items };
}

/** Layered dependency map (what the CI relies on) from any CI; see `buildDependencyMap`. */
export async function serviceMap(ctx: Ctx, id: string, depth = 6) {
  await loadCi(ctx, id);
  const res = await buildDependencyMap(ctx.tx, id, depth, 200);
  if (!res) throw new NotFoundError('Configuration item');
  return res;
}

// ---------------------------------------------------------------- bulk update

export interface BulkResult { succeeded: number; failed: number; errors: { id: string; message: string }[] }

/** Applies one action to many CIs; each row runs in its own savepoint and gets its own audit entry, so one failure never blocks the rest. */
export async function bulkUpdateCis(ctx: Ctx, input: CiBulkInput): Promise<BulkResult> {
  const { action, payload } = input;
  const ids = [...new Set(input.ids)];
  let patch: Record<string, unknown> = {};
  switch (action) {
    case 'status':
      if (!payload.status) throw new ValidationError('payload.status is required');
      patch = { status: payload.status };
      break;
    case 'retire':
      patch = { status: 'retired' };
      break;
    case 'criticality':
      if (!payload.criticality) throw new ValidationError('payload.criticality is required');
      patch = { criticality: payload.criticality };
      break;
    case 'environment':
      if (!payload.environment) throw new ValidationError('payload.environment is required');
      patch = { environment: payload.environment };
      break;
    case 'ownerTeam': {
      if (payload.ownerTeamId === undefined) throw new ValidationError('payload.ownerTeamId is required (null clears the owner)');
      if (payload.ownerTeamId) {
        const [t] = await ctx.tx.select({ id: teams.id }).from(teams).where(eq(teams.id, payload.ownerTeamId)).limit(1);
        if (!t) throw new ValidationError('Unknown owner team');
      }
      patch = { ownerTeamId: payload.ownerTeamId };
      break;
    }
    case 'addTag':
      if (!payload.tag) throw new ValidationError('payload.tag is required');
      break;
  }
  const result: BulkResult = { succeeded: 0, failed: 0, errors: [] };
  for (const id of ids) {
    await ctx.tx.execute(sql`savepoint bulk_ci`);
    try {
      const before = await loadCi(ctx, id);
      ctx.require('cmdb:manage', before.customerId);
      const set = action === 'addTag' ? { tags: [...new Set([...(before.tags ?? []), payload.tag!])] } : patch;
      const [after] = await ctx.tx.update(cis).set({ ...set, updatedAt: new Date() } as never).where(eq(cis.id, id)).returning();
      const changes = diffChanges(before as Record<string, unknown>, set);
      if (Object.keys(changes).length) await ctx.audit({ entityType: 'ci', entityId: id, entityLabel: after.name, action: 'update', customerId: after.customerId, changes, metadata: { bulk: true, bulkAction: action } });
      await ctx.tx.execute(sql`release savepoint bulk_ci`);
      result.succeeded++;
    } catch (err) {
      await ctx.tx.execute(sql`rollback to savepoint bulk_ci`);
      result.failed++;
      result.errors.push({ id, message: (err as Error).message });
    }
  }
  return result;
}
