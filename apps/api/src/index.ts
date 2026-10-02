import { buildApp } from '@/core/app';
import { config } from '@/config';
import { logger } from '@/core/logger';
import { closeDb } from '@/db/client';
import { closeQueues } from '@/jobs/queues';

async function main() {
  const app = await buildApp();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeQueues();
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info(`API listening on http://${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
