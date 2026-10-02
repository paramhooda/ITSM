import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { type Bucket, countBuckets, fixedBuckets, num, todayStr, addDays, daysBetween, monthStart, monthKey } from '@/core/overview';
import { contractStatusOptions, statusDisplay, optionLabels, sequential } from './common';
import { COVERING_STATUSES, CONTRACT_STATUSES } from './schemas';
import { decorateEntitlements } from './entitlements';
import type { EntitlementListQuery } from './schemas';

const c = schema.contracts;
type Row = Record<string, unknown>;

/** Visible covering contracts (active / expiring), optionally for one customer, with their customer names. */
async function coveringContracts(ctx: Ctx, customerId?: string) {
  const conds: SQL[] = [inArray(c.status, COVERING_STATUSES)];
  if (customerId) conds.push(eq(c.customerId, customerId));
  return ctx.tx
    .select({ contract: c, customerName: schema.customers.name })
    .from(c)
    .innerJoin(schema.customers, eq(schema.customers.id, c.customerId))
    .where(and(...conds))
    .orderBy(asc(c.endDate), asc(c.number));
}

/** Active entitlements of the given contracts decorated with their current-period utilisation. */
async function entitlementViews(ctx: Ctx, rows: Awaited<ReturnType<typeof coveringContracts>>) {
  if (!rows.length) return [];
  const ents = await ctx.tx
    .select()
    .from(schema.contractEntitlements)
    .where(and(inArray(schema.contractEntitlements.contractId, rows.map((r) => r.contract.id)), eq(schema.contractEntitlements.isActive, true)))
    .orderBy(asc(schema.contractEntitlements.name));
  const byContract = new Map(rows.map((r) => [r.contract.id, r.contract]));
  const names = new Map(rows.map((r) => [r.contract.id, r.customerName]));
  const views = await decorateEntitlements(ctx.tx, ents, byContract);
  return views.map((v) => ({ ...v, customerName: names.get(v.contractId) ?? '' }));
}

/** GET /contracts/overview: portfolio health (status / type / expiry / entitlements / scope / completeness). */
export async function contractsOverview(ctx: Ctx, customerId?: string) {
  ctx.require('contracts:read', customerId ?? null);
  if (customerId) ctx.requireCustomer(customerId);
  const where = customerId ? eq(c.customerId, customerId) : undefined;
  const custSql = customerId ? sql`AND k.customer_id = ${customerId}::uuid` : sql``;
  const today = todayStr();
  const count = sql<number>`count(*)::int`;
  const covering = inArray(c.status, COVERING_STATUSES);
  const coveringSql = sql`k.status IN (${sql.join(COVERING_STATUSES.map((s) => sql`${s}`), sql`, `)})`;
  const firstMonth = monthStart(today);
  const monthEnd = monthStart(today, 12);

  const [[agg], statusRows, typeRows, timelineRows, [scopeRow], [healthRow], statusMap, contracts] = await sequential([
    () => ctx.tx
      .select({
        total: count,
        d30: sql<number>`count(*) filter (where ${covering} and ${c.endDate} >= ${today}::date and ${c.endDate} <= ${addDays(today, 30)}::date)::int`,
        d60: sql<number>`count(*) filter (where ${covering} and ${c.endDate} > ${addDays(today, 30)}::date and ${c.endDate} <= ${addDays(today, 60)}::date)::int`,
        d90: sql<number>`count(*) filter (where ${covering} and ${c.endDate} > ${addDays(today, 60)}::date and ${c.endDate} <= ${addDays(today, 90)}::date)::int`,
        expired: sql<number>`count(*) filter (where ${c.status} = 'expired' or (${covering} and ${c.endDate} < ${today}::date))::int`,
      })
      .from(c)
      .where(where),
    () => ctx.tx.select({ key: c.status, count }).from(c).where(where).groupBy(c.status),
    () => ctx.tx
      .select({ key: schema.configOptions.key, label: schema.configOptions.label, color: schema.configOptions.color, count })
      .from(c)
      .leftJoin(schema.configOptions, eq(schema.configOptions.id, c.typeId))
      .where(where)
      .groupBy(schema.configOptions.key, schema.configOptions.label, schema.configOptions.color),
    () => ctx.tx
      .select({ month: sql<string>`to_char(${c.endDate}, 'YYYY-MM')`, count })
      .from(c)
      .where(and(where, covering, sql`${c.endDate} >= ${firstMonth}::date`, sql`${c.endDate} < ${monthEnd}::date`))
      .groupBy(sql`to_char(${c.endDate}, 'YYYY-MM')`),
    async () =>
      (await ctx.tx.execute(sql`
        SELECT (SELECT count(*)::int FROM contracts k WHERE ${coveringSql} ${custSql} AND NOT EXISTS (SELECT 1 FROM scope_items si WHERE si.contract_id = k.id)) AS without_scope,
          (SELECT count(*)::int FROM tickets t WHERE t.scope_status = 'out_of_scope' AND t.created_at >= now() - interval '30 days' ${customerId ? sql`AND t.customer_id = ${customerId}::uuid` : sql``}) AS out_of_scope_30d`)).rows as Row[],
    async () =>
      (await ctx.tx.execute(sql`
        SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.entity_type = 'contract' AND a.entity_id = k.id AND a.doc_type = 'agreement'))::int AS missing_agreement,
          count(*) FILTER (WHERE k.sla_policy_id IS NULL AND NOT EXISTS (SELECT 1 FROM contract_services cs WHERE cs.contract_id = k.id AND cs.sla_policy_id IS NOT NULL))::int AS no_sla_policy,
          count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM contract_services cs WHERE cs.contract_id = k.id))::int AS no_services
        FROM contracts k WHERE ${coveringSql} ${custSql}`)).rows as Row[],
    () => contractStatusOptions(ctx.tx),
    () => coveringContracts(ctx, customerId),
  ]);

  const statusLabels: Record<string, string> = {};
  const statusColors: Record<string, string> = {};
  for (const s of CONTRACT_STATUSES) {
    const d = statusDisplay(s, statusMap);
    statusLabels[s] = d.statusLabel;
    statusColors[s] = d.statusColor;
  }

  const timeline: { month: string; count: number }[] = [];
  const byMonth = new Map(timelineRows.map((r) => [r.month, r.count]));
  for (let i = 0; i < 12; i++) {
    const m = monthKey(monthStart(today, i));
    timeline.push({ month: m, count: byMonth.get(m) ?? 0 });
  }

  const views = await entitlementViews(ctx, contracts);
  const exhausted = views.filter((v) => v.utilization.exhausted).length;
  const overThreshold = views.filter((v) => v.utilization.overThreshold && !v.utilization.exhausted).length;
  const typeCounts = new Map<string, { key: string | null; label: string | null; color: string | null; count: number }>();
  const typeOpts = await optionLabels(ctx.tx, views.map((v) => v.typeId));
  for (const v of views) {
    const opt = v.typeId ? typeOpts.get(v.typeId) : undefined;
    const key = opt?.key ?? 'none';
    const cur = typeCounts.get(key) ?? { key: opt?.key ?? null, label: opt?.label ?? null, color: opt?.color ?? null, count: 0 };
    cur.count++;
    typeCounts.set(key, cur);
  }

  const expiringSoon = contracts
    .filter((r) => r.contract.endDate >= today)
    .slice(0, 10)
    .map((r) => ({ id: r.contract.id, number: r.contract.number, name: r.contract.name, customerName: r.customerName, endDate: r.contract.endDate, daysLeft: daysBetween(today, r.contract.endDate), status: r.contract.status }));

  return {
    total: agg?.total ?? 0,
    byStatus: fixedBuckets(CONTRACT_STATUSES, statusRows, { labels: statusLabels, colors: statusColors }),
    byType: countBuckets(typeRows) as Bucket[],
    expiring: { d30: agg?.d30 ?? 0, d60: agg?.d60 ?? 0, d90: agg?.d90 ?? 0, expired: agg?.expired ?? 0 },
    expiryTimeline: timeline,
    entitlements: { total: views.length, ok: views.length - overThreshold - exhausted, overThreshold, exhausted, byType: countBuckets([...typeCounts.values()], 'Untyped') },
    scope: { contractsWithoutScope: num(scopeRow?.without_scope), outOfScopeTickets30d: num(scopeRow?.out_of_scope_30d) },
    health: { missingAgreement: num(healthRow?.missing_agreement), noSlaPolicy: num(healthRow?.no_sla_policy), noServices: num(healthRow?.no_services) },
    expiringSoon,
  };
}

