import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError, ForbiddenError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { queueNotification } from '@/modules/notifications/dispatch';
import { loadContract, todayStr, addDays, addMonths, contractRecipients, claimMilestone, contractLink, optionLabels, userNames, type ContractRow } from './common';
import { COVERING_STATUSES } from './schemas';
import type { EntitlementInput, ConsumptionInput } from './schemas';

export type EntitlementRow = typeof schema.contractEntitlements.$inferSelect;
export type ConsumptionRow = typeof schema.entitlementConsumptions.$inferSelect;

export interface Utilization {
  period: string;
  /** First day of the current window (inclusive, YYYY-MM-DD). */
  periodStart: string;
  /** Last day of the current window (inclusive, YYYY-MM-DD). */
  periodEnd: string;
  quantity: number;
  used: number;
  remaining: number;
  /** Percentage consumed (0..n, may exceed 100 when overage happened). */
  pct: number;
  warnThresholdPct: number;
  overThreshold: boolean;
  exhausted: boolean;
}

const MONTHS: Record<string, number> = { yearly: 12, half_yearly: 6, quarterly: 3, monthly: 1 };

/**
 * The consumption window an entitlement is measured over at `at`.
 * `contract` = the whole contract term; other periods are rolling windows of
 * 12/6/3/1 months anchored on the contract start date and clipped to its end.
 */
export function periodWindow(period: string, contractStart: string, contractEnd: string, at: Date | string = new Date()) {
  const atStr = typeof at === 'string' ? at : todayStr(at);
  const endExclusive = addDays(contractEnd, 1);
  const n = MONTHS[period];
  if (!n) return { periodStart: contractStart, periodEnd: contractEnd, nextStart: endExclusive };
  let k = 0;
  // advance window by window until `at` falls inside, never beyond the contract end
  for (let guard = 0; guard < 1200; guard++) {
    const next = addMonths(contractStart, (k + 1) * n);
    if (next <= atStr && next < endExclusive) k++;
    else break;
  }
  const periodStart = addMonths(contractStart, k * n);
  let nextStart = addMonths(contractStart, (k + 1) * n);
  if (nextStart > endExclusive) nextStart = endExclusive;
  return { periodStart, periodEnd: addDays(nextStart, -1), nextStart };
}

type EntLike = Pick<EntitlementRow, 'id' | 'contractId' | 'quantity' | 'warnThresholdPct' | 'period'>;

function buildUtilization(ent: EntLike, win: { periodStart: string; periodEnd: string }, used: number): Utilization {
  const quantity = Number(ent.quantity) || 0;
  const pct = quantity > 0 ? Math.round((used / quantity) * 1000) / 10 : used > 0 ? 100 : 0;
  return {
    period: ent.period,
    periodStart: win.periodStart,
    periodEnd: win.periodEnd,
    quantity,
    used,
    remaining: Math.max(0, Math.round((quantity - used) * 100) / 100),
    pct,
    warnThresholdPct: ent.warnThresholdPct,
    overThreshold: quantity > 0 && pct >= ent.warnThresholdPct,
    exhausted: quantity > 0 ? used >= quantity : used > 0,
  };
}

/** Utilization of one entitlement at `at` (defaults to now). */
export async function entitlementUtilization(tx: Tx, entitlement: EntLike, at: Date = new Date(), contract?: Pick<ContractRow, 'startDate' | 'endDate'>): Promise<Utilization> {
  let c = contract;
  if (!c) {
    const [row] = await tx.select({ startDate: schema.contracts.startDate, endDate: schema.contracts.endDate }).from(schema.contracts).where(eq(schema.contracts.id, entitlement.contractId)).limit(1);
    if (!row) throw new NotFoundError('Contract');
    c = row;
  }
  const win = periodWindow(entitlement.period, c.startDate, c.endDate, at);
  const [row] = await tx
    .select({ used: sql<number>`coalesce(sum(${schema.entitlementConsumptions.quantity}), 0)::float` })
    .from(schema.entitlementConsumptions)
    .where(and(eq(schema.entitlementConsumptions.entitlementId, entitlement.id), sql`${schema.entitlementConsumptions.consumedAt} >= ${win.periodStart}::date`, sql`${schema.entitlementConsumptions.consumedAt} < ${win.nextStart}::date`));
  return buildUtilization(entitlement, win, Number(row?.used ?? 0));
}

