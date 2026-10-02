import { aiConfig } from '@/lib/ai';
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
  const ai = aiConfig();
  logger.info({ provider: ai.provider, model: ai.model || null, baseUrl: ai.baseUrl, hasKey: ai.hasKey, notes: ai.notes }, ai.provider === 'none' ? 'AI assistant disabled (set AI_PROVIDER and a key to enable it)' : 'AI assistant enabled');
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
