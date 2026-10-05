import { and, asc, desc, eq, gte, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { COMPLIANCE_POSITIONS, INSTALL_SOURCES } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { type Bucket, type CoverageBuckets, COMPLIANCE_COLORS, INSTALL_SOURCE_COLORS, EMPTY_COVERAGE, coverageSelect, countBuckets, fixedBuckets, todayStr, daysBetween } from '@/core/overview';
import { complianceFor } from './compliance';
import { loadSoftwareSettings } from './settings';
import { titleOf } from './service';

const { softwareInstallations: installs, softwareLicences: licences, customers } = schema;

export interface SoftwareOverview {
  titlesInUse: number;
  installations: number;
  hosts: number;
  unlinked: number;
  stale: number;
  licencesActive: number;
  seatsLicensed: number;
  spendYear: number | null;
  positions: Bucket[];
  byCategory: Bucket[];
  bySource: Bucket[];
  byCustomer: Bucket[];
  renewals: CoverageBuckets;
  topOverDeployed: { productId: string; customerId: string; customerName: string; title: string; installed: number; entitled: number }[];
  renewingSoon: { id: string; name: string; customerId: string; customerName: string | null; title: string; endDate: string; renewalDate: string | null; daysLeft: number }[];
}

/** GET /software/overview: the software estate of every customer the caller sees, or of one customer. */
export async function softwareOverview(ctx: Ctx, customerId?: string): Promise<SoftwareOverview> {
  ctx.require('software:read', customerId ?? null);
  const condsI: SQL[] = [];
  const condsL: SQL[] = [];
  if (customerId) {
    ctx.requireCustomer(customerId);
    condsI.push(eq(installs.customerId, customerId));
    condsL.push(eq(licences.customerId, customerId));
  }
  const whereI = condsI.length ? and(...condsI) : undefined;
  const whereL = condsL.length ? and(...condsL) : undefined;
  const settings = await loadSoftwareSettings(ctx.tx);
  const today = todayStr();
  const count = sql<number>`count(*)::int`;
  const live = and(eq(licences.isActive, true), isNull(licences.successorId))!;
  const inTerm = sql`${licences.isActive} AND (${licences.startDate} IS NULL OR ${licences.startDate} <= ${today}::date) AND (${licences.endDate} IS NULL OR ${licences.endDate} >= ${today}::date)`;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const cov = coverageSelect(licences.endDate, today, live);

  const [installTotals] = await ctx.tx
    .select({
      installations: count,
      hosts: sql<number>`count(DISTINCT coalesce(${installs.ciId}::text, ${installs.assetId}::text, lower(${installs.hostName}))) FILTER (WHERE ${installs.ciId} IS NOT NULL OR ${installs.assetId} IS NOT NULL OR ${installs.hostName} IS NOT NULL)::int`,
      unlinked: sql<number>`count(*) FILTER (WHERE ${installs.ciId} IS NULL AND ${installs.assetId} IS NULL)::int`,
      stale: sql<number>`count(*) FILTER (WHERE ${installs.source} <> 'manual' AND ${installs.lastSeenAt} < now() - make_interval(days => ${settings.staleInstallDays}::int))::int`,
    })
    .from(installs)
    .where(whereI);
  const [licenceTotals] = await ctx.tx
    .select({
      licencesActive: sql<number>`count(*) FILTER (WHERE ${inTerm})::int`,
      seatsLicensed: sql<number>`coalesce(sum(${licences.quantity}) FILTER (WHERE ${inTerm} AND ${licences.metric} <> 'site'), 0)::int`,
      spendYear: sql<string | null>`sum(${licences.cost}) FILTER (WHERE ${licences.isActive} AND coalesce(${licences.startDate}, ${licences.createdAt}::date) >= ${yearStart}::date)`,
      expired: cov.expired, d30: cov.d30, d90: cov.d90, ok: cov.ok, none: cov.none,
    })
    .from(licences)
    .where(whereL);
  const sourceRows = await ctx.tx.select({ key: installs.source, count }).from(installs).where(whereI).groupBy(installs.source);
  const customerRows = customerId ? [] : await ctx.tx.select({ key: installs.customerId, label: customers.name, count }).from(installs).leftJoin(customers, eq(customers.id, installs.customerId)).where(whereI).groupBy(installs.customerId, customers.name).orderBy(desc(count), asc(customers.name)).limit(8);

  const positions = await complianceFor(ctx, { customerId });
  const positionCounts = new Map<string, number>();
  const categoryTitles = new Map<string, Set<string>>();
  for (const p of positions) {
    positionCounts.set(p.position, (positionCounts.get(p.position) ?? 0) + 1);
    const cat = p.categoryLabel ?? 'Uncategorised';
    categoryTitles.set(cat, (categoryTitles.get(cat) ?? new Set()).add(p.productId));
  }
  const renewingRows = await ctx.tx
    .select({ id: licences.id, name: licences.name, customerId: licences.customerId, customerName: customers.name, publisher: schema.softwareProducts.publisher, productName: schema.softwareProducts.name, versionFamily: schema.softwareProducts.versionFamily, endDate: licences.endDate, renewalDate: licences.renewalDate })
    .from(licences)
    .innerJoin(schema.softwareProducts, eq(schema.softwareProducts.id, licences.productId))
    .leftJoin(customers, eq(customers.id, licences.customerId))
    .where(and(whereL, live, isNotNull(licences.endDate), gte(licences.endDate, today)))
    .orderBy(asc(licences.endDate), asc(licences.name))
    .limit(10);

  const t = installTotals;
  const l = licenceTotals;
  return {
    titlesInUse: new Set(positions.filter((p) => p.installed > 0 || p.licencesActive > 0).map((p) => p.productId)).size,
    installations: t?.installations ?? 0,
    hosts: t?.hosts ?? 0,
    unlinked: t?.unlinked ?? 0,
    stale: t?.stale ?? 0,
    licencesActive: l?.licencesActive ?? 0,
    seatsLicensed: l?.seatsLicensed ?? 0,
    spendYear: l?.spendYear === null || l?.spendYear === undefined ? null : Number(l.spendYear),
    positions: fixedBuckets(COMPLIANCE_POSITIONS, [...positionCounts].map(([key, n]) => ({ key, count: n })), { colors: COMPLIANCE_COLORS, labels: { compliant: 'Compliant', under_deployed: 'Under-deployed', over_deployed: 'Over-deployed', unlicensed: 'Unlicensed', unlimited: 'Unlimited' } }),
    byCategory: countBuckets([...categoryTitles].map(([label, ids]) => ({ key: label, label, count: ids.size })), 'Uncategorised'),
    bySource: fixedBuckets(INSTALL_SOURCES, sourceRows, { colors: INSTALL_SOURCE_COLORS, labels: { manual: 'Recorded by hand', csv: 'CSV import', discovery: 'Discovery', agent: 'Agent' } }),
    byCustomer: countBuckets(customerRows, 'Unknown customer'),
    renewals: l ? { expired: l.expired, d30: l.d30, d90: l.d90, ok: l.ok, none: l.none } : { ...EMPTY_COVERAGE },
    topOverDeployed: positions
      .filter((p) => p.position === 'over_deployed' || p.position === 'unlicensed')
      .sort((a, b) => b.installed - (b.entitled ?? 0) - (a.installed - (a.entitled ?? 0)))
      .slice(0, 8)
      .map((p) => ({ productId: p.productId, customerId: p.customerId, customerName: p.customerName, title: titleOf(p), installed: p.installed, entitled: p.entitled ?? 0 })),
    renewingSoon: renewingRows.map((r) => ({ id: r.id, name: r.name, customerId: r.customerId, customerName: r.customerName, title: titleOf({ publisher: r.publisher, name: r.productName, versionFamily: r.versionFamily }), endDate: r.endDate!, renewalDate: r.renewalDate, daysLeft: daysBetween(today, r.endDate!) })),
  };
}
