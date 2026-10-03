import { registerProcessor, registerSchedule } from '../workers';
import { logger } from '@/core/logger';
import { computeServiceHealth } from '@/modules/status/health';

/** Every two minutes: the health of every business service, from major incidents, maintenance windows, P1/P2 tickets and monitoring alerts on what it relies on. */
registerSchedule({ queue: 'sla', jobName: 'status-health', pattern: '*/2 * * * *' });
registerProcessor({
  queue: 'sla',
  jobName: 'status-health',
  concurrency: 1,
  processor: async () => {
    const run = await computeServiceHealth();
    if (run.down || run.degraded || run.maintenance) logger.info(run, 'service health computed');
  },
});
