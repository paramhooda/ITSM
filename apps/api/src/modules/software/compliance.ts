import { inArray, sql } from 'drizzle-orm';
import type { CompliancePosition as Position } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { todayStr, addDays } from '@/core/overview';
import { defaultMetric, loadSoftwareSettings } from './settings';

/**
 * The licence position of every title at every customer in scope: installed
 * (live hosts only, counted by the licence metric) against entitled (seats of
 * the licences in term). Pure maths over two grouped queries; never stored.
 * No permission check of its own: the callers hold software:read, the portal
 * has pinned the customer, the daily job runs as the system.
 */

export interface CompliancePosition {
  customerId: string;
  customerName: string;
  productId: string;
  publisher: string;
  name: string;
  versionFamily: string | null;
  categoryLabel: string | null;
  licenceModel: string;
  /** The metric of the licences in term (the most common one), else the default for the title's licence model. */
  metric: string;
  /** Live hosts only, counted by the metric (devices, distinct users, cores). */
  installed: number;
  /** Sum of the seats of the licences in term; null for a site licence. */
  entitled: number | null;
  unused: number | null;
  utilisationPct: number | null;
  position: Position;
  licencesActive: number;
  nextEndDate: string | null;
  expiringSeats: number;
  /** Installations recorded by import or discovery and not seen for longer than software.stale_install_days (they still count). */
  stale: number;
}

const POSITION_ORDER: Record<Position, number> = { over_deployed: 0, unlicensed: 1, under_deployed: 2, compliant: 3, unlimited: 4 };
export const positionLabel = (p: Position) => ({ compliant: 'Compliant', under_deployed: 'Under-deployed', over_deployed: 'Over-deployed', unlicensed: 'Unlicensed', unlimited: 'Unlimited' })[p];

/** The position for `installed` seats against `entitled`; below `unusedPct` percent used is under-deployed. */
export function computePosition(installed: number, entitled: number | null, unusedPct: number): Position {
  if (entitled === null) return 'unlimited';
  if (entitled <= 0) return installed > 0 ? 'unlicensed' : 'compliant';
  if (installed > entitled) return 'over_deployed';
  if ((installed / entitled) * 100 < unusedPct) return 'under_deployed';
  return 'compliant';
}

export const utilisation = (installed: number, entitled: number | null) => (entitled && entitled > 0 ? Math.round((installed / entitled) * 100) : null);

interface InstallRow { customerId: string; productId: string; byDevice: number; byUser: number; byCore: number; stale: number }
interface LicenceRow { customerId: string; productId: string; entitled: string | null; expiringSeats: string | null; nextEndDate: string | null; licencesActive: number; metric: string | null; hasSite: boolean }

