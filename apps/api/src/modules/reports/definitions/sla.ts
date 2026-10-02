import { sql } from 'drizzle-orm';
import { registerReport, type ReportResult } from '../registry';
import { slaCompliance } from '@/modules/sla/policies';
import { rows, customerCond, rangeCond, socCond, limitSql, pct, num, round1, col, ticketJoins, minutesBetween, customerParam, dateRangeParam } from './helpers';

const METRIC_LABEL: Record<string, string> = { acknowledgement: 'Acknowledgement', response: 'Response', restoration: 'Restoration', resolution: 'Resolution' };

// ---------------------------------------------------------------- sla_performance
registerReport({
  key: 'sla_performance',
  name: 'SLA performance',
  description: 'Weekly SLA report: met vs breached per priority and metric with compliance %, plus the list of breached tickets.',
  category: 'sla',
  permissions: ['reports:run'],
  portal: true,
  parameters: [customerParam, dateRangeParam, { key: 'ticketType', label: 'Ticket type', type: 'select', options: [{ value: 'incident', label: 'Incidents' }, { value: 'request', label: 'Requests' }, { value: 'problem', label: 'Problems' }, { value: 'change', label: 'Changes' }] }],
  defaultDateRange: 'last_7_days',
  async run(ctx, p): Promise<ReportResult> {
    const type = typeof p.ticketType === 'string' && p.ticketType ? (p.ticketType as 'incident' | 'request' | 'problem' | 'change') : undefined;
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT coalesce(pr.label, 'No priority') AS priority, coalesce(pr.level, 99) AS level, s.metric::text AS metric,
        count(*) FILTER (WHERE s.state = 'met')::int AS met, count(*) FILTER (WHERE s.state = 'breached')::int AS breached,
        count(*) FILTER (WHERE s.state IN ('running', 'paused'))::int AS running,
        round(avg(s.elapsed_minutes_at_completion) FILTER (WHERE s.state IN ('met', 'breached')))::int AS avg_elapsed_minutes,
        round(avg(s.target_minutes))::int AS avg_target_minutes
      FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id LEFT JOIN config_options pr ON pr.id = t.priority_id
      WHERE true ${rangeCond(sql`s.started_at`, p.from, p.to)} ${customerCond(p.customerId, sql`s.customer_id`)} ${socCond(ctx)} ${type ? sql`AND t.type = ${type}::ticket_type` : sql``}
      GROUP BY 1, 2, 3 ORDER BY 2, 3`);
    const table: Record<string, unknown>[] = list.map((r) => ({ ...r, metric: METRIC_LABEL[String(r.metric)] ?? r.metric, metric_key: r.metric, completed: num(r.met) + num(r.breached), compliance_pct: pct(num(r.met), num(r.met) + num(r.breached)) }));
    const breachedList = await rows<Record<string, unknown>>(ctx, sql`
      SELECT t.id, t.number, t.title, cu.name AS customer, pr.label AS priority, s.metric::text AS metric, st.label AS status, asg.name AS assignee, s.target_minutes, s.elapsed_minutes_at_completion AS elapsed_minutes,
        s.due_at, s.breached_at, t.created_at
      FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id ${ticketJoins}
      WHERE s.state = 'breached' ${rangeCond(sql`s.started_at`, p.from, p.to)} ${customerCond(p.customerId, sql`s.customer_id`)} ${socCond(ctx)} ${type ? sql`AND t.type = ${type}::ticket_type` : sql``}
      ORDER BY s.breached_at DESC ${limitSql(2000)}`);
    const tot = (metric?: string) => table.filter((r) => !metric || r.metric_key === metric).reduce<{ met: number; breached: number }>((a, r) => ({ met: a.met + num(r.met), breached: a.breached + num(r.breached) }), { met: 0, breached: 0 });
    const all = tot(), res = tot('resolution'), resp = tot('response');
    const byPriority = [...new Set(table.map((r) => String(r.priority)))].map((priority) => {
      const t = table.filter((r) => r.priority === priority).reduce<{ met: number; breached: number }>((a, r) => ({ met: a.met + num(r.met), breached: a.breached + num(r.breached) }), { met: 0, breached: 0 });
      return { label: priority, compliance: pct(t.met, t.met + t.breached) ?? 0, breached: t.breached };
    });
    const byMetric = Object.keys(METRIC_LABEL).map((m) => ({ label: METRIC_LABEL[m], met: tot(m).met, breached: tot(m).breached })).filter((r) => r.met + r.breached > 0);
    return {
      columns: [col('priority', 'Priority'), col('metric', 'Metric'), col('met', 'Met', 'number'), col('breached', 'Breached', 'number'), col('running', 'Running', 'number'), col('completed', 'Completed', 'number'), col('compliance_pct', 'Compliance', 'pct'), col('avg_elapsed_minutes', 'Avg elapsed', 'minutes'), col('avg_target_minutes', 'Avg target', 'minutes')],
      rows: table.map(({ metric_key: _m, ...r }) => r as Record<string, unknown>),
      summary: [
        { label: 'Overall compliance', value: pct(all.met, all.met + all.breached) ?? 'n/a', hint: `${all.met} met / ${all.breached} breached` },
        { label: 'Resolution compliance', value: pct(res.met, res.met + res.breached) ?? 'n/a' },
        { label: 'Response compliance', value: pct(resp.met, resp.met + resp.breached) ?? 'n/a' },
        { label: 'Breaches', value: all.breached },
        { label: 'Breached tickets', value: new Set(breachedList.map((r) => r.id)).size },
      ],
      charts: [
        { type: 'bar', title: 'Compliance % by priority', data: byPriority, x: 'label', y: 'compliance', labels: { compliance: 'Compliance %' } },
        { type: 'bar', title: 'Met vs breached by metric', data: byMetric, x: 'label', y: ['met', 'breached'], labels: { met: 'Met', breached: 'Breached' } },
      ],
      sections: [{ title: 'Breached tickets', columns: [col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('priority', 'Priority'), col('metric', 'Metric'), col('status', 'Status'), col('assignee', 'Assignee'), col('target_minutes', 'Target', 'minutes'), col('elapsed_minutes', 'Elapsed', 'minutes'), col('breached_at', 'Breached at', 'datetime')], rows: breachedList.map((r) => ({ ...r, metric: METRIC_LABEL[String(r.metric)] ?? r.metric })) }],
    };
  },
});

// ---------------------------------------------------------------- service_report
registerReport({
  key: 'service_report',
  name: 'Monthly service report',
  description: 'Executive service report per service: volume, SLA compliance, out-of-scope work, changes, problems, visits and engineering effort.',
  category: 'customers',
  permissions: ['reports:run'],
  portal: true,
  parameters: [customerParam, dateRangeParam],
  defaultDateRange: 'last_month',
  async run(ctx, p): Promise<ReportResult> {
    const byService = await rows<Record<string, unknown>>(ctx, sql`
      SELECT coalesce(sv.name, 'No service') AS service, count(*)::int AS tickets,
        count(*) FILTER (WHERE t.type = 'incident')::int AS incidents, count(*) FILTER (WHERE t.type = 'request')::int AS requests,
        count(*) FILTER (WHERE t.type = 'change')::int AS changes, count(*) FILTER (WHERE t.type = 'problem')::int AS problems,
        count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved, count(*) FILTER (WHERE t.is_major)::int AS major,
        count(*) FILTER (WHERE t.scope_status = 'out_of_scope')::int AS out_of_scope,
        ${minutesBetween(sql`avg(t.resolved_at - t.created_at)`, sql`interval '0'`)} AS mttr_minutes,
        (SELECT count(*)::int FROM ticket_slas s WHERE s.ticket_id = ANY(array_agg(t.id)) AND s.metric = 'resolution' AND s.state = 'met') AS sla_met,
        (SELECT count(*)::int FROM ticket_slas s WHERE s.ticket_id = ANY(array_agg(t.id)) AND s.metric = 'resolution' AND s.state = 'breached') AS sla_breached,
        (SELECT coalesce(sum(te.minutes), 0)::int FROM time_entries te WHERE te.ticket_id = ANY(array_agg(t.id))) AS engineering_minutes
      FROM tickets t LEFT JOIN services sv ON sv.id = t.service_id
      WHERE true ${rangeCond(sql`t.created_at`, p.from, p.to)} ${customerCond(p.customerId)} ${socCond(ctx)}
      GROUP BY 1 ORDER BY 2 DESC ${limitSql(500)}`);
    const visits = await rows<{ service: string | null; visits: number; minutes: number }>(ctx, sql`
      SELECT coalesce(sv.name, 'No service') AS service, count(*)::int AS visits, coalesce(sum(v.work_minutes), 0)::int AS minutes
      FROM field_visits v LEFT JOIN services sv ON sv.id = v.service_id
      WHERE v.status = 'completed' ${rangeCond(sql`coalesce(v.actual_end, v.scheduled_start)`, p.from, p.to)} ${customerCond(p.customerId, sql`v.customer_id`)} GROUP BY 1`);
    const visitMap = new Map(visits.map((v) => [v.service, v]));
    const table: Record<string, unknown>[] = byService.map((r) => ({ ...r, mttr_minutes: round1(r.mttr_minutes), compliance_pct: pct(num(r.sla_met), num(r.sla_met) + num(r.sla_breached)), visits: visitMap.get(String(r.service))?.visits ?? 0, visit_minutes: visitMap.get(String(r.service))?.minutes ?? 0 }));
    const sum = (k: string) => table.reduce((s, r) => s + num(r[k]), 0);
    const weekly = await rows<Record<string, unknown>>(ctx, sql`
      SELECT d::date::text AS week, (SELECT count(*)::int FROM tickets t WHERE t.created_at >= d AND t.created_at < d + interval '7 days' ${customerCond(p.customerId)} ${socCond(ctx)}) AS opened,
        (SELECT count(*)::int FROM tickets t WHERE t.resolved_at >= d AND t.resolved_at < d + interval '7 days' ${customerCond(p.customerId)} ${socCond(ctx)}) AS resolved
      FROM generate_series(${p.from}::date, ${p.to}::date, '7 days') d`);
    const pm = await rows<{ completed: number; missed: number; planned: number }>(ctx, sql`
      SELECT count(*) FILTER (WHERE o.status = 'completed')::int AS completed, count(*) FILTER (WHERE o.status = 'missed')::int AS missed, count(*)::int AS planned
      FROM pm_occurrences o WHERE o.planned_date >= ${p.from}::date AND o.planned_date <= ${p.to}::date ${customerCond(p.customerId, sql`o.customer_id`)}`);
    const compliance = await slaCompliance(ctx, { customerId: p.customerId ?? undefined, from: `${p.from}T00:00:00Z`, to: `${p.to}T23:59:59Z`, groupBy: 'priority' });
    return {
      columns: [col('service', 'Service'), col('tickets', 'Tickets', 'number'), col('incidents', 'Incidents', 'number'), col('requests', 'Requests', 'number'), col('changes', 'Changes', 'number'), col('problems', 'Problems', 'number'), col('resolved', 'Resolved', 'number'), col('mttr_minutes', 'MTTR', 'minutes'), col('compliance_pct', 'SLA compliance', 'pct'), col('sla_breached', 'Breaches', 'number'), col('out_of_scope', 'Out of scope', 'number'), col('major', 'Major', 'number'), col('visits', 'Visits', 'number'), col('visit_minutes', 'On-site', 'minutes'), col('engineering_minutes', 'Engineering', 'minutes')],
      rows: table,
      summary: [
        { label: 'Tickets', value: sum('tickets'), hint: `${sum('incidents')} incidents / ${sum('requests')} requests` },
        { label: 'Resolved', value: sum('resolved') },
        { label: 'SLA compliance', value: compliance.totals.compliancePct ?? 'n/a', hint: `${compliance.totals.breached} breaches` },
        { label: 'Out of scope', value: sum('out_of_scope') },
        { label: 'Major incidents', value: sum('major') },
        { label: 'Site visits', value: sum('visits'), hint: `${Math.round(sum('visit_minutes') / 60)} h on site` },
        { label: 'Preventive maintenance', value: `${pm[0]?.completed ?? 0}/${pm[0]?.planned ?? 0}`, hint: `${pm[0]?.missed ?? 0} missed` },
        { label: 'Engineering hours', value: Math.round(sum('engineering_minutes') / 60) },
      ],
      charts: [
        { type: 'bar', title: 'Tickets by service', data: table.slice(0, 12).map((r) => ({ label: r.service, count: r.tickets })), x: 'label', y: 'count' },
        { type: 'line', title: 'Opened vs resolved per week', data: weekly, x: 'week', y: ['opened', 'resolved'], labels: { opened: 'Opened', resolved: 'Resolved' } },
        { type: 'bar', title: 'SLA compliance by priority', data: compliance.groups.map((g) => ({ label: g.label, compliance: g.compliancePct ?? 0 })), x: 'label', y: 'compliance', labels: { compliance: 'Compliance %' } },
      ],
      sections: [{ title: 'SLA by priority', columns: [col('label', 'Priority'), col('met', 'Met', 'number'), col('breached', 'Breached', 'number'), col('running', 'Running', 'number'), col('compliancePct', 'Compliance', 'pct'), col('avgElapsedMinutes', 'Avg elapsed', 'minutes')], rows: compliance.groups.map((g) => ({ label: g.label, met: g.met, breached: g.breached, running: g.running, compliancePct: g.compliancePct, avgElapsedMinutes: g.avgElapsedMinutes })) }],
    };
  },
});
