import { Worker, type Processor, type Job } from 'bullmq';
import { redisConnection, QUEUES, type QueueName, getQueue } from './queues';
import { logger } from '@/core/logger';

type Registration = { queue: QueueName; processor: Processor; concurrency?: number; jobName?: string };
type Schedule = { queue: QueueName; jobName: string; pattern: string; data?: Record<string, unknown> };

const registrations: Registration[] = [];
const schedules: Schedule[] = [];
const workers: Worker[] = [];

/**
 * Registers a processor for a queue. With `jobName`, only jobs of that name are
 * routed to it; without it, the processor is a catch-all for the queue (it may
 * inspect `job.name` and ignore jobs it does not own). One BullMQ Worker is
 * created per queue and dispatches by job name.
 */
export function registerProcessor(reg: Registration) {
  registrations.push(reg);
}

/** Repeatable jobs (cron). Registered once per queue; BullMQ dedupes by key. */
export function registerSchedule(s: Schedule) {
  schedules.push(s);
}

async function dispatch(queue: QueueName, job: Job) {
  const regs = registrations.filter((r) => r.queue === queue);
  const exact = regs.filter((r) => r.jobName === job.name);
  const targets = exact.length ? exact : regs.filter((r) => !r.jobName);
  if (!targets.length) {
    logger.warn({ queue, job: job.name }, 'no processor registered for job');
    return;
  }
  let result: unknown;
  for (const r of targets) result = await r.processor(job, job.token ?? '');
  return result;
}

export async function startWorkers() {
  await import('./processors');
  const queues = [...new Set(registrations.map((r) => r.queue))];
  for (const queue of queues) {
    const concurrency = Math.max(1, ...registrations.filter((r) => r.queue === queue).map((r) => r.concurrency ?? 2));
    const w = new Worker(queue, (job) => dispatch(queue, job), { connection: redisConnection, concurrency });
    w.on('failed', (job, err) => logger.error({ queue, job: job?.name, id: job?.id, err: err.message }, 'job failed'));
    w.on('error', (err) => logger.error({ queue, err: err.message }, 'worker error'));
    workers.push(w);
  }
  for (const s of schedules) {
    await getQueue(s.queue).upsertJobScheduler(`${s.queue}:${s.jobName}`, { pattern: s.pattern }, { name: s.jobName, data: s.data ?? {} });
  }
  logger.info({ queues, processors: registrations.length, schedules: schedules.length, allQueues: Object.values(QUEUES) }, 'workers registered');
}

export async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close()));
}
