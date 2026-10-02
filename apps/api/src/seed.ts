import { withSystem, closeDb, schema } from '@/db/client';
import { config } from '@/config';
import { logger } from '@/core/logger';
import { hashPassword } from '@/lib/crypto';
import { seedDefaults, seedAdmin } from '@/seed/defaults';

export async function runSeed(opts: { demo?: boolean } = {}) {
  await withSystem(async (tx) => {
    await seedDefaults(tx);
  });
  const passwordHash = await hashPassword(config.ADMIN_PASSWORD);
  await withSystem((tx) => seedAdmin(tx, { email: config.ADMIN_EMAIL, name: config.ADMIN_NAME, passwordHash }));
  const demo = opts.demo ?? config.SEED_DEMO_DATA;
  if (demo) {
    const hasCustomers = await withSystem(async (tx) => (await tx.select({ id: schema.customers.id }).from(schema.customers).limit(1)).length > 0);
    if (!hasCustomers) {
      const { seedDemo } = await import('@/seed/demo');
      await seedDemo();
      logger.info('demo dataset loaded');
    }
  }
  logger.info('seed complete');
}

const isMain = process.argv[1] && (process.argv[1].endsWith('seed.ts') || process.argv[1].endsWith('seed.js'));
if (isMain) {
  runSeed()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'seed failed');
      process.exit(1);
    });
}