/** Utilization for many entitlements in one round trip (list pages, dashboards). */
export async function utilizationBatch(tx: Tx, ents: EntLike[], contractsById: Map<string, Pick<ContractRow, 'startDate' | 'endDate'>>, at: Date = new Date()): Promise<Map<string, Utilization>> {
  const out = new Map<string, Utilization>();
  if (!ents.length) return out;
  const wins = ents.map((e) => {
    const c = contractsById.get(e.contractId);
    const win = c ? periodWindow(e.period, c.startDate, c.endDate, at) : { periodStart: '1970-01-01', periodEnd: '2999-12-31', nextStart: '3000-01-01' };
    return { e, win };
  });
  const values = sql.join(wins.map(({ e, win }) => sql`(${e.id}::uuid, ${win.periodStart}::date, ${win.nextStart}::date)`), sql`, `);
  const res = await tx.execute(sql`
    SELECT w.id, coalesce(sum(c.quantity), 0)::float AS used
    FROM (VALUES ${values}) AS w(id, ps, ne)
    LEFT JOIN entitlement_consumptions c ON c.entitlement_id = w.id AND c.consumed_at >= w.ps AND c.consumed_at < w.ne
    GROUP BY w.id`);
  const used = new Map((res.rows as { id: string; used: number }[]).map((r) => [r.id, Number(r.used)]));
  for (const { e, win } of wins) out.set(e.id, buildUtilization(e, win, used.get(e.id) ?? 0));
  return out;
}

// ---------------------------------------------------------------- notifications

async function notifyEntitlementThreshold(tx: Tx, ent: EntitlementRow, contract: ContractRow, u: Utilization): Promise<'threshold' | 'exhausted' | null> {
  const kind = u.exhausted ? 'exhausted' : u.overThreshold ? 'threshold' : null;
  if (!kind) return null;
  const milestone = `ent:${ent.id}:${u.periodStart}:${kind === 'exhausted' ? 'exhausted' : 'warn'}`;
  if (!(await claimMilestone(tx, contract.id, contract.customerId, milestone))) return null;
  const [customer] = await tx.select({ id: schema.customers.id, name: schema.customers.name, accountManagerId: schema.customers.accountManagerId }).from(schema.customers).where(eq(schema.customers.id, contract.customerId)).limit(1);
  const recipients = await contractRecipients(tx, contract, customer);
  await queueNotification(tx, {
    event: kind === 'exhausted' ? 'entitlement.exhausted' : 'entitlement.threshold',
    recipients,
    customerId: contract.customerId,
    entityType: 'contract_entitlement',
    entityId: ent.id,
    link: contractLink(contract.id),
    data: {
      entitlement: { id: ent.id, name: ent.name, customerName: customer?.name ?? '', contractNumber: contract.number, contractName: contract.name, pct: u.pct, used: u.used, quantity: u.quantity, remaining: u.remaining, unit: ent.unit, periodStart: u.periodStart, periodEnd: u.periodEnd, link: contractLink(contract.id) },
      contract: { id: contract.id, number: contract.number, name: contract.name, customerName: customer?.name ?? '', endDate: contract.endDate, link: contractLink(contract.id) },
    },
  });
  return kind;
}

/** Re-evaluates one entitlement and raises threshold/exhausted notifications once per window. Used by the daily job. */
export async function checkEntitlementThreshold(tx: Tx, ent: EntitlementRow, contract: ContractRow, at: Date = new Date()) {
  const u = await entitlementUtilization(tx, ent, at, contract);
  const notification = await notifyEntitlementThreshold(tx, ent, contract, u);
  return { utilization: u, notification };
}

// ---------------------------------------------------------------- consumption (cross-module helper)

export interface ConsumeEntitlementInput {
  entitlementId: string;
  quantity: number;
  /** manual | field_visit | pm | time_entry | ticket | ... */
  sourceType: string;
  sourceId?: string | null;
  ticketId?: string | null;
  notes?: string | null;
  createdBy: string | null;
  consumedAt?: Date;
  /** When true, consuming beyond the quantity of an entitlement with overageAllowed=false throws. Default: record it and flag `overage`. */
  enforceOverage?: boolean;
}

/**
 * Records consumption against an entitlement (field visits, PM occurrences,
 * time entries and manual adjustments all go through here), recomputes the
 * window utilization and queues threshold / exhausted notifications once per
 * entitlement + window. Runs in the caller's transaction.
 */