export interface EntitlementListRow {
  id: string;
  name: string;
  type: string | null;
  unit: string;
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  period: string;
  periodStart: string | null;
  periodEnd: string | null;
  quantity: number;
  used: number;
  remaining: number;
  pct: number;
  overThreshold: boolean;
  exhausted: boolean;
}

/**
 * GET /contracts/entitlements: every active entitlement on the visible covering
 * contracts with its current-period utilisation, most consumed first.
 */
export async function listEntitlementRows(ctx: Ctx, q: EntitlementListQuery) {
  ctx.require('contracts:read', q.customerId ?? null);
  if (q.customerId) ctx.requireCustomer(q.customerId);
  const contracts = await coveringContracts(ctx, q.customerId);
  const views = await entitlementViews(ctx, contracts);
  const term = q.q?.trim().toLowerCase();
  const rows: EntitlementListRow[] = views
    .map((v) => ({
      id: v.id,
      name: v.name,
      type: v.typeLabel,
      unit: v.unit,
      contractId: v.contractId,
      contractNumber: v.contractNumber ?? '',
      customerId: v.customerId,
      customerName: v.customerName,
      period: v.period,
      periodStart: v.utilization.periodStart ?? null,
      periodEnd: v.utilization.periodEnd ?? null,
      quantity: v.utilization.quantity,
      used: v.utilization.used,
      remaining: v.utilization.remaining,
      pct: v.utilization.pct,
      overThreshold: v.utilization.overThreshold,
      exhausted: v.utilization.exhausted,
    }))
    .filter((r) => {
      if (q.status === 'exhausted' && !r.exhausted) return false;
      if (q.status === 'over_threshold' && !(r.overThreshold && !r.exhausted)) return false;
      if (q.status === 'ok' && (r.overThreshold || r.exhausted)) return false;
      if (term && ![r.name, r.contractNumber, r.customerName, r.type ?? ''].some((s) => s.toLowerCase().includes(term))) return false;
      return true;
    })
    .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  const offset = (q.page - 1) * q.pageSize;
  return { items: rows.slice(offset, offset + q.pageSize), total: rows.length, page: q.page, pageSize: q.pageSize };
}
