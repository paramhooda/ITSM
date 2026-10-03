import { registerProcessor, registerSchedule } from '../workers';
import { logger } from '@/core/logger';
import { remindUpcomingWindows } from '@/modules/changes/service';

/** Hourly: a reminder to the implementer, the requester and the team before a change window opens (changes.reminder_hours). */
registerSchedule({ queue: 'sla', jobName: 'change-window-reminder', pattern: '0 * * * *' });
registerProcessor({
  queue: 'sla',
  jobName: 'change-window-reminder',
  concurrency: 1,
  processor: async () => {
    const reminded = await remindUpcomingWindows();
    if (reminded) logger.info({ reminded }, 'change window reminders sent');
  },
});
