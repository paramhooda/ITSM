import { registerProcessor, registerSchedule } from '../workers';
import { scoreOpenTickets } from '@/modules/sla/risk';
import { logger } from '@/core/logger';

/** Every five minutes: refresh the breach-risk flag of every ticket with an open SLA clock. */
registerSchedule({ queue: 'sla', jobName: 'risk-score', pattern: '*/5 * * * *' });
registerProcessor({
  queue: 'sla',
  jobName: 'risk-score',
  processor: async () => {
    const run = await scoreOpenTickets();
    if (run.changed || run.cleared) logger.info(run, 'breach risk refreshed');
  },
});
