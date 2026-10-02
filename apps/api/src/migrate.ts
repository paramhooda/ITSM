/**
 * Runs schema migrations (drizzle) followed by the platform SQL (RLS, partitions,
 * sequences) and grants. Safe to run on every start: it takes an advisory lock so
 * multiple replicas starting together do not race.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { config } from '@/config';
import { logger } from '@/core/logger';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [path.resolve(process.cwd(), 'drizzle'), path.resolve(here, '../drizzle'), path.resolve(here, '../../drizzle')];
const migrationsFolder = candidates.find((c) => {
  try {
    readFileSync(path.join(c, 'meta/_journal.json'));
    return true;
  } catch {
    return false;
  }
});

function readSql(name: string) {
  return readFileSync(path.join(migrationsFolder!, 'sql', name), 'utf8');
}

export async function runMigrations() {
  if (!migrationsFolder) throw new Error('Migrations folder not found');
  const url = config.DATABASE_ADMIN_URL ?? config.DATABASE_URL;
  const client = new pg.Client({ connectionString: url, application_name: 'itsm-migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    const db = drizzle(client);
    logger.info({ migrationsFolder }, 'applying schema migrations');
    await migrate(db, { migrationsFolder });
    logger.info('applying platform SQL (RLS, partitions, sequences)');
    await client.query(readSql('platform.sql'));
    const role = config.APP_DB_USER;
    if (role && /^[a-zA-Z0-9_]+$/.test(role)) {
      await client.query(readSql('grants.sql').replaceAll('__APP_ROLE__', role));
    }
    logger.info('migrations complete');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
}

const isMain = process.argv[1] && (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'));
if (isMain) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
