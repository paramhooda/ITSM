import type { FastifyInstance } from 'fastify';

/**
 * Module registry. Each module exposes `routes(app)` and owns its own
 * directory (service, schemas, routes). Add new modules here.
 */
export async function registerModules(app: FastifyInstance) {
  const mods = await Promise.all([
    import('./auth/routes'),
    import('./iam/routes'),
    import('./config/routes'),
    import('./customers/routes'),
    import('./services/routes'),
    import('./contracts/routes'),
    import('./sla/routes'),
    import('./tickets/routes'),
    import('./catalog/routes'),
    import('./assets/routes'),
    import('./cmdb/routes'),
    import('./discovery/routes'),
    import('./integrations/routes'),
    import('./field/routes'),
    import('./pm/routes'),
    import('./knowledge/routes'),
    import('./reports/routes'),
    import('./dashboards/routes'),
    import('./search/routes'),
    import('./notifications/routes'),
    import('./attachments/routes'),
    import('./audit/routes'),
    import('./ai/routes'),
    import('./oncall/routes'),
    import('./status/routes'),
    import('./changes/routes'),
    import('./handover/routes'),
    import('./briefings/routes'),
    import('./known-errors/routes'),
    import('./portal/routes'),
  ]);
  for (const m of mods) await app.register(m.default);
}
