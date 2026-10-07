import type { ComponentType } from 'react';
import type { Permission } from '@itsm/shared';

/**
 * The dashboards the product ships, and the extension point for custom ones.
 *
 * A dashboard is a page of its own: a route, a label, the permission that opens
 * it and the page component (loaded lazily by `routes.tsx`). Every dashboard
 * page renders inside `DashboardFrame`, which owns the interactive filters
 * (period, customer scope and, where the dashboard asks for it, a team), the
 * scope line and the module strip, so every dashboard filters the same way.
 *
 * Adding a dashboard (a custom one later, backed by a `user_dashboards` model
 * described in docs/DESIGN.md) means one entry here, one route in
 * `routes.tsx`, one page in `packages/shared/src/appmap.ts`, one child under
 * Dashboards in `layouts/nav.ts` and one entry in `DASHBOARD_MODULES`
 * (`layouts/modules.ts`); `apps/api/test/navigation.test.ts` and
 * `apps/api/test/ai-appmap.test.ts` hold the five in step. This file stays
 * free of React and `@/` runtime imports beyond the lazy page loaders so the
 * list can be read anywhere.
 */
export interface DashboardDefinition {
  /** Stable key (`overview`, `noc`, `soc`, `amc`, `my-work`, or a custom dashboard's slug). */
  key: string;
  route: string;
  label: string;
  /** Any of these permissions opens the dashboard; none means every staff member. */
  perm?: Permission[];
  /** The page component, loaded on first visit. */
  component: () => Promise<{ default: ComponentType }>;
}

export const DASHBOARDS: readonly DashboardDefinition[] = [
  { key: 'overview', route: '/', label: 'Overview', component: () => import('@/pages/dashboards/DashboardPage') },
  { key: 'noc', route: '/dashboards/noc', label: 'Network operations', perm: ['dashboards:noc'], component: () => import('@/pages/dashboards/NocDashboardPage') },
  { key: 'soc', route: '/dashboards/soc', label: 'Security operations', perm: ['dashboards:soc'], component: () => import('@/pages/dashboards/SocDashboardPage') },
  { key: 'amc', route: '/dashboards/amc', label: 'AMC & field service', perm: ['dashboards:amc'], component: () => import('@/pages/dashboards/AmcDashboardPage') },
  { key: 'my-work', route: '/dashboards/my-work', label: 'My work', component: () => import('@/pages/dashboards/MyWorkPage') },
  // Custom dashboards append here.
];

/** A registered dashboard by key; throws for an unknown key so a typo fails at startup, not in a user's browser. */
export function dashboard(key: string): DashboardDefinition {
  const hit = DASHBOARDS.find((d) => d.key === key);
  if (!hit) throw new Error(`Unknown dashboard "${key}"`);
  return hit;
}
