import { registerProcessor, registerSchedule } from '../workers';
import { sweep } from '@/modules/surveys/service';

/**
 * Satisfaction surveys: every hour at ten past, surveys past their expiry
 * date are closed and the single reminder goes out to the people who have
 * not answered after the policy's reminder delay (`reminded_at` keeps the
 * sweep idempotent).
 */
registerSchedule({ queue: 'notifications', jobName: 'survey-sweep', pattern: '10 * * * *' });
registerProcessor({ queue: 'notifications', jobName: 'survey-sweep', concurrency: 1, processor: async () => sweep() });
