/**
 * The ticket list page's URL state → API parameters. The helpers live in the
 * shared package (`packages/shared/src/listQuery.ts`) so the API's briefing
 * doors and the guard test (`apps/api/test/dashboards-consistency.test.ts`)
 * count with exactly the recipe the pages use; this file keeps the web's
 * import path (named re-exports, nothing of its own).
 */
export { TICKET_LIST_DEFAULTS, PASS_THROUGH, toStatsParams, listStateForLink, statsParamsForLink, PORTAL_LIST_DEFAULTS, PORTAL_TICKET_TYPES, PORTAL_RATE_CATEGORIES, toPortalParams, portalStateForLink, portalParamsForLink } from '@itsm/shared';
export type { ListState } from '@itsm/shared';
