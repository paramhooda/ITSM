import { sql } from 'drizzle-orm';
import { registerReport, type ReportResult } from '../registry';
import { rows, customerCond, rangeCond, limitSql, col, strParam, customerParam, dateRangeParam } from './helpers';

registerReport({
  key: 'audit_activity',
  name: 'Audit activity',
  description: 'Who changed what: audit trail entries in the period by user, entity and action.',
  category: 'audit',
  permissions: ['reports:run', 'admin:audit'],
  portal: false,
  parameters: [customerParam, dateRangeParam, { key: 'entityType', label: 'Entity type', type: 'text' }, { key: 'action', label: 'Action', type: 'text' }, { key: 'userEmail', label: 'User email', type: 'text' }],
  // audit volume compared with the previous period is noise
  compare: false,
  defaultDateRange: 'last_7_days',
  async run(ctx, p): Promise<ReportResult> {
    const entityType = strParam(p, 'entityType');
    const action = strParam(p, 'action');
    const userEmail = strParam(p, 'userEmail');
    const filters = sql`${rangeCond(sql`l.occurred_at`, p.from, p.to)} ${customerCond(p.customerId, sql`l.customer_id`)} ${entityType ? sql`AND l.entity_type = ${entityType}` : sql``} ${action ? sql`AND l.action = ${action}` : sql``} ${userEmail ? sql`AND lower(u.email) = ${userEmail.toLowerCase()}` : sql``}`;
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT l.id, l.occurred_at, coalesce(u.name, l.user_name, 'system') AS user_name, u.email AS user_email, cu.name AS customer, l.entity_type, l.entity_label, l.entity_id, l.action, l.source, l.ip, l.request_id,
        (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(l.changes) k) AS changed_fields
      FROM audit_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN customers cu ON cu.id = l.customer_id
      WHERE true ${filters} ORDER BY l.occurred_at DESC ${limitSql(20000)}`);
    const byDay = await rows<{ day: string; count: number }>(ctx, sql`
      SELECT l.occurred_at::date::text AS day, count(*)::int AS count FROM audit_log l LEFT JOIN users u ON u.id = l.user_id WHERE true ${filters} GROUP BY 1 ORDER BY 1`);
    const group = (k: string) => {
      const m = new Map<string, number>();
      for (const r of list) m.set(String(r[k] ?? '—'), (m.get(String(r[k] ?? '—')) ?? 0) + 1);
      return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
    };
    return {
      columns: [col('occurred_at', 'When', 'datetime'), col('user_name', 'User'), col('user_email', 'Email'), col('customer', 'Customer'), col('entity_type', 'Entity'), col('entity_label', 'Record'), col('action', 'Action'), col('changed_fields', 'Changed fields'), col('source', 'Source'), col('ip', 'IP')],
      rows: list,
      summary: [
        { label: 'Entries', value: list.length },
        { label: 'Users', value: new Set(list.map((r) => r.user_email ?? r.user_name)).size },
        { label: 'Entity types', value: new Set(list.map((r) => r.entity_type)).size },
        { label: 'Top action', value: group('action')[0]?.label ?? '—', hint: group('action')[0] ? `${group('action')[0]!.count} entries` : undefined },
      ],
      charts: [
        { type: 'line', title: 'Audit entries per day', data: byDay, x: 'day', y: 'count', labels: { count: 'Entries' } },
        { type: 'bar', title: 'By entity type', data: group('entity_type').slice(0, 12), x: 'label', y: 'count', horizontal: true },
        { type: 'bar', title: 'By action', data: group('action').slice(0, 10), x: 'label', y: 'count', horizontal: true, insight: 'none' },
      ],
      sections: [{ title: 'Most active users', columns: [col('label', 'User'), col('count', 'Entries', 'number')], rows: group('user_name').slice(0, 20) }],
    };
  },
});
