import { sql } from 'drizzle-orm';
import { registerProcessor, registerSchedule } from '../workers';
import { withSystem } from '@/db/client';
import { logger } from '@/core/logger';

/** Keeps future monthly partitions available and prunes old ones per retention settings. */
registerSchedule({ queue: 'maintenance', jobName: 'partitions', pattern: '15 2 * * *' });
registerProcessor({
  queue: 'maintenance',
  processor: async (job) => {
    if (job.name !== 'partitions') return;
    await withSystem(async (tx) => {
      await tx.execute(sql`SELECT app_ensure_month_partitions('audit_log', 3)`);
      await tx.execute(sql`SELECT app_ensure_month_partitions('integration_events', 3)`);
      const settings = await tx.execute(sql`SELECT key, value FROM system_settings WHERE key IN ('audit.retention_months','events.retention_months')`);
      const map = Object.fromEntries((settings.rows as { key: string; value: unknown }[]).map((r) => [r.key, Number(r.value)]));
      for (const [table, months] of [['audit_log', map['audit.retention_months'] || 36], ['integration_events', map['events.retention_months'] || 12]] as [string, number][]) {
        const old = await tx.execute(sql`
          SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
          WHERE p.relname = ${table} AND c.relname ~ '_[0-9]{4}_[0-9]{2}$'
            AND to_date(substring(c.relname from '[0-9]{4}_[0-9]{2}$'), 'YYYY_MM') < date_trunc('month', now()) - make_interval(months => ${months})`);
        for (const r of old.rows as { relname: string }[]) {
          logger.info({ partition: r.relname }, 'dropping expired partition');
          await tx.execute(sql.raw(`DROP TABLE IF EXISTS "${r.relname}"`));
        }
      }
    });
  },
});
