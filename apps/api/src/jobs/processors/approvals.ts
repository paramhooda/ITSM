import { registerProcessor, registerSchedule } from '../workers';
import { logger } from '@/core/logger';
import { remindAndExpire } from '@/modules/tickets/approvals';

/**
 * Hourly: approvers of a step pending longer than approvals.reminder_hours are reminded once; a step past its due
 * date by approvals.expiry_days is expired under approvals.expiry_policy (the ticket returns to work, is rejected, or
 * nothing but the reminder). One transaction per ticket, as the auto-close does.
 */
registerSchedule({ queue: 'sla', jobName: 'approval-reminders', pattern: '0 * * * *' });
registerProcessor({
  queue: 'sla',
  jobName: 'approval-reminders',
  concurrency: 1,
  processor: async () => {
    const res = await remindAndExpire();
    if (res.reminded || res.expired) logger.info(res, 'approval reminders and expiries processed');
  },
});
