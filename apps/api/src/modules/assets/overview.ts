import { and, asc, desc, eq, gte, isNotNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { ASSET_LIFECYCLE } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { type Bucket, type CoverageBuckets, LIFECYCLE_COLORS, EMPTY_COVERAGE, coverageSelect, countBuckets, fixedBuckets, todayStr, addDays, daysBetween } from '@/core/overview';

const { assets, customers, sites, configOptions } = schema;
const category = alias(configOptions, 'ov_asset_category');

/** Assets that are still in service: coverage and end-of-life signals ignore retired / disposed items. */
const inService = notInArray(assets.lifecycleStage, ['retired', 'disposed']);

export interface AssetExpiry {
  id: string;
  tag: string;
  name: string;
  customerName: string | null;
  siteName: string | null;
  kind: 'warranty' | 'amc';
  endDate: string;
  daysLeft: number;
}

export interface AssetsOverviewCore {
  total: number;
  withCi: number;
  withoutCi: number;
  addedLast30d: number;
  byLifecycle: Bucket[];
  byCategory: Bucket[];
  byCustomer: Bucket[];
  bySite: Bucket[];
  warranty: CoverageBuckets;
  amc: CoverageBuckets;
  eol: { past: number; d90: number; d365: number };
  expiringSoon: AssetExpiry[];
}

/**
 * Overview numbers for the assets matching `where` (tenant visibility comes
 * from RLS on the transaction; the caller is responsible for permissions).
 */
export async function assetsOverviewCore(ctx: Ctx, where: SQL | undefined): Promise<AssetsOverviewCore> {
  const today = todayStr();
  const count = sql<number>`count(*)::int`;
  const w = coverageSelect(assets.warrantyEnd, today, inService);
  const a = coverageSelect(assets.amcEnd, today, inService);
  const [[totals], lifecycleRows, categoryRows, customerRows, siteRows] = [
    await ctx.tx
      .select({
        total: count,
        withCi: sql<number>`count(*) filter (where ${assets.ciId} is not null)::int`,
        addedLast30d: sql<number>`count(*) filter (where ${assets.createdAt} >= now() - interval '30 days')::int`,
        wExpired: w.expired,
        wD30: w.d30,
        wD90: w.d90,
        wOk: w.ok,
        wNone: w.none,
        aExpired: a.expired,
        aD30: a.d30,
        aD90: a.d90,
        aOk: a.ok,
        aNone: a.none,
        eolPast: sql<number>`count(*) filter (where ${assets.eolDate} < ${today}::date and ${inService})::int`,
        eolD90: sql<number>`count(*) filter (where ${assets.eolDate} >= ${today}::date and ${assets.eolDate} <= ${addDays(today, 90)}::date and ${inService})::int`,
        eolD365: sql<number>`count(*) filter (where ${assets.eolDate} > ${addDays(today, 90)}::date and ${assets.eolDate} <= ${addDays(today, 365)}::date and ${inService})::int`,
      })
      .from(assets)
      .where(where),
    await ctx.tx.select({ key: assets.lifecycleStage, count }).from(assets).where(where).groupBy(assets.lifecycleStage),
    await ctx.tx.select({ key: category.key, label: category.label, color: category.color, count }).from(assets).leftJoin(category, eq(category.id, assets.categoryId)).where(where).groupBy(category.key, category.label, category.color),
    await ctx.tx.select({ key: assets.customerId, label: customers.name, count }).from(assets).leftJoin(customers, eq(customers.id, assets.customerId)).where(where).groupBy(assets.customerId, customers.name).orderBy(desc(count), asc(customers.name)).limit(8),
    await ctx.tx.select({ key: assets.siteId, label: sites.name, count }).from(assets).leftJoin(sites, eq(sites.id, assets.siteId)).where(where).groupBy(assets.siteId, sites.name).orderBy(desc(count), asc(sites.name)).limit(8),
  ];

  const expiring = async (kind: 'warranty' | 'amc') => {
    const col = kind === 'warranty' ? assets.warrantyEnd : assets.amcEnd;
    const rows = await ctx.tx
      .select({ id: assets.id, tag: assets.tag, name: assets.name, customerName: customers.name, siteName: sites.name, endDate: col })
      .from(assets)
      .leftJoin(customers, eq(customers.id, assets.customerId))
      .leftJoin(sites, eq(sites.id, assets.siteId))
      .where(and(where, isNotNull(col), gte(col, today), inService))
      .orderBy(asc(col), asc(assets.tag))
      .limit(10);
    return rows.map((r): AssetExpiry => ({ id: r.id, tag: r.tag, name: r.name, customerName: r.customerName, siteName: r.siteName, kind, endDate: r.endDate!, daysLeft: daysBetween(today, r.endDate!) }));
  };
  const expiringSoon = [...(await expiring('warranty')), ...(await expiring('amc'))].sort((a, b) => a.daysLeft - b.daysLeft || a.tag.localeCompare(b.tag)).slice(0, 10);

  const t = totals;
  return {
    total: t?.total ?? 0,
    withCi: t?.withCi ?? 0,
    withoutCi: (t?.total ?? 0) - (t?.withCi ?? 0),
    addedLast30d: t?.addedLast30d ?? 0,
    byLifecycle: fixedBuckets(ASSET_LIFECYCLE, lifecycleRows, { colors: LIFECYCLE_COLORS }),
    byCategory: countBuckets(categoryRows, 'Uncategorised'),
    byCustomer: countBuckets(customerRows, 'Unknown customer'),
    bySite: countBuckets(siteRows, 'No site'),
    warranty: t ? { expired: t.wExpired, d30: t.wD30, d90: t.wD90, ok: t.wOk, none: t.wNone } : { ...EMPTY_COVERAGE },
    amc: t ? { expired: t.aExpired, d30: t.aD30, d90: t.aD90, ok: t.aOk, none: t.aNone } : { ...EMPTY_COVERAGE },
    eol: { past: t?.eolPast ?? 0, d90: t?.eolD90 ?? 0, d365: t?.eolD365 ?? 0 },
    expiringSoon,
  };
}

/** GET /assets/overview: fleet-wide (or one customer's) asset health for the Assets overview page. */
export async function assetsOverview(ctx: Ctx, customerId?: string) {
  ctx.require('assets:read', customerId ?? null);
  const conds: SQL[] = [];
  if (customerId) {
    ctx.requireCustomer(customerId);
    conds.push(eq(assets.customerId, customerId));
  }
  const core = await assetsOverviewCore(ctx, conds.length ? and(...conds) : undefined);
  return { ...core, expiringSoon: core.expiringSoon.map(({ siteName: _s, ...e }) => e) };
}