export async function consumeEntitlement(tx: Tx, input: ConsumeEntitlementInput) {
  const [ent] = await tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, input.entitlementId)).limit(1);
  if (!ent) throw new NotFoundError('Entitlement');
  if (!ent.isActive) throw new ValidationError('Entitlement is inactive');
  if (!(input.quantity > 0)) throw new ValidationError('Quantity must be greater than zero');
  const [contract] = await tx.select().from(schema.contracts).where(eq(schema.contracts.id, ent.contractId)).limit(1);
  if (!contract) throw new NotFoundError('Contract');
  const consumedAt = input.consumedAt ?? new Date();
  const before = await entitlementUtilization(tx, ent, consumedAt, contract);
  const overage = before.quantity > 0 && before.used + input.quantity > before.quantity;
  if (overage && !ent.overageAllowed && input.enforceOverage) {
    throw new ValidationError(`Entitlement "${ent.name}" has ${before.remaining} ${ent.unit} remaining in the current period and overage is not allowed`);
  }
  const [consumption] = await tx
    .insert(schema.entitlementConsumptions)
    .values({
      entitlementId: ent.id,
      customerId: ent.customerId,
      quantity: String(input.quantity),
      consumedAt,
      sourceType: input.sourceType || 'manual',
      sourceId: input.sourceId ?? null,
      ticketId: input.ticketId ?? null,
      notes: input.notes ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  const utilization = await entitlementUtilization(tx, ent, consumedAt, contract);
  const notification = await notifyEntitlementThreshold(tx, ent, contract, utilization);
  return { consumption, utilization, overage, notification, entitlement: ent, contract };
}

// ---------------------------------------------------------------- decoration

export async function decorateEntitlements(tx: Tx, ents: EntitlementRow[], contractsById: Map<string, ContractRow>, at = new Date()) {
  const util = await utilizationBatch(tx, ents, contractsById, at);
  const labels = await optionLabels(tx, ents.map((e) => e.typeId));
  const serviceIds = [...new Set(ents.map((e) => e.serviceId).filter((x): x is string => !!x))];
  const services = serviceIds.length ? await tx.select({ id: schema.services.id, name: schema.services.name }).from(schema.services).where(inArray(schema.services.id, serviceIds)) : [];
  const svc = new Map(services.map((s) => [s.id, s.name]));
  return ents.map((e) => {
    const c = contractsById.get(e.contractId);
    return {
      ...e,
      quantity: Number(e.quantity),
      typeLabel: e.typeId ? labels.get(e.typeId)?.label ?? null : null,
      serviceName: e.serviceId ? svc.get(e.serviceId) ?? null : null,
      contractNumber: c?.number ?? null,
      contractName: c?.name ?? null,
      contractStatus: c?.status ?? null,
      utilization: util.get(e.id)!,
    };
  });
}

export type EntitlementView = Awaited<ReturnType<typeof decorateEntitlements>>[number];

// ---------------------------------------------------------------- CRUD (request context)

export async function listEntitlements(ctx: Ctx, contractId: string, includeInactive = false) {
  const contract = await loadContract(ctx, contractId);
  const conds = [eq(schema.contractEntitlements.contractId, contractId)];
  if (!includeInactive) conds.push(eq(schema.contractEntitlements.isActive, true));
  const rows = await ctx.tx.select().from(schema.contractEntitlements).where(and(...conds)).orderBy(schema.contractEntitlements.createdAt);
  return decorateEntitlements(ctx.tx, rows, new Map([[contract.id, contract]]));
}

export async function getEntitlement(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, id)).limit(1);
  if (!row) throw new NotFoundError('Entitlement');
  ctx.requireCustomer(row.customerId);
  const contract = await loadContract(ctx, row.contractId);
  const [view] = await decorateEntitlements(ctx.tx, [row], new Map([[contract.id, contract]]));
  return view;
}

async function defaultUnit(tx: Tx, typeId: string | null | undefined) {
  if (!typeId) return undefined;
  const labels = await optionLabels(tx, [typeId]);
  const unit = labels.get(typeId)?.metadata?.unit;
  return typeof unit === 'string' ? unit : undefined;
}

export async function createEntitlement(ctx: Ctx, contractId: string, input: EntitlementInput) {
  const contract = await loadContract(ctx, contractId);
  ctx.require('contracts:manage', contract.customerId);
  const unit = input.unit ?? (await defaultUnit(ctx.tx, input.typeId)) ?? 'count';
  const [row] = await ctx.tx
    .insert(schema.contractEntitlements)
    .values({
      contractId,
      customerId: contract.customerId,
      typeId: input.typeId ?? null,
      name: input.name,
      serviceId: input.serviceId ?? null,
      quantity: String(input.quantity),
      unit,
      period: input.period ?? 'contract',
      warnThresholdPct: input.warnThresholdPct ?? 80,
      overageAllowed: input.overageAllowed ?? true,
      notes: input.notes ?? null,
      isActive: input.isActive ?? true,
    })
    .returning();
  await ctx.audit({ entityType: 'contract_entitlement', entityId: row.id, entityLabel: row.name, action: 'create', customerId: contract.customerId, metadata: { contractId, contractNumber: contract.number, quantity: input.quantity, unit, period: row.period } });
  const [view] = await decorateEntitlements(ctx.tx, [row], new Map([[contract.id, contract]]));
  return view;
}

