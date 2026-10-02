import { eq, sql } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { type Bucket, countBuckets, num, pct1, todayStr, addDays } from '@/core/overview';
import { optionLabels, sequential } from '@/modules/contracts/common';
import { COVERING_STATUSES } from '@/modules/contracts/schemas';
import { entitlementSummary } from '@/modules/contracts/entitlements';

const cu = schema.customers;

type Row = Record<string, unknown>;

export interface CustomerAttention {
  id: string;
  name: string;
  code: string;
  openTickets: number;
  openP1: number;
  breached: number;
  slaCompliance30d: number | null;
  contractsExpiring60d: number;
  entitlementsOverThreshold: number;
}

/**
 * GET /customers/overview: the customer base at a glance plus the accounts that
 * need attention (open P1/P2 work, SLA breaches, expiring contracts, hot entitlements).
 */
export async function customersOverview(ctx: Ctx) {
  ctx.require('customers:read');
  const today = todayStr();
  const count = sql<number>`count(*)::int`;
  const open = sql`EXISTS (SELECT 1 FROM config_options o WHERE o.id = t.status_id AND o.status_category IN ('new', 'open', 'pending'))`;
  const breached = sql`EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = t.id AND (s.state = 'breached' OR (s.state = 'running' AND s.due_at < now())))`;

  const [[totals], statusRows, typeRows, industryRows, customersList, ticketRows, slaRows, contractRows, ents] = await sequential([
    () => ctx.tx.select({ total: count, active: sql<number>`count(*) filter (where ${cu.isActive})::int`, inactive: sql<number>`count(*) filter (where not ${cu.isActive})::int`, newLast90d: sql<number>`count(*) filter (where ${cu.createdAt} >= now() - interval '90 days')::int` }).from(cu),
    () => ctx.tx.select({ id: cu.statusId, count }).from(cu).groupBy(cu.statusId),
    () => ctx.tx.select({ id: cu.typeId, count }).from(cu).groupBy(cu.typeId),
    () => ctx.tx.select({ id: cu.industryId, count }).from(cu).groupBy(cu.industryId),
    () => ctx.tx.select({ id: cu.id, name: cu.name, code: cu.code }).from(cu).where(eq(cu.isActive, true)),
    async () =>
      (await ctx.tx.execute(sql`
        SELECT t.customer_id AS id, count(*)::int AS open, count(*) FILTER (WHERE pr.level = 1)::int AS p1, count(*) FILTER (WHERE pr.level <= 2)::int AS p12, count(*) FILTER (WHERE ${breached})::int AS breached
        FROM tickets t LEFT JOIN config_options pr ON pr.id = t.priority_id WHERE ${open} GROUP BY t.customer_id`)).rows as Row[],
    async () =>
      (await ctx.tx.execute(sql`
        SELECT s.customer_id AS id, count(*) FILTER (WHERE s.state = 'met')::int AS met, count(*) FILTER (WHERE s.state = 'breached')::int AS breached
        FROM ticket_slas s WHERE s.metric = 'resolution' AND s.state IN ('met', 'breached') AND s.started_at >= now() - interval '30 days' GROUP BY s.customer_id`)).rows as Row[],
    async () =>
      (await ctx.tx.execute(sql`
        SELECT k.customer_id AS id, count(*)::int AS expiring FROM contracts k
        WHERE k.status IN (${sql.join(COVERING_STATUSES.map((s) => sql`${s}`), sql`, `)}) AND k.end_date >= ${today}::date AND k.end_date <= ${addDays(today, 60)}::date GROUP BY k.customer_id`)).rows as Row[],
    () => entitlementSummary(ctx, undefined, 100_000),
  ]);

  const labels = await optionLabels(ctx.tx, [...statusRows.map((r) => r.id), ...typeRows.map((r) => r.id), ...industryRows.map((r) => r.id)]);
  const bucket = (rows: { id: string | null; count: number }[]): Bucket[] =>
    countBuckets(rows.map((r) => {
      const opt = r.id ? labels.get(r.id) : undefined;
      return { key: opt?.key ?? null, label: opt?.label ?? null, color: opt?.color ?? null, count: r.count };
    }));

  const tickets = new Map(ticketRows.map((r) => [String(r.id), r]));
  const sla = new Map(slaRows.map((r) => [String(r.id), r]));
  const contracts = new Map(contractRows.map((r) => [String(r.id), num(r.expiring)]));
  const hotEntitlements = new Map<string, number>();
  for (const e of ents.items) if (e.utilization.overThreshold || e.utilization.exhausted) hotEntitlements.set(e.customerId, (hotEntitlements.get(e.customerId) ?? 0) + 1);

  const rows = customersList.map((c) => {
    const t = tickets.get(c.id);
    const s = sla.get(c.id);
    const met = num(s?.met);
    const slaBreached = num(s?.breached);
    return {
      id: c.id,
      name: c.name,
      code: c.code,
      openTickets: num(t?.open),
      openP1: num(t?.p1),
      openP12: num(t?.p12),
      breached: num(t?.breached),
      met,
      slaBreached,
      slaCompliance30d: pct1(met, met + slaBreached),
      contractsExpiring60d: contracts.get(c.id) ?? 0,
      entitlementsOverThreshold: hotEntitlements.get(c.id) ?? 0,
    };
  });

  const attention: CustomerAttention[] = rows
    .filter((r) => r.openTickets > 0 || r.breached > 0 || r.contractsExpiring60d > 0 || r.entitlementsOverThreshold > 0)
    .sort((a, b) => b.openP12 - a.openP12 || b.breached - a.breached || b.openTickets - a.openTickets || b.contractsExpiring60d - a.contractsExpiring60d || b.entitlementsOverThreshold - a.entitlementsOverThreshold || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map(({ openP12: _p, met: _m, slaBreached: _b, ...r }) => r);

  const slaByCustomer = rows
    .filter((r) => r.met + r.slaBreached > 0)
    .map((r) => ({ id: r.id, name: r.name, met: r.met, breached: r.slaBreached, compliancePct: r.slaCompliance30d }))
    .sort((a, b) => (a.compliancePct ?? 0) - (b.compliancePct ?? 0) || b.breached - a.breached || a.name.localeCompare(b.name));

  return {
    total: totals?.total ?? 0,
    active: totals?.active ?? 0,
    inactive: totals?.inactive ?? 0,
    newLast90d: totals?.newLast90d ?? 0,
    byStatus: bucket(statusRows),
    byType: bucket(typeRows),
    byIndustry: bucket(industryRows),
    attention,
    slaByCustomer,
    contractsExpiring60d: contractRows.reduce((s, r) => s + num(r.expiring), 0),
    entitlementsOverThreshold: [...hotEntitlements.values()].reduce((s, n) => s + n, 0),
  };
}
