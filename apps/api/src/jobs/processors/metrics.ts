import { sql } from 'drizzle-orm';
import { registerProcessor, registerSchedule } from '../workers';
import { withSystem, type Tx } from '@/db/client';
import { logger } from '@/core/logger';

/**
 * Nightly per-customer metric rollups so dashboards and reports stay fast as
 * history grows. Each day row holds a JSON map of counters/averages; "today"
 * is always computed live by the dashboards module and merged.
 */
export async function computeRollups(tx: Tx, day: string) {
  await tx.execute(sql`
    WITH t AS (
      SELECT customer_id,
        count(*) FILTER (WHERE created_at::date = ${day}::date) AS opened,
        count(*) FILTER (WHERE created_at::date = ${day}::date AND type = 'incident') AS incidents_opened,
        count(*) FILTER (WHERE created_at::date = ${day}::date AND type = 'request') AS requests_opened,
        count(*) FILTER (WHERE created_at::date = ${day}::date AND domain = 'soc') AS security_opened,
        count(*) FILTER (WHERE resolved_at::date = ${day}::date) AS resolved,
        count(*) FILTER (WHERE closed_at::date = ${day}::date) AS closed,
        count(*) FILTER (WHERE created_at::date = ${day}::date AND scope_status = 'out_of_scope') AS out_of_scope,
        count(*) FILTER (WHERE created_at::date = ${day}::date AND is_major) AS major,
        avg(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60) FILTER (WHERE resolved_at::date = ${day}::date) AS mttr_minutes,
        avg(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60) FILTER (WHERE first_response_at::date = ${day}::date) AS first_response_minutes
      FROM tickets
      WHERE created_at >= ${day}::date - interval '400 days'
      GROUP BY customer_id
    ), s AS (
      SELECT customer_id,
        count(*) FILTER (WHERE state = 'met' AND completed_at::date = ${day}::date) AS sla_met,
        count(*) FILTER (WHERE state = 'breached' AND breached_at::date = ${day}::date) AS sla_breached,
        count(*) FILTER (WHERE metric = 'resolution' AND state = 'met' AND completed_at::date = ${day}::date) AS resolution_met,
        count(*) FILTER (WHERE metric = 'resolution' AND state = 'breached' AND breached_at::date = ${day}::date) AS resolution_breached,
        count(*) FILTER (WHERE metric = 'response' AND state = 'met' AND completed_at::date = ${day}::date) AS response_met,
        count(*) FILTER (WHERE metric = 'response' AND state = 'breached' AND breached_at::date = ${day}::date) AS response_breached
      FROM ticket_slas
      WHERE created_at >= ${day}::date - interval '400 days'
      GROUP BY customer_id
    ), v AS (
      SELECT customer_id,
        count(*) FILTER (WHERE status = 'completed' AND actual_end::date = ${day}::date) AS visits_completed,
        coalesce(sum(work_minutes) FILTER (WHERE status = 'completed' AND actual_end::date = ${day}::date), 0) AS visit_minutes
      FROM field_visits GROUP BY customer_id
    ), p AS (
      SELECT customer_id,
        count(*) FILTER (WHERE status = 'completed' AND completed_at::date = ${day}::date) AS pm_completed,
        count(*) FILTER (WHERE status = 'missed' AND updated_at::date = ${day}::date) AS pm_missed
      FROM pm_occurrences GROUP BY customer_id
    ), e AS (
      SELECT customer_id, coalesce(sum(minutes), 0) AS engineering_minutes
      FROM time_entries WHERE created_at::date = ${day}::date GROUP BY customer_id
    ), ids AS (
      SELECT customer_id FROM t UNION SELECT customer_id FROM s UNION SELECT customer_id FROM v UNION SELECT customer_id FROM p UNION SELECT customer_id FROM e
    )
    INSERT INTO metric_rollups_daily (day, customer_id, metrics, computed_at)
    SELECT ${day}::date, ids.customer_id,
      jsonb_strip_nulls(jsonb_build_object(
        'opened', coalesce(t.opened, 0), 'incidentsOpened', coalesce(t.incidents_opened, 0), 'requestsOpened', coalesce(t.requests_opened, 0),
        'securityOpened', coalesce(t.security_opened, 0), 'resolved', coalesce(t.resolved, 0), 'closed', coalesce(t.closed, 0),
        'outOfScope', coalesce(t.out_of_scope, 0), 'major', coalesce(t.major, 0),
        'mttrMinutes', round(t.mttr_minutes::numeric, 1), 'firstResponseMinutes', round(t.first_response_minutes::numeric, 1),
        'slaMet', coalesce(s.sla_met, 0), 'slaBreached', coalesce(s.sla_breached, 0),
        'resolutionMet', coalesce(s.resolution_met, 0), 'resolutionBreached', coalesce(s.resolution_breached, 0),
        'responseMet', coalesce(s.response_met, 0), 'responseBreached', coalesce(s.response_breached, 0),
        'visitsCompleted', coalesce(v.visits_completed, 0), 'visitMinutes', coalesce(v.visit_minutes, 0),
        'pmCompleted', coalesce(p.pm_completed, 0), 'pmMissed', coalesce(p.pm_missed, 0),
        'engineeringMinutes', coalesce(e.engineering_minutes, 0)
      )), now()
    FROM ids
    LEFT JOIN t ON t.customer_id = ids.customer_id
    LEFT JOIN s ON s.customer_id = ids.customer_id
    LEFT JOIN v ON v.customer_id = ids.customer_id
    LEFT JOIN p ON p.customer_id = ids.customer_id
    LEFT JOIN e ON e.customer_id = ids.customer_id
    ON CONFLICT (day, customer_id) DO UPDATE SET metrics = EXCLUDED.metrics, computed_at = now()`);
}

/** Recomputes the last N days (default 3) so late updates (closures, SLA completions) are captured. */
export async function rollupRecentDays(days = 3) {
  await withSystem(async (tx) => {
    for (let i = 1; i <= days; i++) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      await computeRollups(tx, d);
    }
  });
}

/** Backfills rollups for a date range (used after importing historical data). */
export async function backfillRollups(from: string, to: string) {
  await withSystem(async (tx) => {
    const start = new Date(from);
    const end = new Date(to);
    for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) await computeRollups(tx, d.toISOString().slice(0, 10));
  });
}

registerSchedule({ queue: 'maintenance', jobName: 'metric-rollups', pattern: '30 1 * * *' });
registerProcessor({
  queue: 'maintenance',
  jobName: 'metric-rollups',
  processor: async () => {
    await rollupRecentDays(3);
    logger.info('metric rollups computed');
  },
});
registerProcessor({
  queue: 'maintenance',
  jobName: 'metric-backfill',
  processor: async (job) => {
    const { from, to } = job.data as { from: string; to: string };
    await backfillRollups(from, to);
  },
});
