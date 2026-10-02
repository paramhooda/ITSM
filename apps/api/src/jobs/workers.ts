import { Worker, type Processor } from 'bullmq';
import { redisConnection, QUEUES, type QueueName, getQueue } from './queues';
import { logger } from '@/core/logger';

type Registration = { queue: QueueName; processor: Processor; concurrency?: number };
type Schedule = { queue: QueueName; jobName: string; pattern: string; data?: Record<string, unknown> };

const registrations: Registration[] = [];
const schedules: Schedule[] = [];
const workers: Worker[] = [];

export function registerProcessor(reg: Registration) {
  registrations.push(reg);
}

/** Repeatable jobs (cron). Registered once per queue; BullMQ dedupes by key. */
export function registerSchedule(s: Schedule) {
  schedules.push(s);
}

export async function startWorkers() {
  await import('./processors');
  for (const reg of registrations) {
    const w = new Worker(reg.queue, reg.processor, { connection: redisConnection, concurrency: reg.concurrency ?? 2 });
    w.on('failed', (job, err) => logger.error({ queue: reg.queue, job: job?.name, id: job?.id, err: err.message }, 'job failed'));
    w.on('error', (err) => logger.error({ queue: reg.queue, err: err.message }, 'worker error'));
    workers.push(w);
  }
  for (const s of schedules) {
    await getQueue(s.queue).upsertJobScheduler(`${s.queue}:${s.jobName}`, { pattern: s.pattern }, { name: s.jobName, data: s.data ?? {} });
  }
  logger.info({ workers: registrations.length, schedules: schedules.length, queues: Object.values(QUEUES) }, 'workers registered');
}

export async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close()));
}
