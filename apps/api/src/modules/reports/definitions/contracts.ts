import { sql } from 'drizzle-orm';
import { registerReport, type ReportResult } from '../registry';
import { rows, customerCond, rangeCond, limitSql, pct, num, col, countsOf, numParam, boolParam, customerParam, dateRangeParam } from './helpers';
import { decorateEntitlements } from '@/modules/contracts/entitlements';
import { schema } from '@/db/client';
import { and, eq, inArray } from 'drizzle-orm';

const COVERING = ['active', 'expiring'];

// ---------------------------------------------------------------- amc_utilization
registerReport({
  key: 'amc_utilization',
  name: 'AMC entitlement utilization',
  description: 'Entitlements per contract with quantity, used, remaining and utilization %, plus the consumption detail for the period.',
  category: 'amc',
  permissions: ['reports:run', 'contracts:read'],
  portal: true,
  parameters: [customerParam, dateRangeParam, { key: 'includeInactive', label: 'Include expired contracts', type: 'boolean' }],
  async run(ctx, p): Promise<ReportResult> {
    const conds = [];
    if (p.customerId) conds.push(eq(schema.contracts.customerId, p.customerId));
    if (!boolParam(p, 'includeInactive')) conds.push(inArray(schema.contracts.status, COVERING));
    const contracts = await ctx.tx.select().from(schema.contracts).where(conds.length ? and(...conds) : undefined).limit(2000);
    const ents = contracts.length ? await ctx.tx.select().from(schema.contractEntitlements).where(and(inArray(schema.contractEntitlements.contractId, contracts.map((c) => c.id)), eq(schema.contractEntitlements.isActive, true))) : [];
    const views = await decorateEntitlements(ctx.tx, ents, new Map(contracts.map((c) => [c.id, c])));
    const customerNames = new Map((contracts.length ? await ctx.tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(inArray(schema.customers.id, [...new Set(contracts.map((c) => c.customerId))])) : []).map((c) => [c.id, c.name]));
    const table = views
      .map((v) => ({ id: v.id, customer: customerNames.get(v.customerId) ?? '', contract: v.contractNumber, contract_name: v.contractName, contract_status: v.contractStatus, entitlement: v.name, type: v.typeLabel, service: v.serviceName, unit: v.unit, period: v.utilization.period, period_start: v.utilization.periodStart, period_end: v.utilization.periodEnd, quantity: v.utilization.quantity, used: v.utilization.used, remaining: v.utilization.remaining, pct: v.utilization.pct, warn_threshold_pct: v.warnThresholdPct, status: v.utilization.exhausted ? 'exhausted' : v.utilization.overThreshold ? 'warning' : 'ok' }))
      .sort((a, b) => b.pct - a.pct);
    const consumption = ents.length
      ? await rows<Record<string, unknown>>(ctx, sql`
        SELECT c.consumed_at, e.name AS entitlement, ct.number AS contract, cu.name AS customer, c.quantity, e.unit, c.source_type, t.number AS ticket, c.notes, u.name AS recorded_by
        FROM entitlement_consumptions c JOIN contract_entitlements e ON e.id = c.entitlement_id JOIN contracts ct ON ct.id = e.contract_id LEFT JOIN customers cu ON cu.id = c.customer_id LEFT JOIN tickets t ON t.id = c.ticket_id LEFT JOIN users u ON u.id = c.created_by
        WHERE e.id = ANY(ARRAY[${sql.join(ents.map((e) => sql`${e.id}::uuid`), sql`, `)}]) ${rangeCond(sql`c.consumed_at`, p.from, p.to)} ${customerCond(p.customerId, sql`c.customer_id`)}
        ORDER BY c.consumed_at DESC ${limitSql(5000)}`)
      : [];
    const avg = table.length ? Math.round((table.reduce((s, r) => s + r.pct, 0) / table.length) * 10) / 10 : null;
    const exhausted = table.filter((r) => r.status === 'exhausted');
    const chartLabel = (r: (typeof table)[number]) => `${r.entitlement} (${r.contract})`;
    return {
      columns: [col('customer', 'Customer'), col('contract', 'Contract'), col('entitlement', 'Entitlement'), col('type', 'Type'), col('service', 'Service'), col('unit', 'Unit'), col('period', 'Period'), col('period_start', 'Window start', 'date'), col('period_end', 'Window end', 'date'), col('quantity', 'Quantity', 'number'), col('used', 'Used', 'number'), col('remaining', 'Remaining', 'number'), col('pct', 'Utilization', 'pct'), col('status', 'Status')],
      rows: table,
      summary: [
        { label: 'Entitlements', value: table.length },
        { label: 'Average utilization', value: avg ?? 'n/a', unit: 'pct' },
        { label: 'Over threshold', value: table.filter((r) => r.status === 'warning').length, tone: table.some((r) => r.status === 'warning') ? 'warn' : undefined },
        { label: 'Exhausted', value: exhausted.length, tone: exhausted.length ? 'bad' : 'good' },
        { label: 'Consumptions in period', value: consumption.length, hint: `${Math.round(consumption.reduce((s, r) => s + num(r.quantity), 0) * 100) / 100} units` },
      ],
      charts: [
        { type: 'bar', title: 'Utilization % (top 15)', subtitle: 'Used over entitled in the current window', data: table.slice(0, 15).map((r) => ({ label: chartLabel(r), pct: r.pct })), x: 'label', y: 'pct', labels: { pct: 'Utilization %' }, horizontal: true, unit: 'pct', target: 80, emphasis: exhausted[0] ? chartLabel(exhausted[0]) : undefined, insight: 'none' },
        { type: 'donut', title: 'Entitlement positions', data: [{ label: 'Within threshold', count: table.filter((r) => r.status === 'ok').length }, { label: 'Over threshold', count: table.filter((r) => r.status === 'warning').length }, { label: 'Exhausted', count: exhausted.length }].filter((d) => d.count > 0), x: 'label', y: 'count', insight: 'none' },
      ],
      sections: [{ title: 'Consumption detail', columns: [col('consumed_at', 'Date', 'datetime'), col('customer', 'Customer'), col('contract', 'Contract'), col('entitlement', 'Entitlement'), col('quantity', 'Quantity', 'number'), col('unit', 'Unit'), col('source_type', 'Source'), col('ticket', 'Ticket'), col('recorded_by', 'Recorded by'), col('notes', 'Notes')], rows: consumption }],
    };
  },
});