export async function updateEntitlement(ctx: Ctx, id: string, patch: Partial<EntitlementInput>) {
  const [before] = await ctx.tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, id)).limit(1);
  if (!before) throw new NotFoundError('Entitlement');
  const contract = await loadContract(ctx, before.contractId);
  ctx.require('contracts:manage', contract.customerId);
  const values: Partial<typeof schema.contractEntitlements.$inferInsert> = { updatedAt: new Date() };
  if (patch.typeId !== undefined) values.typeId = patch.typeId;
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.serviceId !== undefined) values.serviceId = patch.serviceId;
  if (patch.quantity !== undefined) values.quantity = String(patch.quantity);
  if (patch.unit !== undefined) values.unit = patch.unit;
  if (patch.period !== undefined) values.period = patch.period;
  if (patch.warnThresholdPct !== undefined) values.warnThresholdPct = patch.warnThresholdPct;
  if (patch.overageAllowed !== undefined) values.overageAllowed = patch.overageAllowed;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.isActive !== undefined) values.isActive = patch.isActive;
  const [after] = await ctx.tx.update(schema.contractEntitlements).set(values).where(eq(schema.contractEntitlements.id, id)).returning();
  const comparable = { ...before, quantity: String(before.quantity) } as Record<string, unknown>;
  await ctx.audit({ entityType: 'contract_entitlement', entityId: id, entityLabel: after.name, action: 'update', customerId: contract.customerId, changes: diffChanges(comparable, values as Record<string, unknown>), metadata: { contractId: contract.id, contractNumber: contract.number } });
  const [view] = await decorateEntitlements(ctx.tx, [after], new Map([[contract.id, contract]]));
  return view;
}

export async function deleteEntitlement(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, id)).limit(1);
  if (!row) throw new NotFoundError('Entitlement');
  const contract = await loadContract(ctx, row.contractId);
  ctx.require('contracts:manage', contract.customerId);
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(schema.entitlementConsumptions).where(eq(schema.entitlementConsumptions.entitlementId, id));
  if (count > 0) {
    await ctx.tx.update(schema.contractEntitlements).set({ isActive: false, updatedAt: new Date() }).where(eq(schema.contractEntitlements.id, id));
    await ctx.audit({ entityType: 'contract_entitlement', entityId: id, entityLabel: row.name, action: 'deactivate', customerId: contract.customerId, metadata: { contractId: contract.id, consumptions: count } });
    return { deactivated: true };
  }
  await ctx.tx.delete(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, id));
  await ctx.audit({ entityType: 'contract_entitlement', entityId: id, entityLabel: row.name, action: 'delete', customerId: contract.customerId, metadata: { contractId: contract.id } });
  return { deleted: true };
}

/** Manual consumption from the UI / API. Requires contracts:manage or field:execute for the customer. */
export async function recordConsumption(ctx: Ctx, entitlementId: string, input: ConsumptionInput) {
  const [ent] = await ctx.tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, entitlementId)).limit(1);
  if (!ent) throw new NotFoundError('Entitlement');
  ctx.requireCustomer(ent.customerId);
  if (!ctx.can('contracts:manage', ent.customerId) && !ctx.can('field:execute', ent.customerId)) throw new ForbiddenError('Missing permission: contracts:manage or field:execute');
  const result = await consumeEntitlement(ctx.tx, {
    entitlementId,
    quantity: input.quantity,
    sourceType: input.sourceType ?? 'manual',
    sourceId: input.sourceId ?? null,
    ticketId: input.ticketId ?? null,
    notes: input.notes ?? null,
    createdBy: ctx.user.apiKeyId ? null : ctx.user.id,
    consumedAt: input.consumedAt ? new Date(input.consumedAt) : undefined,
    enforceOverage: true,
  });
  await ctx.audit({
    entityType: 'entitlement_consumption',
    entityId: result.consumption.id,
    entityLabel: `${ent.name}: ${input.quantity} ${ent.unit}`,
    action: 'create',
    customerId: ent.customerId,
    metadata: { contractId: ent.contractId, entitlementId, quantity: input.quantity, sourceType: result.consumption.sourceType, ticketId: input.ticketId ?? null, overage: result.overage, notification: result.notification },
  });
  return { consumption: { ...result.consumption, quantity: Number(result.consumption.quantity) }, utilization: result.utilization, overage: result.overage, notification: result.notification };
}

