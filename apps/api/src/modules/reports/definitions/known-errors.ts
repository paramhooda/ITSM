import { sql } from 'drizzle-orm';
import { KNOWN_ERROR_STATUS_LABELS } from '@itsm/shared';
import { registerReport, isCustomerUser, type ReportResult } from '../registry';
import { rows, customerCond, socCond, limitSql, num, col, boolParam, strParam, customerParam } from './helpers';

const KE_STATUS = sql`coalesce(pd.ke_status, 'open')`;
const statusLabel = (s: unknown) => KNOWN_ERROR_STATUS_LABELS[String(s) as keyof typeof KNOWN_ERROR_STATUS_LABELS] ?? String(s);

/**
 * The known error database as a report. Staff see the full record (internal
 * workaround, root cause, fix change, owner); customer users see the published
 * entries of their own organisation with the customer wording only. Summary
 * tile labels are read by name elsewhere: keep them.
 */
registerReport({
  key: 'known_errors',
  name: 'Known error database',
  description: 'Known errors with their status, workaround, permanent-fix change, linked incidents and portal publication.',
  category: 'tickets',
  permissions: ['reports:run', 'kedb:read'],
  portal: true,
  parameters: [
    customerParam,
    { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'open', label: 'Open' }, { value: 'fix_in_progress', label: 'Fix in progress' }, { value: 'resolved', label: 'Resolved' }, { value: 'retired', label: 'Retired' }, { value: 'all', label: 'All' }], default: 'active' },
    { key: 'publishedOnly', label: 'Published to the portal only', type: 'boolean' },
  ],
  defaultDateRange: 'last_90_days',
  async run(ctx, p): Promise<ReportResult> {
    const customer = isCustomerUser(ctx);
    // canRunReport only checks portal:reports for customer users; the entries themselves need portal:kedb.
    if (customer) ctx.require('portal:kedb', ctx.user.customerId);
    const status = strParam(p, 'status') ?? 'active';
    const statusCond = status === 'active' ? sql`AND ${KE_STATUS} IN ('open', 'fix_in_progress')` : status === 'all' ? sql`` : sql`AND ${KE_STATUS} = ${status}`;
    const published = customer || boolParam(p, 'publishedOnly') ? sql`AND pd.portal_visible` : sql``;
    const retired = customer ? sql`AND ${KE_STATUS} <> 'retired'` : sql``;
    const tenant = customer ? sql`AND t.customer_id = ${ctx.user.customerId ?? '00000000-0000-0000-0000-000000000000'}::uuid` : customerCond(p.customerId);
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT t.id, t.number, t.title, cu.name AS customer, sv.name AS service, ${KE_STATUS} AS ke_status, left(pd.workaround, 300) AS workaround, left(pd.root_cause, 300) AS root_cause, fc.number AS fix_change,
        (SELECT count(*)::int FROM ticket_links l JOIN tickets s ON s.id = l.source_ticket_id AND s.type = 'incident' WHERE l.target_ticket_id = t.id AND l.link_type = 'problem_of') AS linked_incidents,
        pd.ke_identified_at AS identified_at, pd.published_at, pd.ke_status_at, greatest(pd.updated_at, t.updated_at) AS updated_at, asg.name AS assignee, pd.portal_visible,
        pd.customer_summary AS summary, pd.customer_workaround AS customer_workaround
      FROM tickets t JOIN problem_details pd ON pd.ticket_id = t.id
      LEFT JOIN customers cu ON cu.id = t.customer_id LEFT JOIN services sv ON sv.id = t.service_id LEFT JOIN users asg ON asg.id = t.assignee_id LEFT JOIN tickets fc ON fc.id = pd.fix_change_id
      WHERE t.type = 'problem' AND pd.is_known_error ${statusCond} ${published} ${retired} ${tenant} ${socCond(ctx)}
      ORDER BY greatest(pd.updated_at, t.updated_at) DESC ${limitSql()}`);
    const byStatus = Object.entries(list.reduce<Record<string, number>>((m, r) => ((m[statusLabel(r.ke_status)] = (m[statusLabel(r.ke_status)] ?? 0) + 1), m), {})).map(([label, count]) => ({ label, count }));
    const summary = [
      { label: 'Known errors', value: list.length },
      { label: 'Open', value: list.filter((r) => r.ke_status === 'open').length },
      { label: 'Fix in progress', value: list.filter((r) => r.ke_status === 'fix_in_progress').length },
      { label: 'Published to portal', value: list.filter((r) => r.portal_visible).length },
      { label: 'Linked incidents', value: list.reduce((s, r) => s + num(r.linked_incidents), 0) },
    ];
    const charts: ReportResult['charts'] = [{ type: 'bar', title: 'Known errors by status', data: byStatus, x: 'label', y: 'count' }];
    if (customer) {
      return {
        columns: [col('title', 'Title'), col('service', 'Service'), col('status', 'Status'), col('summary', 'What you may notice'), col('workaround', 'What to do in the meantime'), col('published_at', 'Published', 'datetime'), col('updated_at', 'Updated', 'datetime')],
        rows: list.map((r) => ({ id: r.id, title: r.title, service: r.service, status: statusLabel(r.ke_status), summary: r.summary, workaround: r.customer_workaround, published_at: r.published_at, updated_at: r.updated_at })),
        summary,
        charts,
      };
    }
    return {
      columns: [col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('service', 'Service'), col('status', 'Status'), col('workaround', 'Workaround'), col('root_cause', 'Root cause'), col('fix_change', 'Fix change'), col('linked_incidents', 'Linked incidents', 'number'), col('identified_at', 'Identified', 'datetime'), col('published_at', 'Published', 'datetime'), col('ke_status_at', 'Status since', 'datetime'), col('updated_at', 'Updated', 'datetime'), col('assignee', 'Owner')],
      rows: list.map((r) => ({ id: r.id, number: r.number, title: r.title, customer: r.customer, service: r.service, status: statusLabel(r.ke_status), workaround: r.workaround, root_cause: r.root_cause, fix_change: r.fix_change, linked_incidents: r.linked_incidents, identified_at: r.identified_at, published_at: r.published_at, ke_status_at: r.ke_status_at, updated_at: r.updated_at, assignee: r.assignee, portal_visible: r.portal_visible })),
      summary,
      charts,
    };
  },
});
