import { withSystem, schema } from '@/db/client';
import { config } from '@/config';
import { logger } from '@/core/logger';
import { hashPassword } from '@/lib/crypto';
import { loadPrincipal, invalidatePrincipal } from '@/core/principal';
import { Rng } from './demo/rng';
import { findAdminUserId, loadRefs, type DemoState } from './demo/state';
import { DEMO_PASSWORD, seedUsers } from './demo/users';
import { seedCustomers } from './demo/customers';
import { seedServices } from './demo/services';
import { seedContracts } from './demo/contracts';
import { seedInventory } from './demo/inventory';
import { seedTickets } from './demo/tickets';
import { seedChanges } from './demo/changes';
import { seedFieldService } from './demo/field';
import { seedKnowledge } from './demo/knowledge';
import { seedKnownErrors } from './demo/known-errors';
import { seedSurveys } from './demo/surveys';
import { seedIntegrationRows, seedIntegrationEvents } from './demo/integrations';
import { seedExtras, cleanupNotifications } from './demo/extras';

/**
 * Realistic demonstration dataset for the MSP platform. Loaded once on first
 * start (SEED_DEMO_DATA=true) after the defaults and the administrator exist;
 * `seed.ts` guards on "no customers yet". Deterministic: a fixed PRNG seed is
 * used for every random decision, so re-runs on a fresh database produce the
 * same dataset relative to the run date.
 */
export async function loadDemoData() {
  const startedAt = Date.now();
  const now = new Date();
  now.setSeconds(0, 0);
  const state: DemoState = {
    now,
    seedStartedAt: new Date(startedAt),
    rng: new Rng(20260401),
    refs: await withSystem(loadRefs),
    admin: null as never,
    users: new Map(),
    principals: new Map(),
    customers: [],
    services: new Map(),
    counts: {},
    tickets: new Map(),
    visits: [],
    articles: new Map(),
    integrations: new Map(),
  };
  const adminId = await withSystem((tx) => findAdminUserId(tx, config.ADMIN_EMAIL));
  invalidatePrincipal(adminId);
  const admin = await loadPrincipal(adminId);
  if (!admin) throw new Error('administrator principal could not be loaded');
  state.admin = admin;
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const phase = async (name: string, fn: () => Promise<void>) => {
    const t = Date.now();
    try {
      await fn();
      logger.info({ phase: name, ms: Date.now() - t }, 'demo seed phase complete');
    } catch (err) {
      logger.error({ err, phase: name }, 'demo seed phase failed');
      throw err;
    }
  };

  // Foundation: one transaction so a failure leaves nothing behind.
  await phase('foundation (users, customers, services, contracts)', () =>
    withSystem(async (tx) => {
      await seedUsers(state, tx, passwordHash);
      await seedCustomers(state, tx, passwordHash);
      await seedServices(state, tx);
      await seedContracts(state, tx);
      await seedIntegrationRows(state, tx);
    }),
  );
  // Principals for every demo actor (visibility is computed from the committed role/team/access rows).
  await phase('principals', async () => {
    for (const u of state.users.values()) {
      invalidatePrincipal(u.id);
      const p = await loadPrincipal(u.id);
      if (!p) throw new Error(`principal for ${u.email} could not be loaded`);
      state.principals.set(u.key, p);
    }
    for (const c of state.customers) {
      for (const pu of c.portalUsers) {
        invalidatePrincipal(pu.id);
        const p = await loadPrincipal(pu.id);
        if (!p) throw new Error(`principal for ${pu.email} could not be loaded`);
        state.principals.set(`portal:${pu.id}`, p);
      }
    }
  });
  await phase('inventory (assets, CIs, relationships)', () => withSystem((tx) => seedInventory(state, tx)));
  await phase('tickets', () => seedTickets(state));
  await phase('change management (blackouts, risk, CAB)', () => withSystem((tx) => seedChanges(state, tx)));
  await phase('field service (visits, PM)', () => withSystem((tx) => seedFieldService(state, tx)));
  await phase('knowledge', () => withSystem((tx) => seedKnowledge(state, tx)));
  await phase('known errors', () => withSystem((tx) => seedKnownErrors(state, tx)));
  await phase('surveys', () => withSystem((tx) => seedSurveys(state, tx)));
  await phase('integration events, discovery', () => withSystem((tx) => seedIntegrationEvents(state, tx)));
  await phase('reports, notifications, saved views', () =>
    withSystem(async (tx) => {
      await cleanupNotifications(state, tx);
      await seedExtras(state, tx);
    }),
  );
  await phase('metric rollups', async () => {
    const { backfillRollups } = await import('@/jobs/processors/metrics');
    const from = new Date(now.getTime() - 121 * 86_400_000).toISOString().slice(0, 10);
    await backfillRollups(from, now.toISOString().slice(0, 10));
    const [{ n }] = await withSystem(async (tx) => tx.select({ n: schema.metricRollupsDaily.id }).from(schema.metricRollupsDaily).limit(1).then((rows) => [{ n: rows.length }]));
    state.counts.rollupDays = n ? 122 : 0;
  });

  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  logger.info({ ...state.counts, seconds, demoPassword: DEMO_PASSWORD }, 'demo dataset summary');
  return { counts: state.counts, seconds };
}
