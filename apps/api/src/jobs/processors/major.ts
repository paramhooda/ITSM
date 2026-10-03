import { registerProcessor, registerSchedule } from '../workers';
import { remindOverdueUpdates } from '@/modules/tickets/major';
import { logger } from '@/core/logger';

/** Every five minutes: remind the communications lead when a major incident's stakeholder update is overdue. */
registerSchedule({ queue: 'sla', jobName: 'major-update-reminder', pattern: '*/5 * * * *' });
registerProcessor({
  queue: 'sla',
  jobName: 'major-update-reminder',
  processor: async () => {
    const reminded = await remindOverdueUpdates();
    if (reminded) logger.info({ reminded }, 'major incident update reminders sent');
  },
});