export async function complianceFor(ctx: Ctx, scope: { customerId?: string | null; productId?: string | null }): Promise<CompliancePosition[]> {
  const settings = await loadSoftwareSettings(ctx.tx);
  const today = todayStr();
  const horizon = addDays(today, Math.max(0, ...settings.noticeDays));
  // Plain column names inside the raw queries: the table aliases `i` and `l` are set in the FROM clauses below.
  const scopeI = sql`${scope.customerId ? sql`AND i.customer_id = ${scope.customerId}::uuid` : sql``} ${scope.productId ? sql`AND i.product_id = ${scope.productId}::uuid` : sql``}`;
  const scopeL = sql`${scope.customerId ? sql`AND l.customer_id = ${scope.customerId}::uuid` : sql``} ${scope.productId ? sql`AND l.product_id = ${scope.productId}::uuid` : sql``}`;
  const inTerm = sql`l.is_active AND (l.start_date IS NULL OR l.start_date <= ${today}::date) AND (l.end_date IS NULL OR l.end_date >= ${today}::date)`;

  const installs = (await ctx.tx.execute(sql`
    SELECT i.customer_id AS "customerId", i.product_id AS "productId",
      count(*)::int AS "byDevice",
      (count(DISTINCT lower(i.assigned_user)) + count(*) FILTER (WHERE i.assigned_user IS NULL))::int AS "byUser",
      coalesce(sum(coalesce(i.cores, 1)), 0)::int AS "byCore",
      count(*) FILTER (WHERE i.source <> 'manual' AND i.last_seen_at < now() - make_interval(days => ${settings.staleInstallDays}::int))::int AS "stale"
    FROM software_installations i
    LEFT JOIN cis c ON c.id = i.ci_id
    LEFT JOIN assets a ON a.id = i.asset_id
    WHERE (c.id IS NULL OR c.status <> 'retired') AND (a.id IS NULL OR a.lifecycle_stage NOT IN ('retired', 'disposed')) ${scopeI}
    GROUP BY i.customer_id, i.product_id`)).rows as unknown as InstallRow[];

  const licences = (await ctx.tx.execute(sql`
    SELECT l.customer_id AS "customerId", l.product_id AS "productId",
      sum(l.quantity) FILTER (WHERE ${inTerm}) AS "entitled",
      sum(l.quantity) FILTER (WHERE ${inTerm} AND l.successor_id IS NULL AND l.end_date <= ${horizon}::date) AS "expiringSeats",
      min(l.end_date) FILTER (WHERE ${inTerm} AND l.successor_id IS NULL AND l.end_date >= ${today}::date)::text AS "nextEndDate",
      count(*) FILTER (WHERE ${inTerm})::int AS "licencesActive",
      mode() WITHIN GROUP (ORDER BY l.metric) FILTER (WHERE ${inTerm}) AS "metric",
      coalesce(bool_or(${inTerm} AND l.metric = 'site'), false) AS "hasSite"
    FROM software_licences l
    WHERE true ${scopeL}
    GROUP BY l.customer_id, l.product_id`)).rows as unknown as LicenceRow[];

  const keyOf = (r: { customerId: string; productId: string }) => `${r.customerId}:${r.productId}`;
  const pairs = new Map<string, { customerId: string; productId: string; install?: InstallRow; licence?: LicenceRow }>();
  for (const r of installs) pairs.set(keyOf(r), { customerId: r.customerId, productId: r.productId, install: r });
  for (const r of licences) pairs.set(keyOf(r), { ...(pairs.get(keyOf(r)) ?? { customerId: r.customerId, productId: r.productId }), licence: r });
  if (!pairs.size) return [];

  const productIds = [...new Set([...pairs.values()].map((p) => p.productId))];
  const customerIds = [...new Set([...pairs.values()].map((p) => p.customerId))];
  const p = schema.softwareProducts;
  const products = await ctx.tx
    .select({ id: p.id, publisher: p.publisher, name: p.name, versionFamily: p.versionFamily, licenceModel: p.licenceModel, categoryLabel: schema.configOptions.label })
    .from(p)
    .leftJoin(schema.configOptions, sql`${schema.configOptions.id} = ${p.categoryId}`)
    .where(inArray(p.id, productIds));
  const customers = await ctx.tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(inArray(schema.customers.id, customerIds));
  const productById = new Map(products.map((x) => [x.id, x]));
  const customerById = new Map(customers.map((x) => [x.id, x.name]));

  const out: CompliancePosition[] = [];
  for (const pair of pairs.values()) {
    const product = productById.get(pair.productId);
    if (!product) continue;
    const lic = pair.licence;
    const metric = lic?.hasSite ? 'site' : lic?.metric ?? defaultMetric(product.licenceModel);
    const installed = metric === 'per_user' ? pair.install?.byUser ?? 0 : metric === 'per_core' ? pair.install?.byCore ?? 0 : pair.install?.byDevice ?? 0;
    const entitled = metric === 'site' ? null : Math.round(Number(lic?.entitled ?? 0));
    const position = computePosition(installed, entitled, settings.unusedSeatPct);
    out.push({
      customerId: pair.customerId,
      customerName: customerById.get(pair.customerId) ?? 'Unknown customer',
      productId: pair.productId,
      publisher: product.publisher,
      name: product.name,
      versionFamily: product.versionFamily,
      categoryLabel: product.categoryLabel ?? null,
      licenceModel: product.licenceModel,
      metric,
      installed,
      entitled,
      unused: entitled === null ? null : Math.max(0, entitled - installed),
      utilisationPct: utilisation(installed, entitled),
      position,
      licencesActive: lic?.licencesActive ?? 0,
      nextEndDate: lic?.nextEndDate ?? null,
      expiringSeats: Math.round(Number(lic?.expiringSeats ?? 0)),
      stale: pair.install?.stale ?? 0,
    });
  }
  return out.sort((a, b) => POSITION_ORDER[a.position] - POSITION_ORDER[b.position] || a.publisher.localeCompare(b.publisher) || a.name.localeCompare(b.name) || a.customerName.localeCompare(b.customerName));
}

/** The row for one customer and title, or null when neither an installation nor a licence exists. */
export async function positionFor(ctx: Ctx, customerId: string, productId: string): Promise<CompliancePosition | null> {
  return (await complianceFor(ctx, { customerId, productId }))[0] ?? null;
}
