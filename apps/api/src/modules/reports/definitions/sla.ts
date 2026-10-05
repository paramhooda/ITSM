import { sql } from 'drizzle-orm';
import { registerReport, type ReportResult } from '../registry';
import { slaCompliance } from '@/modules/sla/policies';
import { csatFigures, hidesSoc } from '@/modules/surveys/figures';
import { loadSurveyDefaults } from '@/modules/surveys/policy';
import { rows, customerCond, rangeCond, socCond, limitSql, pct, num, round1, col, totals, ticketJoins, minutesBetween, customerParam, dateRangeParam } from './helpers';

const METRIC_LABEL: Record<string, string> = { acknowledgement: 'Acknowledgement', response: 'Response', restoration: 'Restoration', resolution: 'Resolution' };
const SLA_TARGET = 95;
const toneFor = (v: number | null, target = SLA_TARGET): 'good' | 'warn' | 'bad' | undefined => (v === null ? undefined : v >= target ? 'good' : v >= target - 5 ? 'warn' : 'bad');

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
  glossary: [
    { term: 'Acknowledgement', meaning: 'Time from creation until an engineer takes the ticket' },
    { term: 'Response', meaning: 'Time from creation until the first reply to the requester' },
    { term: 'Restoration', meaning: 'Time until service is restored, before the full fix' },
    { term: 'Resolution', meaning: 'Time from creation until the ticket is resolved' },
  ],
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
    const overall = pct(all.met, all.met + all.breached);
    const resolution = pct(res.met, res.met + res.breached);
    const response = pct(resp.met, resp.met + resp.breached);
    return {
      columns: totals([col('priority', 'Priority'), col('metric', 'Metric'), col('met', 'Met', 'number'), col('breached', 'Breached', 'number'), col('running', 'Running', 'number'), col('completed', 'Completed', 'number'), col('compliance_pct', 'Compliance', 'pct'), col('avg_elapsed_minutes', 'Avg elapsed', 'minutes'), col('avg_target_minutes', 'Avg target', 'minutes')], ['met', 'breached', 'running', 'completed']),
      rows: table.map(({ metric_key: _m, ...r }) => r as Record<string, unknown>),
      summary: [
        { label: 'Overall compliance', value: overall ?? 'n/a', hint: `${all.met} met / ${all.breached} breached`, unit: 'pct', target: SLA_TARGET, tone: toneFor(overall) },
        { label: 'Resolution compliance', value: resolution ?? 'n/a', unit: 'pct', target: SLA_TARGET, tone: toneFor(resolution) },
        { label: 'Response compliance', value: response ?? 'n/a', unit: 'pct', target: SLA_TARGET, tone: toneFor(response) },
        { label: 'Breaches', value: all.breached, tone: all.breached ? 'bad' : 'good' },
        { label: 'Breached tickets', value: new Set(breachedList.map((r) => r.id)).size },
      ],
      charts: [
        { type: 'bar', title: 'Compliance % by priority', subtitle: 'Clocks met over clocks completed, every metric', data: byPriority, x: 'label', y: 'compliance', labels: { compliance: 'Compliance %' }, unit: 'pct', target: SLA_TARGET, insight: ['extremes'] },
        { type: 'stacked_bar', title: 'Met vs breached by metric', data: byMetric, x: 'label', y: ['met', 'breached'], labels: { met: 'Met', breached: 'Breached' }, statusSeries: true, insight: 'none' },
        { type: 'gauge', title: 'Overall SLA compliance', subtitle: `Target ${SLA_TARGET}%`, data: overall === null ? [] : [{ label: 'Overall', value: overall }], x: 'label', y: 'value', unit: 'pct', target: SLA_TARGET, insight: 'none' },
      ],
      sections: [{ title: 'Breached tickets', intro: 'Every clock that passed its target in the period, latest first.', printLimit: 50, columns: [col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('priority', 'Priority'), col('metric', 'Metric'), col('status', 'Status'), col('assignee', 'Assignee'), col('target_minutes', 'Target', 'minutes'), col('elapsed_minutes', 'Elapsed', 'minutes'), col('breached_at', 'Breached at', 'datetime')], rows: breachedList.map((r) => ({ ...r, metric: METRIC_LABEL[String(r.metric)] ?? r.metric })) }],
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
    const thresholds = await loadSurveyDefaults(ctx.tx);
    const csat = await csatFigures(ctx.tx, { customerId: p.customerId, from: new Date(`${p.from}T00:00:00Z`), to: new Date(`${p.to}T23:59:59Z`), excludeSoc: hidesSoc(ctx), satisfiedThreshold: thresholds.satisfiedThreshold, lowThreshold: thresholds.lowRatingThreshold });
    const mix = [{ label: 'Incidents', count: sum('incidents') }, { label: 'Requests', count: sum('requests') }, { label: 'Changes', count: sum('changes') }, { label: 'Problems', count: sum('problems') }].filter((m) => m.count > 0);
    const overall = compliance.totals.compliancePct ?? null;
    return {
      columns: totals([col('service', 'Service'), col('tickets', 'Tickets', 'number'), col('incidents', 'Incidents', 'number'), col('requests', 'Requests', 'number'), col('changes', 'Changes', 'number'), col('problems', 'Problems', 'number'), col('resolved', 'Resolved', 'number'), col('mttr_minutes', 'MTTR', 'minutes'), col('compliance_pct', 'SLA compliance', 'pct'), col('sla_breached', 'Breaches', 'number'), col('out_of_scope', 'Out of scope', 'number'), col('major', 'Major', 'number'), col('visits', 'Visits', 'number'), col('visit_minutes', 'On-site', 'minutes'), col('engineering_minutes', 'Engineering', 'minutes')], ['tickets', 'incidents', 'requests', 'changes', 'problems', 'resolved', 'sla_breached', 'out_of_scope', 'major', 'visits', 'visit_minutes', 'engineering_minutes'], ['mttr_minutes']),
      rows: table,
      summary: [
        { label: 'Tickets', value: sum('tickets'), hint: `${sum('incidents')} incidents / ${sum('requests')} requests` },
        { label: 'Resolved', value: sum('resolved') },
        { label: 'SLA compliance', value: overall ?? 'n/a', hint: `${compliance.totals.breached} breaches`, unit: 'pct', target: SLA_TARGET, tone: toneFor(overall) },
        { label: 'Out of scope', value: sum('out_of_scope') },
        { label: 'Major incidents', value: sum('major'), tone: sum('major') ? 'bad' : 'good' },
        { label: 'Site visits', value: sum('visits'), hint: `${Math.round(sum('visit_minutes') / 60)} h on site` },
        { label: 'Preventive maintenance', value: `${pm[0]?.completed ?? 0}/${pm[0]?.planned ?? 0}`, hint: `${pm[0]?.missed ?? 0} missed` },
        { label: 'Engineering hours', value: Math.round(sum('engineering_minutes') / 60), unit: 'hours' },
        { label: 'Customer satisfaction', value: csat.avg === null ? 'n/a' : `${csat.avg}/5`, hint: `${csat.responses} responses` },
      ],
      charts: [
        { type: 'line', title: 'Opened vs resolved per week', data: weekly, x: 'week', y: ['opened', 'resolved'], labels: { opened: 'Opened', resolved: 'Resolved' } },
        { type: 'bar', title: 'SLA compliance by priority', data: compliance.groups.map((g) => ({ label: g.label, compliance: g.compliancePct ?? 0 })), x: 'label', y: 'compliance', labels: { compliance: 'Compliance %' }, unit: 'pct', target: SLA_TARGET, insight: ['extremes'] },
        { type: 'bar', title: 'Tickets by service', data: table.slice(0, 12).map((r) => ({ label: r.service, count: r.tickets })), x: 'label', y: 'count', horizontal: true },
        { type: 'donut', title: 'Ticket mix', subtitle: 'Tickets opened in the period by type', data: mix, x: 'label', y: 'count', insight: 'none' },
      ],
      sections: [{ title: 'SLA by priority', columns: totals([col('label', 'Priority'), col('met', 'Met', 'number'), col('breached', 'Breached', 'number'), col('running', 'Running', 'number'), col('compliancePct', 'Compliance', 'pct'), col('avgElapsedMinutes', 'Avg elapsed', 'minutes')], ['met', 'breached', 'running']), totals: true, rows: compliance.groups.map((g) => ({ label: g.label, met: g.met, breached: g.breached, running: g.running, compliancePct: g.compliancePct, avgElapsedMinutes: g.avgElapsedMinutes })) }],
    };
  },
});