export async function deleteConsumption(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.entitlementConsumptions).where(eq(schema.entitlementConsumptions.id, id)).limit(1);
  if (!row) throw new NotFoundError('Consumption');
  ctx.requireCustomer(row.customerId);
  ctx.require('contracts:manage', row.customerId);
  const [ent] = await ctx.tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, row.entitlementId)).limit(1);
  await ctx.tx.delete(schema.entitlementConsumptions).where(eq(schema.entitlementConsumptions.id, id));
  await ctx.audit({ entityType: 'entitlement_consumption', entityId: id, entityLabel: ent ? `${ent.name}: ${Number(row.quantity)} ${ent.unit}` : null, action: 'delete', customerId: row.customerId, metadata: { contractId: ent?.contractId ?? null, entitlementId: row.entitlementId, quantity: Number(row.quantity), sourceType: row.sourceType } });
  return { deleted: true };
}

export async function listConsumptions(ctx: Ctx, entitlementId: string, limit = 200) {
  const [ent] = await ctx.tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, entitlementId)).limit(1);
  if (!ent) throw new NotFoundError('Entitlement');
  ctx.requireCustomer(ent.customerId);
  const rows = await ctx.tx
    .select({ c: schema.entitlementConsumptions, ticketNumber: schema.tickets.number, ticketTitle: schema.tickets.title })
    .from(schema.entitlementConsumptions)
    .leftJoin(schema.tickets, eq(schema.tickets.id, schema.entitlementConsumptions.ticketId))
    .where(eq(schema.entitlementConsumptions.entitlementId, entitlementId))
    .orderBy(desc(schema.entitlementConsumptions.consumedAt))
    .limit(limit);
  const names = await userNames(ctx.tx, rows.map((r) => r.c.createdBy));
  return rows.map((r) => ({ ...r.c, quantity: Number(r.c.quantity), createdByName: r.c.createdBy ? names.get(r.c.createdBy)?.name ?? null : null, ticketNumber: r.ticketNumber, ticketTitle: r.ticketTitle }));
}

/** All entitlements of a customer's covering contracts, with utilization. */
export async function customerEntitlements(ctx: Ctx, customerId: string, includeInactiveContracts = false) {
  ctx.requireCustomer(customerId);
  const conds = [eq(schema.contracts.customerId, customerId)];
  if (!includeInactiveContracts) conds.push(inArray(schema.contracts.status, COVERING_STATUSES));
  const contracts = await ctx.tx.select().from(schema.contracts).where(and(...conds));
  if (!contracts.length) return [];
  const ents = await ctx.tx
    .select()
    .from(schema.contractEntitlements)
    .where(and(inArray(schema.contractEntitlements.contractId, contracts.map((c) => c.id)), eq(schema.contractEntitlements.isActive, true)))
    .orderBy(schema.contractEntitlements.name);
  return decorateEntitlements(ctx.tx, ents, new Map(contracts.map((c) => [c.id, c])));
}

/** Dashboard summary: counts and the entitlements closest to exhaustion across visible customers (or one customer). */
export async function entitlementSummary(ctx: Ctx, customerId?: string, limit = 20) {
  if (customerId) ctx.requireCustomer(customerId);
  const conds = [inArray(schema.contracts.status, COVERING_STATUSES)];
  if (customerId) conds.push(eq(schema.contracts.customerId, customerId));
  const contracts = await ctx.tx.select().from(schema.contracts).where(and(...conds));
  if (!contracts.length) return { total: 0, overThreshold: 0, exhausted: 0, items: [] };
  const ents = await ctx.tx.select().from(schema.contractEntitlements).where(and(inArray(schema.contractEntitlements.contractId, contracts.map((c) => c.id)), eq(schema.contractEntitlements.isActive, true)));
  const views = await decorateEntitlements(ctx.tx, ents, new Map(contracts.map((c) => [c.id, c])));
  const customerNames = new Map((await ctx.tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(inArray(schema.customers.id, [...new Set(contracts.map((c) => c.customerId))]))).map((c) => [c.id, c.name]));
  const items = views
    .map((v) => ({ id: v.id, name: v.name, unit: v.unit, contractId: v.contractId, contractNumber: v.contractNumber, customerId: v.customerId, customerName: customerNames.get(v.customerId) ?? '', utilization: v.utilization }))
    .sort((a, b) => b.utilization.pct - a.utilization.pct);
  return {
    total: views.length,
    overThreshold: views.filter((v) => v.utilization.overThreshold && !v.utilization.exhausted).length,
    exhausted: views.filter((v) => v.utilization.exhausted).length,
    items: items.slice(0, limit),
  };
}
