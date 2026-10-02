import { sql } from 'drizzle-orm';
import { registerReport, type ReportResult } from '../registry';
import { rows, customerCond, rangeCond, socCond, openCond, limitSql, pct, num, round1, col, boolParam, ticketJoins, minutesBetween, customerParam, dateRangeParam } from './helpers';

const groupCount = (list: Record<string, unknown>[], key: string, fallback = 'Unspecified') => {
  const m = new Map<string, number>();
  for (const r of list) m.set(String(r[key] ?? fallback), (m.get(String(r[key] ?? fallback)) ?? 0) + 1);
  return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
};

// ---------------------------------------------------------------- preventive_maintenance
registerReport({
  key: 'preventive_maintenance',
  name: 'Preventive maintenance',
  description: 'PM programs and occurrences planned in the period: status, on-time completion and missed visits.',
  category: 'pm',
  permissions: ['reports:run', 'pm:read'],
  portal: true,
  parameters: [customerParam, dateRangeParam],
  defaultDateRange: 'last_month',
  async run(ctx, p): Promise<ReportResult> {
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT o.id, pg.name AS program, cu.name AS customer, si.name AS site, sv.name AS service, pg.frequency, o.planned_date, o.scheduled_date, o.status, o.completed_at, u.name AS engineer, v.number AS visit,
        (o.status = 'completed' AND o.completed_at IS NOT NULL AND o.completed_at::date <= o.planned_date + pg.grace_days) AS on_time, pg.grace_days, o.notes
      FROM pm_occurrences o JOIN pm_programs pg ON pg.id = o.program_id LEFT JOIN customers cu ON cu.id = o.customer_id LEFT JOIN sites si ON si.id = pg.site_id LEFT JOIN services sv ON sv.id = pg.service_id
        LEFT JOIN users u ON u.id = coalesce(o.engineer_id, pg.assigned_engineer_id) LEFT JOIN field_visits v ON v.id = o.field_visit_id
      WHERE o.planned_date >= ${p.from}::date AND o.planned_date <= ${p.to}::date ${customerCond(p.customerId, sql`o.customer_id`)}
      ORDER BY o.planned_date, pg.name ${limitSql()}`);
    const completed = list.filter((r) => r.status === 'completed');
    const onTime = completed.filter((r) => r.on_time).length;
    const programs = await rows<Record<string, unknown>>(ctx, sql`
      SELECT pg.name AS program, cu.name AS customer, pg.frequency, pg.is_active, pg.start_date, pg.end_date,
        (SELECT count(*)::int FROM pm_occurrences o WHERE o.program_id = pg.id AND o.planned_date >= ${p.from}::date AND o.planned_date <= ${p.to}::date) AS planned,
        (SELECT count(*)::int FROM pm_occurrences o WHERE o.program_id = pg.id AND o.status = 'completed' AND o.planned_date >= ${p.from}::date AND o.planned_date <= ${p.to}::date) AS completed,
        (SELECT count(*)::int FROM pm_occurrences o WHERE o.program_id = pg.id AND o.status = 'missed' AND o.planned_date >= ${p.from}::date AND o.planned_date <= ${p.to}::date) AS missed
      FROM pm_programs pg LEFT JOIN customers cu ON cu.id = pg.customer_id WHERE pg.is_active ${customerCond(p.customerId, sql`pg.customer_id`)} ORDER BY cu.name, pg.name ${limitSql(2000)}`);
    const months = new Map<string, { planned: number; completed: number; missed: number }>();
    for (const r of list) {
      const k = String(r.planned_date).slice(0, 7);
      const m = months.get(k) ?? { planned: 0, completed: 0, missed: 0 };
      m.planned++;
      if (r.status === 'completed') m.completed++;
      if (r.status === 'missed') m.missed++;
      months.set(k, m);
    }
    return {
      columns: [col('program', 'Program'), col('customer', 'Customer'), col('site', 'Site'), col('service', 'Service'), col('frequency', 'Frequency'), col('planned_date', 'Planned', 'date'), col('scheduled_date', 'Scheduled', 'date'), col('status', 'Status'), col('completed_at', 'Completed', 'datetime'), col('on_time', 'On time', 'boolean'), col('engineer', 'Engineer'), col('visit', 'Visit')],
      rows: list,
      summary: [
        { label: 'Occurrences planned', value: list.length },
        { label: 'Completed', value: completed.length },
        { label: 'On-time %', value: pct(onTime, completed.length) ?? 'n/a' },
        { label: 'Missed', value: list.filter((r) => r.status === 'missed').length },
        { label: 'Scheduled / planned', value: list.filter((r) => r.status === 'scheduled' || r.status === 'planned').length },
        { label: 'Active programs', value: programs.length },
      ],
      charts: [
        { type: 'bar', title: 'Occurrences by status', data: groupCount(list, 'status'), x: 'label', y: 'count' },
        { type: 'bar', title: 'Planned vs completed per month', data: [...months].sort().map(([label, m]) => ({ label, ...m })), x: 'label', y: ['planned', 'completed', 'missed'], labels: { planned: 'Planned', completed: 'Completed', missed: 'Missed' } },
      ],
      sections: [{ title: 'Programs', columns: [col('program', 'Program'), col('customer', 'Customer'), col('frequency', 'Frequency'), col('start_date', 'Start', 'date'), col('end_date', 'End', 'date'), col('planned', 'Planned', 'number'), col('completed', 'Completed', 'number'), col('missed', 'Missed', 'number')], rows: programs }],
    };
  },
});

// ---------------------------------------------------------------- field_visits
registerReport({
  key: 'field_visits',
  name: 'Field visits',
  description: 'Field visits by status, engineer and type with work/travel minutes and customer acknowledgement.',
  category: 'field',
  permissions: ['reports:run', 'field:read'],
  portal: true,
  parameters: [customerParam, dateRangeParam, { key: 'status', label: 'Status', type: 'select', options: ['requested', 'scheduled', 'in_progress', 'completed', 'cancelled'].map((s) => ({ value: s, label: s.replace('_', ' ') })) }],
  async run(ctx, p): Promise<ReportResult> {
    const status = typeof p.status === 'string' && p.status ? p.status : null;
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT v.id, v.number, v.title, cu.name AS customer, si.name AS site, ty.label AS type, v.status, u.name AS engineer, tm.name AS team, v.scheduled_start, v.scheduled_end, v.actual_start, v.actual_end,
        v.work_minutes, v.travel_minutes, (v.customer_ack_at IS NOT NULL) AS acknowledged, v.customer_ack_name, v.customer_rating, t.number AS ticket, v.billable,
        (SELECT count(*)::int FROM field_visit_parts fp WHERE fp.visit_id = v.id) AS parts
      FROM field_visits v LEFT JOIN customers cu ON cu.id = v.customer_id LEFT JOIN sites si ON si.id = v.site_id LEFT JOIN config_options ty ON ty.id = v.type_id LEFT JOIN users u ON u.id = v.engineer_id LEFT JOIN teams tm ON tm.id = v.team_id LEFT JOIN tickets t ON t.id = v.ticket_id
      WHERE true ${rangeCond(sql`coalesce(v.scheduled_start, v.created_at)`, p.from, p.to)} ${customerCond(p.customerId, sql`v.customer_id`)} ${status ? sql`AND v.status = ${status}` : sql``}
      ORDER BY coalesce(v.scheduled_start, v.created_at) ${limitSql()}`);
    const completed = list.filter((r) => r.status === 'completed');
    const work = completed.reduce((s, r) => s + num(r.work_minutes), 0);
    const rated = completed.filter((r) => r.customer_rating);
    return {
      columns: [col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('site', 'Site'), col('type', 'Type'), col('status', 'Status'), col('engineer', 'Engineer'), col('scheduled_start', 'Scheduled', 'datetime'), col('actual_start', 'Started', 'datetime'), col('actual_end', 'Finished', 'datetime'), col('work_minutes', 'Work', 'minutes'), col('travel_minutes', 'Travel', 'minutes'), col('acknowledged', 'Acknowledged', 'boolean'), col('customer_rating', 'Rating', 'number'), col('ticket', 'Ticket'), col('parts', 'Parts', 'number')],
      rows: list,
      summary: [
        { label: 'Visits', value: list.length },
        { label: 'Completed', value: completed.length },
        { label: 'Cancelled', value: list.filter((r) => r.status === 'cancelled').length },
        { label: 'Work hours', value: Math.round(work / 6) / 10 },
        { label: 'Acknowledged %', value: pct(completed.filter((r) => r.acknowledged).length, completed.length) ?? 'n/a' },
        { label: 'Avg rating', value: rated.length ? Math.round((rated.reduce((s, r) => s + num(r.customer_rating), 0) / rated.length) * 10) / 10 : 'n/a' },
      ],
      charts: [
        { type: 'bar', title: 'Visits by status', data: groupCount(list, 'status'), x: 'label', y: 'count' },
        { type: 'bar', title: 'Visits by engineer', data: groupCount(list, 'engineer', 'Unassigned').slice(0, 12), x: 'label', y: 'count' },
      ],
    };
  },
});

