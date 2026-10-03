import { sql } from 'drizzle-orm';
import { registerProcessor, registerSchedule } from '../workers';
import { withSystem, type Tx } from '@/db/client';
import { logger } from '@/core/logger';

/**
 * Assistant housekeeping: conversations older than the retention setting are
 * deleted once a day (their messages cascade). 0 keeps them forever; anything
 * else is at least 7 days.
 */
export async function purgeConversations(tx: Tx): Promise<{ days: number; deleted: number }> {
  const res = await tx.execute(sql`SELECT value FROM system_settings WHERE key = 'ai.conversation_retention_days'`);
  const raw = Number((res.rows[0] as { value?: unknown } | undefined)?.value ?? 90);
  const days = !Number.isFinite(raw) ? 90 : raw <= 0 ? 0 : Math.max(7, Math.round(raw));
  if (days === 0) return { days, deleted: 0 };
  const del = await tx.execute(sql`DELETE FROM ai_conversations WHERE updated_at < now() - make_interval(days => ${days})`);
  return { days, deleted: del.rowCount ?? 0 };
}

registerSchedule({ queue: 'ai', jobName: 'conversation-purge', pattern: '45 3 * * *' });
registerProcessor({
  queue: 'ai',
  jobName: 'conversation-purge',
  processor: async () => {
    const out = await withSystem(purgeConversations);
    logger.info(out, out.days ? 'ai conversations purged' : 'ai conversations kept (retention 0)');
  },
});
