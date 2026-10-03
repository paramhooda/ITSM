import { registerProcessor, registerSchedule } from '../workers';
import { logger } from '@/core/logger';
import { runScheduler, generateForUser } from '@/modules/briefings/service';

/**
 * Daily briefings: every fifteen minutes the scheduler finds the people whose
 * chosen local time has passed and who have no briefing for their local day,
 * and queues one job per person (idempotent id per person and day). The job
 * generates the briefing under that person's own identity and delivers it
 * through their channels.
 */
registerSchedule({ queue: 'ai', jobName: 'briefing-scheduler', pattern: '*/15 * * * *' });
registerProcessor({ queue: 'ai', jobName: 'briefing-scheduler', concurrency: 1, processor: async () => runScheduler() });
registerProcessor({
  queue: 'ai',
  jobName: 'generate-briefing',
  concurrency: 2,
  processor: async (job) => {
    const { userId, day } = job.data as { userId: string; day: string };
    const out = await generateForUser(userId, day);
    if ('skipped' in out) logger.info({ userId, day, skipped: out.skipped }, 'briefing skipped');
    return out;
  },
});
