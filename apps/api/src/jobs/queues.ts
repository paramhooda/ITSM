import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '@/config';

export const redisConnection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: true });

export const QUEUES = {
  sla: 'sla',
  notifications: 'notifications',
  reports: 'reports',
  discovery: 'discovery',
  integrations: 'integrations',
  maintenance: 'maintenance',
  ai: 'ai',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisConnection, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, attempts: 3, backoff: { type: 'exponential', delay: 5000 } } });
    queues.set(name, q);
  }
  return q;
}

export async function enqueue(name: QueueName, jobName: string, data: Record<string, unknown> = {}, opts: JobsOptions = {}) {
  try {
    return await getQueue(name).add(jobName, data, opts);
  } catch (err) {
    // Queueing must never break a user transaction; workers also poll on schedules.
    console.error(`[queue] failed to enqueue ${name}/${jobName}`, err);
    return null;
  }
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  await redisConnection.quit().catch(() => undefined);
}
