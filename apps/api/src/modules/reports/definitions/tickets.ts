import { sql } from 'drizzle-orm';
import { KNOWN_ERROR_STATUS_LABELS } from '@itsm/shared';
import { registerReport, type ReportResult } from '../registry';
import { arrivalHeatmap, changeOutcomes, scopeTimezone } from '../analytics';
import { rows, customerCond, rangeCond, socCond, openCond, limitSql, pct, num, round1, col, totals, countsOf, weekdayHours, STATUS_CATEGORY_LABEL, listParam, strParam, boolParam, inUuids, ticketJoins, minutesBetween, customerParam, dateRangeParam } from './helpers';

const TYPE_LABEL: Record<string, string> = { incident: 'Incidents', request: 'Requests', problem: 'Problems', change: 'Changes' };

const AGE_BUCKET = sql`CASE WHEN now() - t.created_at < interval '4 hours' THEN '< 4h' WHEN now() - t.created_at < interval '24 hours' THEN '4-24h' WHEN now() - t.created_at < interval '3 days' THEN '1-3d' ELSE '> 3d' END`;
const WORST_SLA = sql`(SELECT CASE WHEN bool_or(s.state = 'breached' OR (s.state = 'running' AND s.due_at < now())) THEN 'breached' WHEN bool_or(s.state = 'running' AND s.warned_at IS NOT NULL) THEN 'at_risk' WHEN bool_or(s.state IN ('running','paused')) THEN 'ok' ELSE NULL END FROM ticket_slas s WHERE s.ticket_id = t.id)`;
const NEXT_DUE = sql`(SELECT min(s.due_at) FROM ticket_slas s WHERE s.ticket_id = t.id AND s.state IN ('running','paused'))`;

