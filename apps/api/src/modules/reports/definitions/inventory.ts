import { sql } from 'drizzle-orm';
import { registerReport, type ReportResult } from '../registry';
import { rows, customerCond, limitSql, num, col, numParam, listParam, strParam, inUuids, customerParam } from './helpers';

const groupCount = (list: Record<string, unknown>[], key: string, fallback = 'Unspecified') => {
  const m = new Map<string, number>();
  for (const r of list) m.set(String(r[key] ?? fallback), (m.get(String(r[key] ?? fallback)) ?? 0) + 1);
  return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
};

// ---------------------------------------------------------------- asset_register
registerReport({
  key: 'asset_register',
  name: 'Asset register',
  description: 'Assets with warranty and AMC coverage status; highlights warranties/AMCs expiring within N days.',
  category: 'assets',
  permissions: ['reports:run', 'assets:read'],
  portal: true,
  parameters: [customerParam, { key: 'expiringDays', label: 'Expiring within (days)', type: 'number', default: 90 }, { key: 'categoryIds', label: 'Category', type: 'multiselect', optionType: 'asset_category' }, { key: 'lifecycle', label: 'Lifecycle', type: 'select', options: ['ordered', 'in_stock', 'deployed', 'in_repair', 'retired', 'disposed'].map((s) => ({ value: s, label: s.replace('_', ' ') })) }, { key: 'expiringOnly', label: 'Only expiring / expired coverage', type: 'boolean' }],
  async run(ctx, p): Promise<ReportResult> {
    const days = numParam(p, 'expiringDays', 90, 0, 3650);
    const lifecycle = strParam(p, 'lifecycle');
    const expiringOnly = p.expiringOnly === true || p.expiringOnly === 'true';
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT a.id, a.tag, a.name, cu.name AS customer, si.name AS site, cat.label AS category, a.lifecycle_stage, a.manufacturer, a.model, a.serial_number, a.location, a.purchase_date, a.warranty_end,
        CASE WHEN a.warranty_end IS NULL THEN 'none' WHEN a.warranty_end < current_date THEN 'expired' WHEN a.warranty_end <= current_date + ${days}::int THEN 'expiring' ELSE 'active' END AS warranty_status,
        c.number AS amc_contract, a.amc_end,
        CASE WHEN a.amc_end IS NULL AND c.id IS NULL THEN 'none' WHEN coalesce(a.amc_end, c.end_date) < current_date THEN 'expired' WHEN coalesce(a.amc_end, c.end_date) <= current_date + ${days}::int THEN 'expiring' ELSE 'active' END AS amc_status,
        a.eol_date, a.eos_date, ci.name AS ci
      FROM assets a LEFT JOIN customers cu ON cu.id = a.customer_id LEFT JOIN sites si ON si.id = a.site_id LEFT JOIN config_options cat ON cat.id = a.category_id LEFT JOIN contracts c ON c.id = a.amc_contract_id LEFT JOIN cis ci ON ci.id = a.ci_id
      WHERE true ${customerCond(p.customerId, sql`a.customer_id`)} ${inUuids(sql`a.category_id`, listParam(p, 'categoryIds'))} ${lifecycle ? sql`AND a.lifecycle_stage = ${lifecycle}` : sql``}
        ${expiringOnly ? sql`AND ((a.warranty_end IS NOT NULL AND a.warranty_end <= current_date + ${days}::int) OR (coalesce(a.amc_end, c.end_date) IS NOT NULL AND coalesce(a.amc_end, c.end_date) <= current_date + ${days}::int))` : sql``}
      ORDER BY cu.name, a.tag ${limitSql()}`);
    return {
      columns: [col('tag', 'Tag'), col('name', 'Name'), col('customer', 'Customer'), col('site', 'Site'), col('category', 'Category'), col('lifecycle_stage', 'Lifecycle'), col('manufacturer', 'Manufacturer'), col('model', 'Model'), col('serial_number', 'Serial'), col('warranty_end', 'Warranty end', 'date'), col('warranty_status', 'Warranty'), col('amc_contract', 'AMC contract'), col('amc_end', 'AMC end', 'date'), col('amc_status', 'AMC'), col('eol_date', 'EOL', 'date'), col('ci', 'CI')],
      rows: list,
      summary: [
        { label: 'Assets', value: list.length },
        { label: `Warranty expiring (${days}d)`, value: list.filter((r) => r.warranty_status === 'expiring').length },
        { label: 'Warranty expired', value: list.filter((r) => r.warranty_status === 'expired').length },
        { label: `AMC expiring (${days}d)`, value: list.filter((r) => r.amc_status === 'expiring').length },
        { label: 'No AMC', value: list.filter((r) => r.amc_status === 'none').length },
      ],
      charts: [
        { type: 'bar', title: 'Assets by category', data: groupCount(list, 'category').slice(0, 12), x: 'label', y: 'count' },
        { type: 'bar', title: 'Warranty status', data: groupCount(list, 'warranty_status'), x: 'label', y: 'count' },
      ],
    };
  },
});

// ---------------------------------------------------------------- cmdb_inventory
registerReport({
  key: 'cmdb_inventory',
  name: 'CMDB inventory',
  description: 'Configuration items by type, site, status and criticality; flags CIs not seen by discovery/monitoring recently.',
  category: 'cmdb',
  permissions: ['reports:run', 'cmdb:read'],
  portal: true,
  parameters: [customerParam, { key: 'staleDays', label: 'Stale after (days)', type: 'number', default: 30 }, { key: 'typeIds', label: 'CI type', type: 'multiselect', optionType: 'ci_type' }, { key: 'status', label: 'Status', type: 'select', options: ['planned', 'active', 'inactive', 'maintenance', 'retired'].map((s) => ({ value: s, label: s })) }, { key: 'criticality', label: 'Criticality', type: 'select', options: ['critical', 'high', 'medium', 'low'].map((s) => ({ value: s, label: s })) }],
  async run(ctx, p): Promise<ReportResult> {
    const stale = numParam(p, 'staleDays', 30, 1, 3650);
    const status = strParam(p, 'status');
    const criticality = strParam(p, 'criticality');
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT c.id, c.name, ty.name AS type, cu.name AS customer, si.name AS site, c.status, c.criticality, c.environment, c.hostname, c.ip_address, c.manufacturer, c.model, c.serial_number, c.os_name, c.discovery_source, c.last_seen_at,
        (c.last_seen_at IS NULL OR c.last_seen_at < now() - make_interval(days => ${stale}::int)) AS stale, (c.monitoring_ref IS NOT NULL) AS monitored, tm.name AS owner_team,
        (SELECT count(*)::int FROM ci_relationships r WHERE r.source_ci_id = c.id OR r.target_ci_id = c.id) AS relationships,
        (SELECT count(*)::int FROM tickets t WHERE t.primary_ci_id = c.id AND t.created_at >= now() - interval '90 days') AS tickets_90d
      FROM cis c JOIN ci_types ty ON ty.id = c.type_id LEFT JOIN customers cu ON cu.id = c.customer_id LEFT JOIN sites si ON si.id = c.site_id LEFT JOIN teams tm ON tm.id = c.owner_team_id
      WHERE true ${customerCond(p.customerId, sql`c.customer_id`)} ${inUuids(sql`c.type_id`, listParam(p, 'typeIds'))} ${status ? sql`AND c.status = ${status}` : sql``} ${criticality ? sql`AND c.criticality = ${criticality}` : sql``}
      ORDER BY cu.name, ty.name, c.name ${limitSql()}`);
    return {
      columns: [col('name', 'Name'), col('type', 'Type'), col('customer', 'Customer'), col('site', 'Site'), col('status', 'Status'), col('criticality', 'Criticality'), col('environment', 'Environment'), col('hostname', 'Hostname'), col('ip_address', 'IP'), col('manufacturer', 'Manufacturer'), col('model', 'Model'), col('os_name', 'OS'), col('monitored', 'Monitored', 'boolean'), col('last_seen_at', 'Last seen', 'datetime'), col('stale', 'Stale', 'boolean'), col('relationships', 'Relations', 'number'), col('tickets_90d', 'Tickets 90d', 'number')],
      rows: list,
      summary: [
        { label: 'Configuration items', value: list.length },
        { label: 'Active', value: list.filter((r) => r.status === 'active').length },
        { label: 'Critical', value: list.filter((r) => r.criticality === 'critical').length },
        { label: `Stale (> ${stale}d)`, value: list.filter((r) => r.stale).length },
        { label: 'Monitored', value: list.filter((r) => r.monitored).length },
        { label: 'With incidents (90d)', value: list.filter((r) => num(r.tickets_90d) > 0).length },
      ],
      charts: [
        { type: 'bar', title: 'CIs by type', data: groupCount(list, 'type').slice(0, 12), x: 'label', y: 'count' },
        { type: 'bar', title: 'CIs by status', data: groupCount(list, 'status'), x: 'label', y: 'count' },
      ],
      sections: [{ title: 'By site', columns: [col('label', 'Site'), col('count', 'CIs', 'number')], rows: groupCount(list, 'site', 'No site').slice(0, 50) }],
    };
  },
});
