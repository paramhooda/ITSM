import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { config } from '@/config';
import { logger } from '@/core/logger';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Db;

// numeric -> number, int8 -> number (sizes), dates stay as Date
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'itsm-api',
});

pool.on('error', (err) => logger.error({ err }, 'postgres pool error'));

/** Shared non-transactional client (only for context-free reads such as health checks and auth). */
export const db: Db = drizzle(pool, { schema });

export interface TenantContext {
  userId: string | null;
  allCustomers: boolean;
  customerIds: string[];
}

export const SYSTEM_CONTEXT: TenantContext = { userId: null, allCustomers: true, customerIds: [] };

/**
 * Runs `fn` inside a transaction with the tenant context applied via
 * `set_config(..., true)` so PostgreSQL row-level security enforces isolation
 * for every statement, independent of application code correctness.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.all_customers', $2, true), set_config('app.customer_ids', $3, true)",
      [ctx.userId ?? '', ctx.allCustomers ? 'true' : 'false', ctx.customerIds.join(',')],
    );
    const tx = drizzle(client, { schema }) as Tx;
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** System-level access (background jobs, seeding). Sees all customers. */
export const withSystem = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(SYSTEM_CONTEXT, fn);

export async function closeDb() {
  await pool.end();
}

export { schema };