// ---------------------------------------------------------------- open_tickets
registerReport({
  key: 'open_tickets',
  name: 'Open tickets',
  description: 'Daily open ticket report: every open ticket with age, SLA state, assignee and scope classification.',
  category: 'tickets',
  permissions: ['reports:run'],
  portal: true,
  parameters: [
    customerParam,
    { key: 'type', label: 'Ticket type', type: 'select', options: [{ value: 'incident', label: 'Incidents' }, { value: 'request', label: 'Requests' }, { value: 'problem', label: 'Problems' }, { value: 'change', label: 'Changes' }] },
    { key: 'priorityIds', label: 'Priority', type: 'multiselect', optionType: 'ticket_priority' },
    { key: 'unassignedOnly', label: 'Unassigned only', type: 'boolean' },
  ],
  async run(ctx, p): Promise<ReportResult> {
    const type = strParam(p, 'type');
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT t.id, t.number, t.type, t.title, cu.name AS customer, pr.label AS priority, pr.level AS priority_level, st.label AS status, cat.label AS category, sv.name AS service,
        asg.name AS assignee, tm.name AS team, t.created_at, round(EXTRACT(EPOCH FROM (now() - t.created_at)) / 3600, 1) AS age_hours, ${AGE_BUCKET} AS age_bucket,
        ${WORST_SLA} AS sla_state, ${NEXT_DUE} AS sla_due, t.scope_status, t.escalation_level, t.is_major
      FROM tickets t ${ticketJoins}
      WHERE true ${openCond()} ${customerCond(p.customerId)} ${socCond(ctx)}
        ${type ? sql`AND t.type = ${type}::ticket_type` : sql``} ${inUuids(sql`t.priority_id`, listParam(p, 'priorityIds'))} ${boolParam(p, 'unassignedOnly') ? sql`AND t.assignee_id IS NULL` : sql``}
      ORDER BY pr.level NULLS LAST, t.created_at ${limitSql()}`);
    const byPriority = new Map<string, number>();
    const byAge = new Map<string, number>([['< 4h', 0], ['4-24h', 0], ['1-3d', 0], ['> 3d', 0]]);
    let breached = 0, atRisk = 0, unassigned = 0, ageSum = 0;
    for (const r of list) {
      byPriority.set(String(r.priority ?? 'No priority'), (byPriority.get(String(r.priority ?? 'No priority')) ?? 0) + 1);
      byAge.set(String(r.age_bucket), (byAge.get(String(r.age_bucket)) ?? 0) + 1);
      if (r.sla_state === 'breached') breached++;
      if (r.sla_state === 'at_risk') atRisk++;
      if (!r.assignee) unassigned++;
      ageSum += num(r.age_hours);
    }
    return {
      columns: [col('number', 'Number'), col('type', 'Type'), col('title', 'Title'), col('customer', 'Customer'), col('priority', 'Priority'), col('status', 'Status'), col('category', 'Category'), col('service', 'Service'), col('assignee', 'Assignee'), col('team', 'Team'), col('created_at', 'Created', 'datetime'), col('age_hours', 'Age (h)', 'number'), col('sla_state', 'SLA'), col('sla_due', 'SLA due', 'datetime'), col('scope_status', 'Scope'), col('escalation_level', 'Esc.', 'number')],
      rows: list,
      summary: [
        { label: 'Open tickets', value: list.length },
        { label: 'SLA breached', value: breached, tone: breached > 0 ? 'bad' : 'good' },
        { label: 'SLA at risk', value: atRisk, tone: atRisk > 0 ? 'warn' : undefined },
        { label: 'Unassigned', value: unassigned },
        { label: 'Average age (h)', value: list.length ? Math.round((ageSum / list.length) * 10) / 10 : 0, unit: 'hours' },
      ],
      charts: [
        { type: 'bar', title: 'Open tickets by priority', data: [...byPriority].map(([label, count]) => ({ label, count })), x: 'label', y: 'count' },
        { type: 'bar', title: 'Open tickets by age', subtitle: 'Time since the ticket was raised', data: [...byAge].map(([label, count]) => ({ label, count })), x: 'label', y: 'count', emphasis: '> 3d', insight: 'none' },
        { type: 'donut', title: 'Open by type', data: countsOf(list, 'type', 'Unspecified', TYPE_LABEL), x: 'label', y: 'count', insight: 'none' },
        { type: 'bar', title: 'Open by team', data: countsOf(list, 'team', 'No team').slice(0, 10), x: 'label', y: 'count', horizontal: true },
      ],
    };
  },
});

// ---------------------------------------------------------------- ticket_volume
registerReport({
  key: 'ticket_volume',
  name: 'Ticket volume',
  description: 'Tickets opened, resolved and closed per day (or week/month), split by type and priority.',
  category: 'tickets',
  permissions: ['reports:run'],
  portal: true,
  parameters: [customerParam, dateRangeParam, { key: 'granularity', label: 'Group by', type: 'select', options: [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }], default: 'day' }],
  async run(ctx, p): Promise<ReportResult> {
    const g = strParam(p, 'granularity') ?? 'day';
    const unit = g === 'week' ? 'week' : g === 'month' ? 'month' : 'day';
    const trunc = (c: ReturnType<typeof sql>) => sql`date_trunc(${unit}, ${c})::date`;
    const filters = sql`${customerCond(p.customerId)} ${socCond(ctx)}`;
    const opened = await rows<Record<string, unknown>>(ctx, sql`
      SELECT ${trunc(sql`t.created_at`)} AS period, count(*)::int AS opened,
        count(*) FILTER (WHERE t.type = 'incident')::int AS incidents, count(*) FILTER (WHERE t.type = 'request')::int AS requests,
        count(*) FILTER (WHERE t.type = 'problem')::int AS problems, count(*) FILTER (WHERE t.type = 'change')::int AS changes,
        count(*) FILTER (WHERE pr.level = 1)::int AS p1, count(*) FILTER (WHERE pr.level = 2)::int AS p2, count(*) FILTER (WHERE pr.level = 3)::int AS p3, count(*) FILTER (WHERE pr.level IS NULL OR pr.level >= 4)::int AS p4_plus,
        count(*) FILTER (WHERE t.scope_status = 'out_of_scope')::int AS out_of_scope
      FROM tickets t LEFT JOIN config_options pr ON pr.id = t.priority_id
      WHERE true ${rangeCond(sql`t.created_at`, p.from, p.to)} ${filters} GROUP BY 1`);
    const resolved = await rows<Record<string, unknown>>(ctx, sql`
      SELECT ${trunc(sql`t.resolved_at`)} AS period, count(*)::int AS resolved, ${minutesBetween(sql`avg(t.resolved_at - t.created_at)`, sql`interval '0'`)} AS mttr_minutes
      FROM tickets t WHERE true ${rangeCond(sql`t.resolved_at`, p.from, p.to)} ${filters} GROUP BY 1`);
    const closed = await rows<Record<string, unknown>>(ctx, sql`
      SELECT ${trunc(sql`t.closed_at`)} AS period, count(*)::int AS closed FROM tickets t WHERE true ${rangeCond(sql`t.closed_at`, p.from, p.to)} ${filters} GROUP BY 1`);
    const periods = new Map<string, Record<string, unknown>>();
    const key = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    const get = (k: string) => periods.get(k) ?? periods.set(k, { period: k, opened: 0, incidents: 0, requests: 0, problems: 0, changes: 0, p1: 0, p2: 0, p3: 0, p4_plus: 0, out_of_scope: 0, resolved: 0, closed: 0, mttr_minutes: null }).get(k)!;
    for (const r of opened) Object.assign(get(key(r.period)), r, { period: key(r.period) });
    for (const r of resolved) Object.assign(get(key(r.period)), { resolved: r.resolved, mttr_minutes: round1(r.mttr_minutes) });
    for (const r of closed) Object.assign(get(key(r.period)), { closed: r.closed });
    const list = [...periods.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));
    const sum = (k: string) => list.reduce((s, r) => s + num(r[k]), 0);
    const timezone = await scopeTimezone(ctx, p.customerId);
    const heat = await arrivalHeatmap(ctx, { customerId: p.customerId, from: p.from, to: p.to, timezone });
    const resolvedRows = list.filter((r) => r.mttr_minutes !== null && num(r.resolved) > 0);
    const mttr = resolvedRows.length ? Math.round(resolvedRows.reduce((s, r) => s + num(r.mttr_minutes) * num(r.resolved), 0) / resolvedRows.reduce((s, r) => s + num(r.resolved), 0)) : null;
    return {
      columns: totals([col('period', unit === 'day' ? 'Day' : unit === 'week' ? 'Week of' : 'Month', 'date'), col('opened', 'Opened', 'number'), col('incidents', 'Incidents', 'number'), col('requests', 'Requests', 'number'), col('problems', 'Problems', 'number'), col('changes', 'Changes', 'number'), col('p1', 'P1', 'number'), col('p2', 'P2', 'number'), col('p3', 'P3', 'number'), col('p4_plus', 'P4+', 'number'), col('out_of_scope', 'Out of scope', 'number'), col('resolved', 'Resolved', 'number'), col('closed', 'Closed', 'number'), col('mttr_minutes', 'MTTR', 'minutes')], ['opened', 'incidents', 'requests', 'problems', 'changes', 'p1', 'p2', 'p3', 'p4_plus', 'out_of_scope', 'resolved', 'closed'], ['mttr_minutes']),
      rows: list,
      summary: [
        { label: 'Opened', value: sum('opened'), spark: list.slice(-12).map((r) => num(r.opened)) },
        { label: 'Resolved', value: sum('resolved'), spark: list.slice(-12).map((r) => num(r.resolved)) },
        { label: 'Closed', value: sum('closed') },
        { label: 'Incidents', value: sum('incidents') },
        { label: 'Requests', value: sum('requests') },
        { label: 'Out of scope', value: sum('out_of_scope') },
        { label: 'MTTR (min)', value: mttr, unit: 'minutes', hint: 'weighted by tickets resolved' },
      ],
      charts: [
        { type: 'line', title: 'Opened vs resolved', data: list.map((r) => ({ period: r.period, opened: r.opened, resolved: r.resolved })), x: 'period', y: ['opened', 'resolved'], labels: { opened: 'Opened', resolved: 'Resolved' } },
        { type: 'stacked_bar', title: 'Opened by type', data: list.map((r) => ({ period: r.period, incidents: r.incidents, requests: r.requests, problems: r.problems, changes: r.changes })), x: 'period', y: ['incidents', 'requests', 'problems', 'changes'], labels: { incidents: 'Incidents', requests: 'Requests', problems: 'Problems', changes: 'Changes' } },
        { type: 'stacked_bar', title: 'Opened by priority', data: list.map((r) => ({ period: r.period, p1: r.p1, p2: r.p2, p3: r.p3, p4_plus: r.p4_plus })), x: 'period', y: ['p1', 'p2', 'p3', 'p4_plus'], labels: { p1: 'P1', p2: 'P2', p3: 'P3', p4_plus: 'P4+' } },
        { type: 'heatmap', title: 'Arrivals by weekday and hour', subtitle: `Tickets opened per hour of the day, ${timezone}`, data: heat, x: 'col', y: 'value', rows: weekdayHours.rows, cols: weekdayHours.cols, width: 'full', insight: 'none' },
      ],
    };
  },
});

// ---------------------------------------------------------------- incident_report
registerReport({
  key: 'incident_report',
  name: 'Incident report',
  description: 'Monthly incident review: incidents by category, priority, CI and site with MTTR, major incidents and recurring CIs.',
  category: 'tickets',
  permissions: ['reports:run'],
  portal: true,
  parameters: [customerParam, dateRangeParam, { key: 'majorOnly', label: 'Major incidents only', type: 'boolean' }],
  defaultDateRange: 'last_month',
  async run(ctx, p): Promise<ReportResult> {
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT t.id, t.number, t.title, cu.name AS customer, pr.label AS priority, pr.level AS priority_level, cat.label AS category, ci.name AS ci, si.name AS site, sv.name AS service, st.label AS status, st.status_category,
        t.created_at, t.resolved_at, ${minutesBetween(sql`t.resolved_at`, sql`t.created_at`)} AS mttr_minutes, ${minutesBetween(sql`t.first_response_at`, sql`t.created_at`)} AS response_minutes,
        t.is_major, t.scope_status, asg.name AS assignee, (t.integration_event_id IS NOT NULL) AS monitoring_generated,
        EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = t.id AND s.state = 'breached') AS breached
      FROM tickets t ${ticketJoins} LEFT JOIN cis ci ON ci.id = t.primary_ci_id LEFT JOIN sites si ON si.id = t.site_id
      WHERE t.type = 'incident' ${rangeCond(sql`t.created_at`, p.from, p.to)} ${customerCond(p.customerId)} ${socCond(ctx)} ${boolParam(p, 'majorOnly') ? sql`AND t.is_major` : sql``}
      ORDER BY t.created_at DESC ${limitSql()}`);
    const group = (k: string) => {
      const m = new Map<string, number>();
      for (const r of list) m.set(String(r[k] ?? 'Unspecified'), (m.get(String(r[k] ?? 'Unspecified')) ?? 0) + 1);
      return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
    };
    const resolved = list.filter((r) => r.resolved_at);
    const mttr = resolved.length ? Math.round(resolved.reduce((s, r) => s + num(r.mttr_minutes), 0) / resolved.length) : null;
    const recurring = group('ci').filter((g) => g.label !== 'Unspecified' && g.count > 1).slice(0, 15);
    return {
      columns: [col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('priority', 'Priority'), col('category', 'Category'), col('ci', 'CI'), col('site', 'Site'), col('status', 'Status'), col('created_at', 'Created', 'datetime'), col('resolved_at', 'Resolved', 'datetime'), col('mttr_minutes', 'Time to resolve', 'minutes'), col('response_minutes', 'First response', 'minutes'), col('is_major', 'Major', 'boolean'), col('breached', 'SLA breached', 'boolean'), col('assignee', 'Assignee')],
      rows: list,
      summary: [
        { label: 'Incidents', value: list.length },
        { label: 'Resolved', value: resolved.length },
        { label: 'MTTR (min)', value: mttr, unit: 'minutes' },
        { label: 'Major incidents', value: list.filter((r) => r.is_major).length, tone: list.some((r) => r.is_major) ? 'bad' : 'good' },
        { label: 'SLA breached', value: list.filter((r) => r.breached).length, tone: list.some((r) => r.breached) ? 'bad' : 'good' },
        { label: 'From monitoring', value: list.filter((r) => r.monitoring_generated).length },
      ],
      charts: [
        { type: 'bar', title: 'Incidents by category', data: group('category').slice(0, 12), x: 'label', y: 'count' },
        { type: 'bar', title: 'Incidents by priority', data: group('priority'), x: 'label', y: 'count', emphasis: group('priority').find((g) => /^P1\b/i.test(g.label))?.label, insight: ['concentration'] },
        { type: 'donut', title: 'Incidents by status', subtitle: 'Where the period\'s incidents stand today', data: countsOf(list, 'status_category', 'open', STATUS_CATEGORY_LABEL), x: 'label', y: 'count', insight: 'none' },
        { type: 'bar', title: 'Incidents by site', data: group('site').slice(0, 10), x: 'label', y: 'count', horizontal: true, insight: 'none' },
      ],
      sections: [
        { title: 'Top recurring configuration items', intro: 'Configuration items behind more than one incident in the period.', printLimit: 15, columns: [col('label', 'CI'), col('count', 'Incidents', 'number')], rows: recurring },
        { title: 'Incidents by site', columns: totals([col('label', 'Site'), col('count', 'Incidents', 'number')], ['count']), totals: true, rows: group('site').slice(0, 20) },
      ],
    };
  },
});

