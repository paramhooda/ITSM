/**
 * Integration event processing: `process-events` jobs are enqueued by the
 * ingestion endpoint with the stored event ids; `sweep-received` runs every
 * minute as a safety net for rows whose job was lost (or whose transaction
 * committed after the job ran). Partition housekeeping lives in maintenance.
 */
import { registerProcessor, registerSchedule } from '../workers';
import { processEvents, processPendingEvents } from '@/modules/integrations/pipeline';
import { logger } from '@/core/logger';

export const PROCESS_EVENTS_JOB = 'process-events';
export const SWEEP_JOB = 'sweep-received';

registerProcessor({
  queue: 'integrations',
  jobName: PROCESS_EVENTS_JOB,
  concurrency: 2,
  processor: async (job) => {
    const data = job.data as { ids?: string[]; force?: boolean };
    const ids = Array.isArray(data.ids) ? data.ids.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length) return { processed: 0 };
    const res = await processEvents(ids, { force: !!data.force, requestId: `job:${job.id ?? 'process-events'}` });
    // Rows inserted inside the API transaction may not be visible yet: let BullMQ retry with backoff (the sweep also covers it).
    if (res.missing.length && job.attemptsMade < 2) throw new Error(`${res.missing.length} integration event(s) not visible yet`);
    if (res.missing.length) logger.warn({ missing: res.missing }, 'integration events never became visible; leaving them to the sweep');
    return { processed: res.processed, results: res.results };
  },
});

registerProcessor({
  queue: 'integrations',
  jobName: SWEEP_JOB,
  concurrency: 1,
  processor: async () => {
    const res = await processPendingEvents().catch((err) => {
      logger.error({ err }, 'integration sweep failed');
      return null;
    });
    return res ? { processed: res.processed } : { processed: 0 };
  },
});

registerSchedule({ queue: 'integrations', jobName: SWEEP_JOB, pattern: '* * * * *' });
