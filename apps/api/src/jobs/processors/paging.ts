import { registerProcessor, registerSchedule } from '../workers';
import { processTimeout, sweepTimeouts } from '@/modules/oncall/paging';
import { logger } from '@/core/logger';

/**
 * Paging timeouts. `page-timeout` is enqueued with a delay when a page is sent;
 * `page-sweep` runs every minute as the safety net, so a page escalates on
 * time even when the delayed job was lost with Redis.
 */
registerProcessor({
  queue: 'paging',
  jobName: 'page-timeout',
  processor: async (job) => {
    const pageId = String((job.data as { pageId?: string }).pageId ?? '');
    if (!pageId) return;
    const result = await processTimeout(pageId);
    if (result === 'escalated' || result === 'expired') logger.info({ pageId, result }, 'page timed out');
  },
});

registerSchedule({ queue: 'paging', jobName: 'page-sweep', pattern: '* * * * *' });
registerProcessor({
  queue: 'paging',
  jobName: 'page-sweep',
  processor: async () => {
    const processed = await sweepTimeouts();
    if (processed) logger.info({ processed }, 'page sweep moved pages on');
  },
});