// ---------------------------------------------------------------- change_calendar
registerReport({
  key: 'change_calendar',
  name: 'Change calendar',
  description: 'Changes scheduled in the period with type, risk, status and approval state.',
  category: 'tickets',
  permissions: ['reports:run'],
  portal: true,
  parameters: [customerParam, dateRangeParam],
  async run(ctx, p): Promise<ReportResult> {
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT t.id, t.number, t.title, cu.name AS customer, cd.change_type, rk.label AS risk, st.label AS status, st.status_category, t.approval_status,
        cd.scheduled_start, cd.scheduled_end, cd.actual_start, cd.actual_end, cd.downtime_expected_minutes, asg.name AS assignee, sv.name AS service, cat.label AS category,
        cd.risk_level, cd.risk_score, tpl.name AS template, cm.title AS cab_meeting, ci.decision AS cab_decision
      FROM tickets t JOIN change_details cd ON cd.ticket_id = t.id LEFT JOIN config_options rk ON rk.id = cd.risk_id
        LEFT JOIN change_templates tpl ON tpl.id = cd.template_id LEFT JOIN cab_meetings cm ON cm.id = cd.cab_meeting_id LEFT JOIN cab_meeting_items ci ON ci.meeting_id = cm.id AND ci.ticket_id = t.id ${ticketJoins}
      WHERE t.type = 'change' ${rangeCond(sql`coalesce(cd.scheduled_start, t.created_at)`, p.from, p.to)} ${customerCond(p.customerId)} ${socCond(ctx)}
      ORDER BY cd.scheduled_start NULLS LAST, t.created_at ${limitSql()}`);
    const weeks = new Map<string, { standard: number; normal: number; emergency: number }>();
    for (const r of list) {
      const d = r.scheduled_start ? new Date(r.scheduled_start as string) : null;
      if (!d) continue;
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
      const k = monday.toISOString().slice(0, 10);
      const w = weeks.get(k) ?? { standard: 0, normal: 0, emergency: 0 };
      const type = r.change_type === 'standard' || r.change_type === 'emergency' ? r.change_type : 'normal';
      w[type]++;
      weeks.set(k, w);
    }
    const outcomes = await changeOutcomes(ctx, { customerId: p.customerId, from: p.from, to: p.to });
    const implemented = list.filter((r) => r.status_category === 'resolved' || r.status_category === 'closed').length;
    return {
      columns: [col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('change_type', 'Type'), col('risk', 'Risk'), col('status', 'Status'), col('approval_status', 'Approval'), col('scheduled_start', 'Scheduled start', 'datetime'), col('scheduled_end', 'Scheduled end', 'datetime'), col('downtime_expected_minutes', 'Downtime', 'minutes'), col('assignee', 'Assignee'), col('service', 'Service'), col('risk_level', 'Risk level'), col('risk_score', 'Risk score', 'number'), col('template', 'Template'), col('cab_meeting', 'CAB meeting'), col('cab_decision', 'CAB decision')],
      rows: list,
      summary: [
        { label: 'Changes', value: list.length },
        { label: 'Emergency', value: list.filter((r) => r.change_type === 'emergency').length },
        { label: 'Standard', value: list.filter((r) => r.change_type === 'standard').length },
        { label: 'Implemented', value: implemented },
        { label: 'Awaiting approval', value: list.filter((r) => r.approval_status === 'pending').length },
        { label: 'High risk', value: list.filter((r) => r.risk_level === 'high').length },
        { label: 'From a template', value: list.filter((r) => r.template != null).length },
        { label: 'Success rate', value: outcomes.successPct ?? 'n/a', unit: 'pct', target: 95, hint: `${outcomes.failed} failed, ${outcomes.backedOut} backed out`, tone: outcomes.successPct === null ? undefined : outcomes.successPct >= 95 ? 'good' : outcomes.successPct >= 85 ? 'warn' : 'bad' },
      ],
      charts: [
        { type: 'stacked_bar', title: 'Changes per week by type', subtitle: 'By scheduled start', data: [...weeks].sort().map(([label, w]) => ({ label, ...w })), x: 'label', y: ['standard', 'normal', 'emergency'], labels: { standard: 'Standard', normal: 'Normal', emergency: 'Emergency' } },
        { type: 'donut', title: 'Changes by status', data: countsOf(list, 'status_category', 'open', STATUS_CATEGORY_LABEL), x: 'label', y: 'count', insight: 'none' },
      ],
      sections: [{ title: 'Failed or backed out', intro: 'Changes that ended in the period without a successful implementation.', columns: [col('number', 'Number'), col('title', 'Title'), col('changeType', 'Type'), col('outcome', 'Outcome'), col('scheduledStart', 'Scheduled start', 'datetime'), col('assignee', 'Assignee')], rows: outcomes.failedList.map((r) => ({ ...r })) }],
    };
  },
});

// ---------------------------------------------------------------- cab_decisions
registerReport({
  key: 'cab_decisions',
  name: 'CAB decisions',
  description: 'Every decision taken at CAB meetings in the period, by meeting, with the deferred and still-pending items.',
  category: 'tickets',
  permissions: ['reports:run'],
  portal: false,
  parameters: [customerParam, dateRangeParam, { key: 'decision', label: 'Decision', type: 'select', options: [{ value: '', label: 'All' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }, { value: 'deferred', label: 'Deferred' }, { value: 'pending', label: 'Pending' }] }],
  defaultDateRange: 'last_30_days',
  async run(ctx, p): Promise<ReportResult> {
    const decision = strParam(p, 'decision');
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT m.id AS meeting_id, m.title AS meeting, m.scheduled_at, m.status AS meeting_status, ch.name AS chair, t.id, t.number, t.title, cu.name AS customer, cd.change_type, cd.risk_level,
        i.decision, d.name AS decided_by, i.decided_at, i.notes
      FROM cab_meeting_items i JOIN cab_meetings m ON m.id = i.meeting_id JOIN tickets t ON t.id = i.ticket_id
        LEFT JOIN users d ON d.id = i.decided_by LEFT JOIN users ch ON ch.id = m.chair_user_id LEFT JOIN customers cu ON cu.id = t.customer_id LEFT JOIN change_details cd ON cd.ticket_id = t.id
      WHERE true ${rangeCond(sql`m.scheduled_at`, p.from, p.to)} ${customerCond(p.customerId)} ${socCond(ctx)} ${decision ? sql`AND i.decision = ${decision}` : sql``}
      ORDER BY m.scheduled_at DESC, i.sort_order, i.created_at ${limitSql()}`);
    const weeks = new Map<string, { approved: number; rejected: number; deferred: number }>();
    for (const r of list) {
      const d = new Date(r.scheduled_at as string);
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
      const k = monday.toISOString().slice(0, 10);
      const w = weeks.get(k) ?? { approved: 0, rejected: 0, deferred: 0 };
      if (r.decision === 'approved' || r.decision === 'rejected' || r.decision === 'deferred') w[r.decision as 'approved' | 'rejected' | 'deferred']++;
      weeks.set(k, w);
    }
    const by = (v: string) => list.filter((r) => r.decision === v).length;
    return {
      columns: [col('meeting', 'Meeting'), col('scheduled_at', 'Scheduled', 'datetime'), col('chair', 'Chair'), col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('change_type', 'Type'), col('risk_level', 'Risk level'), col('decision', 'Decision'), col('decided_by', 'Decided by'), col('decided_at', 'Decided at', 'datetime'), col('notes', 'Notes')],
      rows: list,
      summary: [
        { label: 'Meetings', value: new Set(list.map((r) => String(r.meeting_id))).size },
        { label: 'Items', value: list.length },
        { label: 'Approved', value: by('approved') },
        { label: 'Rejected', value: by('rejected') },
        { label: 'Deferred', value: by('deferred') },
        { label: 'Pending', value: by('pending') },
      ],
      charts: [{ type: 'bar', title: 'Decisions per week', data: [...weeks].sort().map(([label, w]) => ({ label, ...w })), x: 'label', y: ['approved', 'rejected', 'deferred'], labels: { approved: 'Approved', rejected: 'Rejected', deferred: 'Deferred' } }],
    };
  },
});

