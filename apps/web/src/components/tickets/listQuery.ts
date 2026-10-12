/**
 * The ticket list page's URL state → `GET /tickets` and `GET /tickets/stats`
 * parameters. Kept free of `@/` imports so the API guard test
 * (`apps/api/test/dashboards-consistency.test.ts`) can import it the way
 * `navigation.test.ts` imports the navigator: a dashboard link is parsed with
 * `statsParamsForLink` and counted with the list's own predicates, so every
 * number that links reproduces itself on the list it opens.
 *
 * URL keys are the page's own: `type` (tab), `statusCategory` (comma list,
 * `any` lifts the filter), `assignee` (`me`, `unassigned`, `watching` or a
 * user id), the filter pills by their API name, and the date ranges.
 */
import { TICKET_LIST_OPEN_CATEGORIES, PORTAL_TICKET_LINK_KEYS } from '@itsm/shared';

export const TICKET_LIST_DEFAULTS: Record<string, string> = { statusCategory: TICKET_LIST_OPEN_CATEGORIES, sort: 'lastActivityAt', order: 'desc' };

/** Keys copied to the API as they are when set (comma lists included). */
const PASS_THROUGH = ['customerId', 'priorityId', 'teamId', 'serviceId', 'siteId', 'scopeStatus', 'slaState', 'breachRisk', 'sentiment', 'createdFrom', 'createdTo', 'resolvedFrom', 'resolvedTo', 'domain', 'categoryId', 'securitySeverityId', 'statusId', 'changeType', 'riskLevel', 'scheduledFrom', 'scheduledTo', 'csat'] as const;

export type ListState = Record<string, string | undefined>;

/** The filter parameters (no paging or sort) for a page state; the stats query uses exactly these. */
export function toStatsParams(state: ListState): Record<string, string> {
  const p: Record<string, string> = {};
  if (state.q) p.q = state.q;
  if (state.type && state.type !== 'all') p.type = state.type;
  if (state.statusCategory && state.statusCategory !== 'any') p.statusCategory = state.statusCategory;
  for (const k of PASS_THROUGH) if (state[k]) p[k] = state[k]!;
  if (state.isMajor === 'true') p.isMajor = 'true';
  if (state.knownError === 'true') p.knownError = 'true';
  const assignee = state.assignee ?? '';
  if (assignee === 'me') p.mine = 'true';
  else if (assignee === 'unassigned') p.unassigned = 'true';
  else if (assignee === 'watching') p.watching = 'true';
  else if (assignee) p.assigneeId = assignee;
  return p;
}

/** The page state a `/tickets?…` link (or bare query string) opens: the defaults, then the link's keys. */
export function listStateForLink(href: string): ListState {
  const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : href.startsWith('/') ? '' : href;
  const state: ListState = { ...TICKET_LIST_DEFAULTS };
  new URLSearchParams(query).forEach((v, k) => {
    state[k] = v;
  });
  return state;
}

/** The stats/count parameters a link resolves to once the page has applied its defaults. */
export const statsParamsForLink = (href: string): Record<string, string> => toStatsParams(listStateForLink(href));

// ---------------------------------------------------------------- the customer portal list

/** The portal ticket list's defaults: the organisation's open tickets, newest activity first, 25 a page. */
export const PORTAL_LIST_DEFAULTS: Record<string, string> = { statusCategory: TICKET_LIST_OPEN_CATEGORIES, sort: 'lastActivityAt', order: 'desc', pageSize: '25' };
/** The types the portal list's pills name and its route accepts (every type the organisation can see, so the All pill is the sum of the pills); any other `type` in a link is not a condition the page can apply, so it is dropped. */
export const PORTAL_TICKET_TYPES = ['incident', 'request', 'problem', 'change'] as const;
/** The statuses a ticket can be rated in: `csat=pending` on its own is the To rate door, so these categories stand in when a link carries no status key. */
export const PORTAL_RATE_CATEGORIES = 'resolved,closed';

/**
 * The portal page state → `GET /portal/tickets` and `GET /portal/tickets/stats`
 * parameters: the portal-safe link keys (`PORTAL_TICKET_LINK_KEYS`) plus `q`,
 * `type` and `mine` (raised by me, a scope like a filter pill). Unlike the
 * staff list, `statusCategory=any` is carried: the portal API applies the open
 * categories when no status key is given, so "Any status" must say so.
 */
export function toPortalParams(state: ListState): Record<string, string> {
  const p: Record<string, string> = {};
  if (state.q) p.q = state.q;
  // The All pill is no filter, and a type outside the portal's four is not sent: the route would refuse it.
  if (state.type && (PORTAL_TICKET_TYPES as readonly string[]).includes(state.type)) p.type = state.type;
  for (const k of PORTAL_TICKET_LINK_KEYS) if (k !== 'type' && state[k]) p[k] = state[k]!;
  if (state.mine === 'true') p.mine = 'true';
  return p;
}

/**
 * The page state a `/portal/tickets?…` link (or bare query string) opens: the
 * portal defaults, then the link's keys. `csat=pending` without a status key is
 * the To rate door (the page rewrites the URL the same way on arrival, and the
 * portal API applies the same categories), so the defaults' open categories
 * never hide the tickets still to rate.
 */
export function portalStateForLink(href: string): ListState {
  const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : href.startsWith('/') ? '' : href;
  const state: ListState = { ...PORTAL_LIST_DEFAULTS };
  const link = new URLSearchParams(query);
  link.forEach((v, k) => {
    state[k] = v;
  });
  if (link.get('csat') === 'pending' && !link.has('statusCategory') && !link.has('statusId')) state.statusCategory = PORTAL_RATE_CATEGORIES;
  return state;
}

/** The portal stats/count parameters a link resolves to once the page has applied its defaults. */
export const portalParamsForLink = (href: string): Record<string, string> => toPortalParams(portalStateForLink(href));
