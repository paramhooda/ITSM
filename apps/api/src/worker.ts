import { startWorkers, stopWorkers } from '@/jobs/workers';
import { logger } from '@/core/logger';
import { closeDb } from '@/db/client';
import { closeQueues } from '@/jobs/queues';

async function main() {
  await startWorkers();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    try {
      await stopWorkers();
      await closeQueues();
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  logger.info('workers started');
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
