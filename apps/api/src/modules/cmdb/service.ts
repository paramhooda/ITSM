import { and, asc, desc, eq, ilike, inArray, isNull, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { CI_STATUSES } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema, type Tx } from '@/db/client';
import { ConflictError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { searchFts, orderBy, limitOffset } from '@/core/query';
import { parseCsv, headerIndex, rowValue, CSV_LIMITS } from '@/modules/assets/csv';
import { validateAttributes } from './attributes';
import { buildGraph, buildImpact } from './graph';
import { normaliseMac } from './match';
import { CI_CRITICALITIES, CI_ENVIRONMENTS, CI_IMPORT_COLUMNS, type CiCreateInput, type CiListQuery, type CiPatchInput, type InterfaceInput } from './schemas';

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
  if (q.stale) conds.push(or(isNull(cis.lastSeenAt), lt(cis.lastSeenAt, new Date(Date.now() - 30 * 86_400_000))));
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
  const staleBefore = new Date(Date.now() - 30 * 86_400_000);
  const [byType, byStatus, byEnvironment, byCriticality, [totals]] = await Promise.all([
    ctx.tx.select({ typeId: cis.typeId, key: ciTypes.key, name: ciTypes.name, color: ciTypes.color, icon: ciTypes.icon, count: sql<number>`count(*)::int` }).from(cis).innerJoin(ciTypes, eq(ciTypes.id, cis.typeId)).where(where).groupBy(cis.typeId, ciTypes.key, ciTypes.name, ciTypes.color, ciTypes.icon).orderBy(desc(sql`count(*)`)),
    ctx.tx.select({ status: cis.status, count: sql<number>`count(*)::int` }).from(cis).where(where).groupBy(cis.status),
    ctx.tx.select({ environment: cis.environment, count: sql<number>`count(*)::int` }).from(cis).where(where).groupBy(cis.environment),
    ctx.tx.select({ criticality: cis.criticality, count: sql<number>`count(*)::int` }).from(cis).where(where).groupBy(cis.criticality),
    ctx.tx
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${cis.status} = 'active')::int`,
        stale: sql<number>`count(*) filter (where ${cis.discoverySource} is not null and (${cis.lastSeenAt} is null or ${cis.lastSeenAt} < ${staleBefore}))::int`,
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