// ---------------------------------------------------------------- problem_summary
registerReport({
  key: 'problem_summary',
  name: 'Problem summary',
  description: 'Problem records with root cause, known-error state, workaround and linked incident counts.',
  category: 'tickets',
  permissions: ['reports:run'],
  portal: true,
  parameters: [customerParam, dateRangeParam, { key: 'openOnly', label: 'Open problems only', type: 'boolean' }],
  defaultDateRange: 'last_90_days',
  async run(ctx, p): Promise<ReportResult> {
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT t.id, t.number, t.title, cu.name AS customer, pr.label AS priority, st.label AS status, st.status_category, cat.label AS category, sv.name AS service, asg.name AS assignee,
        t.created_at, t.resolved_at, left(pd.root_cause, 300) AS root_cause, pd.is_known_error, (pd.workaround IS NOT NULL AND pd.workaround <> '') AS has_workaround, (pd.permanent_fix IS NOT NULL AND pd.permanent_fix <> '') AS has_permanent_fix,
        (SELECT count(*)::int FROM ticket_links l WHERE (l.target_ticket_id = t.id OR l.source_ticket_id = t.id) AND l.link_type IN ('problem_of', 'caused_by', 'related')) AS linked_incidents,
        CASE WHEN pd.is_known_error THEN coalesce(pd.ke_status, 'open') END AS ke_status, coalesce(pd.portal_visible, false) AS portal_visible, fc.number AS fix_change
      FROM tickets t LEFT JOIN problem_details pd ON pd.ticket_id = t.id LEFT JOIN tickets fc ON fc.id = pd.fix_change_id ${ticketJoins}
      WHERE t.type = 'problem' ${boolParam(p, 'openOnly') ? openCond() : rangeCond(sql`t.created_at`, p.from, p.to)} ${customerCond(p.customerId)} ${socCond(ctx)}
      ORDER BY t.created_at DESC ${limitSql()}`);
    return {
      columns: [col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('priority', 'Priority'), col('status', 'Status'), col('category', 'Category'), col('is_known_error', 'Known error', 'boolean'), col('has_workaround', 'Workaround', 'boolean'), col('has_permanent_fix', 'Permanent fix', 'boolean'), col('ke_status', 'Known error status'), col('portal_visible', 'Published to portal', 'boolean'), col('fix_change', 'Fix change'), col('linked_incidents', 'Linked incidents', 'number'), col('root_cause', 'Root cause'), col('assignee', 'Owner'), col('created_at', 'Created', 'datetime'), col('resolved_at', 'Resolved', 'datetime')],
      rows: list.map((r) => ({ ...r, ke_status: r.ke_status ? (KNOWN_ERROR_STATUS_LABELS[String(r.ke_status) as keyof typeof KNOWN_ERROR_STATUS_LABELS] ?? r.ke_status) : null })),
      summary: [
        { label: 'Problems', value: list.length },
        { label: 'Open', value: list.filter((r) => ['new', 'open', 'pending'].includes(String(r.status_category))).length },
        { label: 'Known errors', value: list.filter((r) => r.is_known_error).length },
        { label: 'With root cause', value: list.filter((r) => r.root_cause).length },
        { label: 'Linked incidents', value: list.reduce((s, r) => s + num(r.linked_incidents), 0) },
        { label: 'Published to portal', value: list.filter((r) => r.portal_visible).length },
      ],
      charts: [
        { type: 'donut', title: 'Problems by status', data: countsOf(list, 'status'), x: 'label', y: 'count', insight: 'none' },
        { type: 'bar', title: 'Known error status', subtitle: 'Problems flagged as known errors', data: countsOf(list.filter((r) => r.is_known_error), 'ke_status', 'Open', Object.fromEntries(Object.entries(KNOWN_ERROR_STATUS_LABELS))), x: 'label', y: 'count', insight: 'none' },
      ],
    };
  },
});