// ---------------------------------------------------------------- contract_expiry
registerReport({
  key: 'contract_expiry',
  name: 'Contract expiry',
  description: 'Contracts expiring within the next N days (and optionally already expired) with renewal and owner details.',
  category: 'contracts',
  permissions: ['reports:run', 'contracts:read'],
  portal: true,
  parameters: [customerParam, { key: 'days', label: 'Expiring within (days)', type: 'number', default: 90 }, { key: 'includeExpired', label: 'Include expired (last 90 days)', type: 'boolean' }],
  async run(ctx, p): Promise<ReportResult> {
    const days = numParam(p, 'days', 90, 0, 3650);
    const includeExpired = boolParam(p, 'includeExpired');
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT c.id, c.number, c.name, cu.name AS customer, ty.label AS type, c.status, c.start_date, c.end_date, (c.end_date - current_date)::int AS days_to_expiry, c.renewal_date, c.auto_renew, c.notice_period_days, u.name AS owner,
        (SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM contract_services cs JOIN services s ON s.id = cs.service_id WHERE cs.contract_id = c.id) AS services,
        (SELECT count(*)::int FROM contract_entitlements e WHERE e.contract_id = c.id AND e.is_active) AS entitlements
      FROM contracts c JOIN customers cu ON cu.id = c.customer_id LEFT JOIN config_options ty ON ty.id = c.type_id LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE ((c.status IN ('active', 'expiring') AND c.end_date >= current_date AND c.end_date <= current_date + ${days}::int)
        ${includeExpired ? sql`OR (c.status = 'expired' AND c.end_date >= current_date - 90)` : sql``}) ${customerCond(p.customerId, sql`c.customer_id`)}
      ORDER BY c.end_date ${limitSql(5000)}`);
    const months = new Map<string, number>();
    for (const r of list) {
      const k = String(r.end_date).slice(0, 7);
      months.set(k, (months.get(k) ?? 0) + 1);
    }
    const expiring = list.filter((r) => r.status !== 'expired');
    const thisMonth = new Date().toISOString().slice(0, 7);
    return {
      columns: [col('number', 'Number'), col('name', 'Contract'), col('customer', 'Customer'), col('type', 'Type'), col('status', 'Status'), col('start_date', 'Start', 'date'), col('end_date', 'End', 'date'), col('days_to_expiry', 'Days left', 'number'), col('renewal_date', 'Renewal date', 'date'), col('auto_renew', 'Auto-renew', 'boolean'), col('owner', 'Owner'), col('services', 'Services'), col('entitlements', 'Entitlements', 'number')],
      rows: list,
      summary: [
        { label: `Expiring within ${days} days`, value: expiring.length },
        { label: 'Expiring within 30 days', value: expiring.filter((r) => num(r.days_to_expiry) <= 30).length, tone: expiring.some((r) => num(r.days_to_expiry) <= 30) ? 'warn' : undefined },
        { label: 'Auto-renew', value: expiring.filter((r) => r.auto_renew).length },
        { label: 'Expired (90 days)', value: list.filter((r) => r.status === 'expired').length, tone: list.some((r) => r.status === 'expired') ? 'bad' : undefined },
      ],
      charts: [
        { type: 'bar', title: 'Contracts ending per month', data: [...months].sort().map(([label, count]) => ({ label, count })), x: 'label', y: 'count', emphasis: thisMonth, insight: 'none' },
        { type: 'donut', title: 'Ending contracts by type', data: countsOf(list, 'type'), x: 'label', y: 'count', insight: 'none' },
      ],
    };
  },
});