// ---------------------------------------------------------------- security_incidents
registerReport({
  key: 'security_incidents',
  name: 'Security incidents (SOC)',
  description: 'Security tickets by severity, category and status with MTTR, escalations and SLA breaches.',
  category: 'soc',
  permissions: ['reports:run', 'soc:read'],
  portal: true,
  parameters: [customerParam, dateRangeParam, { key: 'severityIds', label: 'Severity', type: 'multiselect', optionType: 'security_severity' }],
  async run(ctx, p): Promise<ReportResult> {
    const sev = Array.isArray(p.severityIds) ? (p.severityIds as string[]) : typeof p.severityIds === 'string' && p.severityIds ? String(p.severityIds).split(',') : [];
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT t.id, t.number, t.title, cu.name AS customer, sev.label AS severity, sev.level AS severity_level, pr.label AS priority, cat.label AS category, st.label AS status, st.status_category, asg.name AS assignee,
        t.created_at, t.resolved_at, ${minutesBetween(sql`t.resolved_at`, sql`t.created_at`)} AS mttr_minutes, ${minutesBetween(sql`t.first_response_at`, sql`t.created_at`)} AS response_minutes, t.escalation_level, ci.name AS ci, (t.integration_event_id IS NOT NULL) AS from_siem,
        EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = t.id AND s.state = 'breached') AS breached
      FROM tickets t LEFT JOIN config_options sev ON sev.id = t.security_severity_id LEFT JOIN cis ci ON ci.id = t.primary_ci_id ${ticketJoins}
      WHERE t.domain = 'soc' ${rangeCond(sql`t.created_at`, p.from, p.to)} ${customerCond(p.customerId)} ${sev.length ? sql`AND t.security_severity_id = ANY(ARRAY[${sql.join(sev.map((s) => sql`${s}::uuid`), sql`, `)}])` : sql``}
      ORDER BY sev.level NULLS LAST, t.created_at DESC ${limitSql()}`);
    const resolved = list.filter((r) => r.resolved_at);
    return {
      columns: [col('number', 'Number'), col('title', 'Title'), col('customer', 'Customer'), col('severity', 'Severity'), col('priority', 'Priority'), col('category', 'Category'), col('status', 'Status'), col('assignee', 'Analyst'), col('ci', 'CI'), col('created_at', 'Created', 'datetime'), col('resolved_at', 'Resolved', 'datetime'), col('mttr_minutes', 'Time to resolve', 'minutes'), col('response_minutes', 'First response', 'minutes'), col('escalation_level', 'Escalation', 'number'), col('breached', 'SLA breached', 'boolean'), col('from_siem', 'From SIEM', 'boolean')],
      rows: list,
      summary: [
        { label: 'Security incidents', value: list.length },
        { label: 'Open', value: list.filter((r) => ['new', 'open', 'pending'].includes(String(r.status_category))).length },
        { label: 'Critical / high', value: list.filter((r) => num(r.severity_level) > 0 && num(r.severity_level) <= 2).length },
        { label: 'MTTR (min)', value: resolved.length ? Math.round(resolved.reduce((s, r) => s + num(r.mttr_minutes), 0) / resolved.length) : null },
        { label: 'Escalated', value: list.filter((r) => num(r.escalation_level) > 0).length },
        { label: 'SLA breached', value: list.filter((r) => r.breached).length },
      ],
      charts: [
        { type: 'bar', title: 'By severity', data: groupCount(list, 'severity'), x: 'label', y: 'count' },
        { type: 'bar', title: 'By category', data: groupCount(list, 'category').slice(0, 12), x: 'label', y: 'count' },
      ],
    };
  },
});

// ---------------------------------------------------------------- noc_performance
registerReport({
  key: 'noc_performance',
  name: 'NOC performance',
  description: 'Operational tickets by category with response/resolution times, monitoring-generated volume and engineer workload.',
  category: 'noc',
  permissions: ['reports:run'],
  portal: false,
  parameters: [customerParam, dateRangeParam],
  async run(ctx, p): Promise<ReportResult> {
    const base = sql`t.domain <> 'soc' ${rangeCond(sql`t.created_at`, p.from, p.to)} ${customerCond(p.customerId)}`;
    const byCategory = await rows<Record<string, unknown>>(ctx, sql`
      SELECT coalesce(cat.label, 'Uncategorized') AS category, count(*)::int AS tickets, count(*) FILTER (WHERE t.type = 'incident')::int AS incidents, count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved,
        ${minutesBetween(sql`avg(t.first_response_at - t.created_at)`, sql`interval '0'`)} AS avg_response_minutes, ${minutesBetween(sql`avg(t.resolved_at - t.created_at)`, sql`interval '0'`)} AS avg_resolution_minutes,
        count(*) FILTER (WHERE t.integration_event_id IS NOT NULL)::int AS monitoring_generated, count(*) FILTER (WHERE pr.level <= 2)::int AS p1_p2,
        (SELECT count(*)::int FROM ticket_slas s WHERE s.ticket_id = ANY(array_agg(t.id)) AND s.state = 'breached') AS breached
      FROM tickets t LEFT JOIN config_options cat ON cat.id = t.category_id LEFT JOIN config_options pr ON pr.id = t.priority_id
      WHERE ${base} GROUP BY 1 ORDER BY 2 DESC ${limitSql(200)}`);
    const workload = await rows<Record<string, unknown>>(ctx, sql`
      SELECT coalesce(u.name, 'Unassigned') AS engineer, count(*)::int AS tickets, count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved,
        (SELECT count(*)::int FROM tickets o WHERE o.assignee_id = t.assignee_id AND o.domain <> 'soc' ${openCond(sql`o.status_id`)} ${customerCond(p.customerId, sql`o.customer_id`)}) AS open_now,
        ${minutesBetween(sql`avg(t.resolved_at - t.created_at)`, sql`interval '0'`)} AS avg_resolution_minutes,
        (SELECT coalesce(sum(te.minutes), 0)::int FROM time_entries te WHERE te.user_id = t.assignee_id ${rangeCond(sql`te.created_at`, p.from, p.to)} ${customerCond(p.customerId, sql`te.customer_id`)}) AS logged_minutes
      FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id WHERE ${base} GROUP BY t.assignee_id, u.name ORDER BY 2 DESC ${limitSql(100)}`);
    const events = await rows<{ total: number; ticketed: number }>(ctx, sql`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE e.ticket_id IS NOT NULL)::int AS ticketed FROM integration_events e
      WHERE e.integration_type = 'prtg' ${rangeCond(sql`e.received_at`, p.from, p.to)} ${customerCond(p.customerId, sql`e.customer_id`)}`);
    const table: Record<string, unknown>[] = byCategory.map((r) => ({ ...r, avg_response_minutes: round1(r.avg_response_minutes), avg_resolution_minutes: round1(r.avg_resolution_minutes) }));
    const total = table.reduce((s, r) => s + num(r.tickets), 0);
    const monitoring = table.reduce((s, r) => s + num(r.monitoring_generated), 0);
    const wAvg = (k: string, w: string) => {
      const den = table.reduce((s, r) => s + (r[k] === null ? 0 : num(r[w])), 0);
      return den ? Math.round(table.reduce((s, r) => s + (r[k] === null ? 0 : num(r[k]) * num(r[w])), 0) / den) : null;
    };
    return {
      columns: [col('category', 'Category'), col('tickets', 'Tickets', 'number'), col('incidents', 'Incidents', 'number'), col('p1_p2', 'P1/P2', 'number'), col('resolved', 'Resolved', 'number'), col('avg_response_minutes', 'Avg response', 'minutes'), col('avg_resolution_minutes', 'Avg resolution', 'minutes'), col('breached', 'SLA breaches', 'number'), col('monitoring_generated', 'From monitoring', 'number')],
      rows: table,
      summary: [
        { label: 'Tickets', value: total },
        { label: 'From monitoring', value: pct(monitoring, total) ?? 0, hint: `${monitoring} tickets; ${events[0]?.total ?? 0} PRTG events, ${events[0]?.ticketed ?? 0} ticketed` },
        { label: 'Avg response (min)', value: wAvg('avg_response_minutes', 'tickets') },
        { label: 'Avg resolution (min)', value: wAvg('avg_resolution_minutes', 'resolved') },
        { label: 'SLA breaches', value: table.reduce((s, r) => s + num(r.breached), 0) },
      ],
      charts: [
        { type: 'bar', title: 'Tickets by category', data: table.slice(0, 12).map((r) => ({ label: r.category, count: r.tickets })), x: 'label', y: 'count' },
        { type: 'bar', title: 'Engineer workload', data: workload.slice(0, 12).map((r) => ({ label: r.engineer, tickets: r.tickets, resolved: r.resolved })), x: 'label', y: ['tickets', 'resolved'], labels: { tickets: 'Assigned', resolved: 'Resolved' } },
      ],
      sections: [{ title: 'Engineer workload', columns: [col('engineer', 'Engineer'), col('tickets', 'Assigned in period', 'number'), col('resolved', 'Resolved', 'number'), col('open_now', 'Open now', 'number'), col('avg_resolution_minutes', 'Avg resolution', 'minutes'), col('logged_minutes', 'Time logged', 'minutes')], rows: workload.map((r) => ({ ...r, avg_resolution_minutes: round1(r.avg_resolution_minutes) })) }],
    };
  },
});

// ---------------------------------------------------------------- out_of_scope_activity
registerReport({
  key: 'out_of_scope_activity',
  name: 'Out-of-scope activity',
  description: 'Tickets classified out of scope (and optionally unknown) by customer, service and category with time spent, for commercial follow-up.',
  category: 'scope',
  permissions: ['reports:run', 'contracts:read'],
  portal: false,
  parameters: [customerParam, dateRangeParam, { key: 'includeUnknown', label: 'Include unknown scope', type: 'boolean', default: true }],
  async run(ctx, p): Promise<ReportResult> {
    const includeUnknown = boolParam(p, 'includeUnknown', true);
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT t.id, t.number, t.type, t.title, cu.name AS customer, sv.name AS service, cat.label AS category, pr.label AS priority, st.label AS status, t.scope_status, t.scope_note, c.number AS contract, asg.name AS assignee, t.created_at, t.resolved_at,
        (SELECT coalesce(sum(te.minutes), 0)::int FROM time_entries te WHERE te.ticket_id = t.id) AS minutes_spent,
        (SELECT count(*)::int FROM field_visits v WHERE v.ticket_id = t.id AND v.status = 'completed') AS visits
      FROM tickets t LEFT JOIN contracts c ON c.id = t.scope_contract_id ${ticketJoins}
      WHERE t.scope_status IN ('out_of_scope' ${includeUnknown ? sql`, 'unknown'` : sql``}) ${rangeCond(sql`t.created_at`, p.from, p.to)} ${customerCond(p.customerId)} ${socCond(ctx)}
      ORDER BY t.created_at DESC ${limitSql()}`);
    const sumBy = (k: string) => {
      const m = new Map<string, { count: number; minutes: number }>();
      for (const r of list) {
        const key = String(r[k] ?? 'Unspecified');
        const v = m.get(key) ?? { count: 0, minutes: 0 };
        v.count++;
        v.minutes += num(r.minutes_spent);
        m.set(key, v);
      }
      return [...m].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.count - a.count);
    };
    const oos = list.filter((r) => r.scope_status === 'out_of_scope');
    return {
      columns: [col('number', 'Number'), col('type', 'Type'), col('title', 'Title'), col('customer', 'Customer'), col('service', 'Service'), col('category', 'Category'), col('priority', 'Priority'), col('status', 'Status'), col('scope_status', 'Scope'), col('scope_note', 'Scope note'), col('contract', 'Contract'), col('assignee', 'Assignee'), col('minutes_spent', 'Time spent', 'minutes'), col('visits', 'Visits', 'number'), col('created_at', 'Created', 'datetime')],
      rows: list,
      summary: [
        { label: 'Out of scope', value: oos.length },
        { label: 'Unknown scope', value: list.length - oos.length },
        { label: 'Time spent (h)', value: Math.round(list.reduce((s, r) => s + num(r.minutes_spent), 0) / 6) / 10 },
        { label: 'Site visits', value: list.reduce((s, r) => s + num(r.visits), 0) },
        { label: 'Customers affected', value: new Set(list.map((r) => r.customer)).size },
      ],
      charts: [
        { type: 'bar', title: 'By customer (top 10)', data: sumBy('customer').slice(0, 10), x: 'label', y: ['count', 'minutes'], labels: { count: 'Tickets', minutes: 'Minutes' } },
        { type: 'bar', title: 'By service', data: sumBy('service').slice(0, 10).map((r) => ({ label: r.label, count: r.count })), x: 'label', y: 'count' },
      ],
      sections: [{ title: 'By customer', columns: [col('label', 'Customer'), col('count', 'Tickets', 'number'), col('minutes', 'Time spent', 'minutes')], rows: sumBy('customer') }],
    };
  },
});
