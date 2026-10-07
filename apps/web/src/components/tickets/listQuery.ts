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
import { TICKET_LIST_OPEN_CATEGORIES } from '@itsm/shared';

export const TICKET_LIST_DEFAULTS: Record<string, string> = { statusCategory: TICKET_LIST_OPEN_CATEGORIES, sort: 'lastActivityAt', order: 'desc' };

/** Keys copied to the API as they are when set (comma lists included). */
const PASS_THROUGH = ['customerId', 'priorityId', 'teamId', 'serviceId', 'scopeStatus', 'slaState', 'breachRisk', 'sentiment', 'createdFrom', 'createdTo', 'resolvedFrom', 'resolvedTo', 'domain', 'categoryId', 'securitySeverityId', 'statusId', 'changeType', 'riskLevel', 'scheduledFrom', 'scheduledTo', 'csat'] as const;

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
