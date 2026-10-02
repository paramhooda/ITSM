/**
 * Discovery background processing: executes queued runs (one at a time per
 * worker, since a scan can open hundreds of sockets) and schedules cron-driven
 * sources every 15 minutes.
 */
import { registerProcessor, registerSchedule } from '../workers';
import { executeRun, scheduleDueSources, RunNotFoundError } from '@/modules/discovery/runner';
import { logger } from '@/core/logger';

export const DISCOVERY_SCHEDULER_JOB = 'discovery-scheduler';

registerProcessor({
  queue: 'discovery',
  concurrency: 1,
  processor: async (job) => {
    if (job.name === 'run') {
      const runId = (job.data as { runId?: string }).runId;
      if (!runId) {
        logger.warn({ jobId: job.id }, 'discovery job without runId');
        return;
      }
      // executeRun records failures on the run row itself, so a crashed scan is not retried.
      // The one exception is a run row that is not visible yet (enqueued inside the API transaction): let BullMQ retry with backoff.
      await executeRun(runId).catch((err) => {
        if (err instanceof RunNotFoundError) throw err;
        logger.error({ err, runId }, 'discovery run crashed');
      });
      return;
    }
    if (job.name === DISCOVERY_SCHEDULER_JOB) {
      await scheduleDueSources().catch((err) => logger.error({ err }, 'discovery scheduler failed'));
    }
  },
});

registerSchedule({ queue: 'discovery', jobName: DISCOVERY_SCHEDULER_JOB, pattern: '*/15 * * * *' });
